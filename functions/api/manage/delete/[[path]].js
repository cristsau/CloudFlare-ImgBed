import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { purgeCFCache, purgeRandomFileListCache, purgePublicFileListCache } from "../../../utils/purgeCache.js";
import { removeFileFromIndex, batchRemoveFilesFromIndex } from "../../../utils/indexManager.js";
import { getDatabase } from '../../../utils/databaseAdapter.js';
import { DiscordAPI } from '../../../utils/storage/discordAPI.js';
import { HuggingFaceAPI } from '../../../utils/storage/huggingfaceAPI.js';
import { TelegramAPI } from '../../../utils/storage/telegramAPI.js';
import { WebDAVAPI } from '../../../utils/storage/webdavAPI.js';
import {
    resolveDiscordCredentials,
    resolveHuggingFaceCredentials,
    resolveS3Credentials,
    resolveTelegramCredentials,
    resolveWebDAVCredentials,
} from '../../../utils/metadata/channelCredentials.js';
import { isPathAllowedForToken, normalizeResourcePath } from '../../../utils/auth/tokenPolicy.js';
import { isMissingStoredFile } from '../../../utils/deletePolicy.js';

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
    const { request, env, params, waitUntil } = context;

    const url = new URL(request.url);
    const requestPolicyError = validateDeleteRequestPolicy(context, url);
    if (requestPolicyError) return requestPolicyError;

    // 读取folder参数，判断是否为文件夹删除请求
    const folder = url.searchParams.get('folder');
    if (folder === 'true') {
        try {
            const folderPath = resolveDeletePath(params.path);
            // 使用队列存储需要处理的文件夹
            const folderQueue = [{
                path: folderPath
            }];

            const deletedFiles = [];
            const failedFiles = [];
            const detachedFiles = [];

            while (folderQueue.length > 0) {
                const currentFolder = folderQueue.shift();

                // 获取指定目录下的所有文件
                const listUrl = new URL('/api/manage/list', url.origin);
                listUrl.searchParams.set('count', '-1');
                listUrl.searchParams.set('dir', currentFolder.path);
                const listRequest = new Request(listUrl, {
                    headers: request.headers,
                });
                const listResponse = await fetch(listRequest);
                const listData = await listResponse.json();

                const files = listData.files;

                // 处理当前文件夹下的所有文件
                for (const file of files) {
                    const fileId = file.name;
                    if (!canTokenAccessDeletePath(context, fileId)) {
                        failedFiles.push(fileId);
                        continue;
                    }
                    const cdnUrl = `https://${url.hostname}/file/${fileId}`;

                    const result = await deleteFile(env, fileId, cdnUrl, url);
                    if (result.success) {
                        deletedFiles.push(fileId);
                        if (result.detached) {
                            detachedFiles.push({
                                fileId,
                                sourceDeleted: false,
                                legacy: result.legacy === true,
                            });
                        }
                    } else {
                        failedFiles.push(fileId);
                    }
                }

                // 将子文件夹添加到队列
                const directories = listData.directories;
                for (const dir of directories) {
                    if (!canTokenAccessDeletePath(context, dir)) {
                        continue;
                    }
                    folderQueue.push({
                        path: dir
                    });
                }
            }

            // 批量从索引中删除文件
            if (deletedFiles.length > 0) {
                waitUntil(batchRemoveFilesFromIndex(context, deletedFiles));
            }

            return new Response(JSON.stringify({
                success: failedFiles.length === 0,
                deleted: deletedFiles,
                failed: failedFiles,
                detached: detachedFiles,
            }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });

        } catch (e) {
            return new Response(JSON.stringify({
                success: false,
                error: e.message
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }
    }

    // 单个文件删除处理
    try {
        const fileId = resolveDeletePath(params.path);
        const cdnUrl = `https://${url.hostname}/file/${fileId}`;

        const result = await deleteFile(env, fileId, cdnUrl, url);
        if (!result.success) {
            throw new Error('Delete file failed');
        } else {
            // 从索引中删除文件
            waitUntil(removeFileFromIndex(context, fileId));
        }

        return new Response(JSON.stringify({
            success: true,
            fileId: fileId,
            sourceDeleted: result.sourceDeleted === true,
            detached: result.detached === true,
            legacy: result.legacy === true,
            alreadyMissing: result.alreadyMissing === true,
        }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    } catch (e) {
        return new Response(JSON.stringify({
            success: false,
            error: e.message
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}

export function resolveDeletePath(pathParam) {
    const rawPath = Array.isArray(pathParam)
        ? pathParam.join('/')
        : String(pathParam || '').split(',').join('/');
    return normalizeResourcePath(rawPath);
}

export function validateDeleteRequestPolicy(context, url) {
    const auth = context.data?.auth;
    if (!auth?.authorized) {
        return new Response('Unauthorized', { status: 401 });
    }

    const isApiToken = auth.credentialType === 'apiToken';
    if (isApiToken && context.request.method !== 'DELETE') {
        return new Response('Method not allowed', {
            status: 405,
            headers: { 'Allow': 'DELETE, OPTIONS', 'Cache-Control': 'no-store' },
        });
    }

    if (!isApiToken && !['GET', 'DELETE'].includes(context.request.method)) {
        return new Response('Method not allowed', {
            status: 405,
            headers: { 'Allow': 'GET, DELETE, OPTIONS', 'Cache-Control': 'no-store' },
        });
    }

    if (isApiToken && url.searchParams.get('folder') === 'true') {
        const canDeleteFolder = auth.token.permissions.includes('manage')
            && auth.token.allowFolderDelete === true;
        if (!canDeleteFolder) {
            return new Response('Forbidden: token cannot delete folders', { status: 403 });
        }
    }

    if (isApiToken) {
        try {
            const fileId = resolveDeletePath(context.params?.path);
            if (!isPathAllowedForToken(auth.token, fileId)) {
                throw new TypeError('Path outside token scope');
            }
        } catch {
            return new Response('Forbidden: invalid or unauthorized delete path', { status: 403 });
        }
    }

    return null;
}

function canTokenAccessDeletePath(context, fileId) {
    const auth = context.data?.auth;
    if (auth?.credentialType !== 'apiToken') return true;

    try {
        return isPathAllowedForToken(auth.token, resolveDeletePath(fileId));
    } catch {
        return false;
    }
}

const TELEGRAM_DELETE_WINDOW_MS = 48 * 60 * 60 * 1000;

// 删除单个文件的核心函数。源存储删除必须先成功；除明确标记的
// legacy/detach 情况外，任何 provider 失败都不得删除数据库记录。
export async function deleteFile(env, fileId, cdnUrl, url, dependencies = {}) {
    try {
        // 读取图片信息
        const db = getDatabase(env);
        const img = await db.getWithMetadata(fileId);

        // 如果文件记录不存在，直接返回成功（幂等删除）
        if (isMissingStoredFile(img)) {
            console.warn(`File ${fileId} not found in database, skipping delete`);
            return {
                success: true,
                sourceDeleted: false,
                detached: false,
                legacy: false,
                alreadyMissing: true,
            };
        }

        const deleteStoredSource = dependencies.deleteStoredSource || deleteSourceFile;
        const sourceResult = await deleteStoredSource(env, img, fileId);
        if (!sourceResult.success) {
            return sourceResult;
        }

        // 删除数据库中的记录
        // 注意：容量统计现在由索引自动维护，删除文件后索引更新时会自动重新计算
        await db.delete(fileId);

        // 清除CDN缓存
        await purgeCFCache(env, cdnUrl);

        // 清除 api/randomFileList 等API缓存
        const normalizedFolder = fileId.split('/').slice(0, -1).join('/');
        await purgeRandomFileListCache(url.origin, normalizedFolder);
        await purgePublicFileListCache(url.origin, normalizedFolder);

        return {
            success: true,
            sourceDeleted: sourceResult.sourceDeleted === true,
            detached: sourceResult.detached === true,
            legacy: sourceResult.legacy === true,
            alreadyMissing: false,
        };
    } catch (e) {
        console.error('Delete file failed:', e);
        return deleteFailure();
    }
}

// 按存储渠道删除源对象。返回值区分“真实删除”和“仅解除图床引用”，
// 防止 provider 失败被误报为成功。
export async function deleteSourceFile(env, img, fileId) {
    const channel = img.metadata?.Channel;

    if (channel === 'CloudflareR2') {
        if (!env.img_r2 || typeof env.img_r2.delete !== 'function') {
            return deleteFailure();
        }
        await env.img_r2.delete(fileId);
        return sourceDeleted();
    }

    if (channel === 'S3') {
        return (await deleteS3File(env, img)) ? sourceDeleted() : deleteFailure();
    }

    if (channel === 'Discord') {
        return (await deleteDiscordFile(env, img)) ? sourceDeleted() : deleteFailure();
    }

    if (channel === 'HuggingFace') {
        return (await deleteHuggingFaceFile(env, img)) ? sourceDeleted() : deleteFailure();
    }

    if (channel === 'WebDAV') {
        return (await deleteWebDAVFile(env, img)) ? sourceDeleted() : deleteFailure();
    }

    if (channel === 'Telegram' || channel === 'TelegramNew') {
        return await deleteTelegramFile(env, img);
    }

    // External and pre-channel Telegraph records never represented an object
    // owned by this deployment. Removing their registry entry is explicit
    // detach-only behavior, not a claim that the remote source was deleted.
    if (channel === 'External') {
        return detachedSource(false);
    }
    if (channel === undefined || channel === null || channel === '') {
        return detachedSource(true);
    }

    console.error('Delete refused for unsupported storage channel:', channel);
    return deleteFailure();
}

async function deleteTelegramFile(env, img) {
    const { messageIds, hasMissingMessageIds } = getTelegramMessageIds(img);

    // Records created before TgMessageId support cannot be mapped back to a
    // Telegram message. Preserve legacy delete compatibility, but report that
    // this is detach-only and never claim physical source deletion.
    if (messageIds.length === 0) {
        return detachedSource(true);
    }

    const db = getDatabase(env);
    const credentials = await resolveTelegramCredentials(db, env, img.metadata);
    if (!credentials.botToken || !credentials.chatId) {
        console.error('Telegram delete refused: channel credentials are unavailable');
        return deleteFailure();
    }

    const telegramAPI = new TelegramAPI(credentials.botToken, credentials.proxyUrl || '');
    let detachOnly = hasMissingMessageIds;

    for (const messageId of messageIds) {
        const result = await telegramAPI.deleteMessage(credentials.chatId, messageId);
        if (result.deleted) {
            continue;
        }

        // Telegram's Bot API cannot delete messages older than 48 hours. Only
        // that permanent lifecycle limitation may degrade to detach-only;
        // auth, permission, rate-limit and transport failures remain hard
        // failures so the metadata is retained for a safe retry.
        if (result.nonDeletable && isOutsideTelegramDeleteWindow(img.metadata)) {
            detachOnly = true;
            continue;
        }

        return deleteFailure();
    }

    return detachOnly ? detachedSource(true) : sourceDeleted();
}

function getTelegramMessageIds(img) {
    if (img.metadata?.IsChunked !== true) {
        const messageId = normalizeTelegramMessageId(img.metadata?.TgMessageId);
        return {
            messageIds: messageId === null ? [] : [messageId],
            hasMissingMessageIds: messageId === null,
        };
    }

    let chunks = [];
    try {
        chunks = typeof img.value === 'string' ? JSON.parse(img.value) : [];
    } catch {
        chunks = [];
    }

    if (!Array.isArray(chunks) || chunks.length === 0) {
        return { messageIds: [], hasMissingMessageIds: true };
    }

    const normalized = chunks.map((chunk) => normalizeTelegramMessageId(chunk?.messageId));
    return {
        messageIds: [...new Set(normalized.filter((messageId) => messageId !== null))],
        hasMissingMessageIds: normalized.some((messageId) => messageId === null),
    };
}

function normalizeTelegramMessageId(value) {
    const normalized = Number(value);
    return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

function isOutsideTelegramDeleteWindow(metadata = {}) {
    const uploadedAt = Number(metadata.TimeStamp);
    return Number.isFinite(uploadedAt)
        && uploadedAt > 0
        && Date.now() - uploadedAt >= TELEGRAM_DELETE_WINDOW_MS;
}

function sourceDeleted() {
    return {
        success: true,
        sourceDeleted: true,
        detached: false,
        legacy: false,
    };
}

function detachedSource(legacy) {
    return {
        success: true,
        sourceDeleted: false,
        detached: true,
        legacy: legacy === true,
    };
}

function deleteFailure() {
    return {
        success: false,
        sourceDeleted: false,
        detached: false,
        legacy: false,
    };
}

// 删除 S3 渠道的图片
async function deleteS3File(env, img) {
    const db = getDatabase(env);
    const s3Credentials = await resolveS3Credentials(db, env, img.metadata);
    const s3Client = new S3Client({
        region: s3Credentials.region || "auto",
        endpoint: s3Credentials.endpoint,
        credentials: {
            accessKeyId: s3Credentials.accessKeyId,
            secretAccessKey: s3Credentials.secretAccessKey
        },
        forcePathStyle: s3Credentials.pathStyle || false // 是否启用路径风格
    });

    const bucketName = s3Credentials.bucketName;
    const key = s3Credentials.key;

    try {
        await s3Client.send(new DeleteObjectCommand({
            Bucket: bucketName,
            Key: key,
        }));
        return true;
    } catch (error) {
        console.error("S3 Delete Failed:", error);
        return false;
    }
}

// 删除 Discord 渠道的图片（删除 Discord 消息）
async function deleteDiscordFile(env, img) {
    const db = getDatabase(env);
    const discordCredentials = await resolveDiscordCredentials(db, env, img.metadata);
    const botToken = discordCredentials.botToken;
    const channelId = discordCredentials.channelId;
    const messageId = discordCredentials.messageId;

    if (!botToken || !channelId || !messageId) {
        console.warn('Discord file missing required metadata for deletion');
        return false;
    }

    try {
        const discordAPI = new DiscordAPI(botToken);
        const success = await discordAPI.deleteMessage(channelId, messageId);
        if (!success) {
            console.error('Discord Delete Failed: API returned false');
        }
        return success;
    } catch (error) {
        console.error("Discord Delete Failed:", error);
        return false;
    }
}


// 删除 HuggingFace 渠道的图片
async function deleteHuggingFaceFile(env, img) {
    const db = getDatabase(env);
    const hfCredentials = await resolveHuggingFaceCredentials(db, env, img.metadata);
    const token = hfCredentials.token;
    const repo = hfCredentials.repo;
    const filePath = hfCredentials.filePath;
    const isPrivate = hfCredentials.isPrivate || false;

    if (!token || !repo || !filePath) {
        console.warn('HuggingFace file missing required metadata for deletion');
        return false;
    }

    try {
        const huggingfaceAPI = new HuggingFaceAPI(token, repo, isPrivate);
        const success = await huggingfaceAPI.deleteFile(filePath, `Delete ${filePath}`);
        if (!success) {
            // A previous attempt may have deleted the source before the KV
            // mutation failed. Only a verified 404 is accepted as idempotent.
            const verification = await huggingfaceAPI.getFileContent(filePath);
            if (verification.status === 404) {
                return true;
            }
            console.error('HuggingFace Delete Failed: API returned false');
        }
        return success;
    } catch (error) {
        console.error("HuggingFace Delete Failed:", error);
        return false;
    }
}


// 删除 WebDAV 渠道的图片
async function deleteWebDAVFile(env, img) {
    const filePath = img.metadata?.WebDAVFilePath;

    if (!filePath) {
        console.warn('WebDAV file missing required metadata for deletion');
        return false;
    }

    try {
        const db = getDatabase(env);
        const webdavCredentials = await resolveWebDAVCredentials(db, env, img.metadata);
        if (!webdavCredentials.baseUrl) {
            console.warn('WebDAV channel config not found for deletion');
            return false;
        }

        const webdavAPI = new WebDAVAPI(webdavCredentials);
        return await webdavAPI.deleteFile(filePath);
    } catch (error) {
        console.error("WebDAV Delete Failed:", error);
        return false;
    }
}
