import test from 'node:test';
import assert from 'node:assert/strict';

import {
    deleteFile,
    onRequest as deleteRoute,
} from '../functions/api/manage/delete/[[path]].js';
import {
    buildExternalRedirectResponse,
    FILE_CACHE_CONTROL,
    resolveFileCacheControl,
} from '../functions/file/fileTools.js';
import { purgeCFCache } from '../functions/utils/purgeCache.js';
import {
    applyTelegramUploadIdentity,
    TELEGRAM_DELETE_CAPABILITY,
    TelegramAPI,
} from '../functions/utils/storage/telegramAPI.js';

class MemoryKV {
    constructor() {
        this.records = new Map();
        this.events = [];
    }

    async get(key) {
        return this.records.get(key)?.value ?? null;
    }

    async put(key, value, options = {}) {
        this.records.set(key, {
            value,
            metadata: options.metadata ?? null,
        });
    }

    async delete(key) {
        this.events.push(`db-delete:${key}`);
        this.records.delete(key);
    }

    async getWithMetadata(key) {
        return this.records.get(key) ?? { value: null, metadata: null };
    }

    async list() {
        return { keys: [], list_complete: true };
    }
}

function makeEnv(fileId, metadata, value = '') {
    const img_url = new MemoryKV();
    img_url.records.set(fileId, { value, metadata });
    return { img_url };
}

async function withRuntimeStubs(fetchImpl, callback, options = {}) {
    const originalFetch = globalThis.fetch;
    const originalCaches = globalThis.caches;
    globalThis.fetch = fetchImpl;
    globalThis.caches = {
        default: {
            delete: options.cacheDelete || (async () => false),
            put: async () => {},
        },
    };
    try {
        return await callback();
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.caches = originalCaches;
    }
}

test('Telegram upload metadata persists the owning message and chat ids', () => {
    const telegram = new TelegramAPI('test-token');
    const fileInfo = telegram.getFileInfo({
        ok: true,
        result: {
            message_id: 321,
            document: {
                file_id: 'file-id',
                file_unique_id: 'unique-id',
                file_size: 100,
            },
        },
    });

    const metadata = applyTelegramUploadIdentity({}, fileInfo, '-100123');
    assert.deepEqual(metadata, {
        TgFileId: 'file-id',
        TgMessageId: 321,
        TgChatId: '-100123',
        DeleteCapability: TELEGRAM_DELETE_CAPABILITY,
    });
});

test('nav-notes file responses are no-store without widening to sibling prefixes', () => {
    assert.equal(
        resolveFileCacheControl('nav-notes/user-a/file.png', FILE_CACHE_CONTROL.PUBLIC),
        FILE_CACHE_CONTROL.NO_STORE
    );
    assert.equal(
        resolveFileCacheControl('/nav-notes/user-a/file.png', FILE_CACHE_CONTROL.PUBLIC),
        FILE_CACHE_CONTROL.NO_STORE
    );
    assert.equal(
        resolveFileCacheControl('nav-notes-evil/user-a/file.png', FILE_CACHE_CONTROL.PUBLIC),
        FILE_CACHE_CONTROL.PUBLIC
    );
});

test('nav-notes external redirects cannot bypass no-store', () => {
    const response = buildExternalRedirectResponse(
        'https://cdn.example/file.png',
        'nav-notes/user-a/external.png',
        FILE_CACHE_CONTROL.PUBLIC
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), 'https://cdn.example/file.png');
    assert.equal(response.headers.get('Cache-Control'), FILE_CACHE_CONTROL.NO_STORE);
});

test('unconfigured Cloudflare purge reports exact local cache invalidation transparently', async () => {
    const env = { img_url: new MemoryKV() };
    const cdnUrl = 'https://pic.example/file/nav-notes/user-a/local.png';
    let deletedUrl = null;

    await withRuntimeStubs(async () => {
        throw new Error('Cloudflare API must not be called when purge is unconfigured');
    }, async () => {
        const result = await purgeCFCache(env, cdnUrl);
        assert.equal(result.cachePurgeConfigured, false);
        assert.equal(result.cachePurgeAttempted, false);
        assert.equal(result.cachePurgeSucceeded, false);
        assert.equal(result.localCacheInvalidated, true);
        assert.equal(result.cacheInvalidated, true);
        assert.equal(deletedUrl, cdnUrl);
    }, {
        cacheDelete: async (request) => {
            deletedUrl = request.url;
            return true;
        },
    });
});

test('Cloudflare API 500 is not reported as a successful purge', async () => {
    const env = { img_url: new MemoryKV() };
    await env.img_url.put('manage@sysConfig@others', JSON.stringify({
        cloudflareApiToken: {
            CF_ZONE_ID: 'test-zone',
            CF_EMAIL: 'test@example.invalid',
            CF_API_KEY: 'test-key',
        },
    }));

    await withRuntimeStubs(async () => new Response(JSON.stringify({ success: false }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
    }), async () => {
        const result = await purgeCFCache(
            env,
            'https://pic.example/file/nav-notes/user-a/api-500.png'
        );
        assert.equal(result.cachePurgeConfigured, true);
        assert.equal(result.cachePurgeAttempted, true);
        assert.equal(result.cachePurgeSucceeded, false);
        assert.equal(result.localCacheInvalidated, false);
        assert.equal(result.cacheInvalidated, false);
    });
});

test('provider failure preserves the registry record and cannot report success', async () => {
    const fileId = 'nav-notes/user-a/provider-failure.png';
    const env = makeEnv(fileId, { Channel: 'S3' });
    const events = [];

    const result = await deleteFile(
        env,
        fileId,
        `https://pic.example/file/${fileId}`,
        new URL('https://pic.example'),
        {
            deleteStoredSource: async () => {
                events.push('provider-delete');
                return {
                    success: false,
                    sourceDeleted: false,
                    detached: false,
                    legacy: false,
                };
            },
        }
    );

    assert.deepEqual(events, ['provider-delete']);
    assert.equal(result.success, false);
    assert.notEqual((await env.img_url.getWithMetadata(fileId)).metadata, null);
    assert.deepEqual(env.img_url.events, []);
});

test('already-missing deletion still invalidates the exact cached URL', async () => {
    const fileId = 'nav-notes/user-a/already-missing.png';
    const env = { img_url: new MemoryKV() };
    const cdnUrl = `https://pic.example/file/${fileId}`;
    let deletedUrl = null;

    await withRuntimeStubs(async () => {
        throw new Error('Cloudflare API must not be called when purge is unconfigured');
    }, async () => {
        const result = await deleteFile(env, fileId, cdnUrl, new URL('https://pic.example'));
        assert.equal(result.success, true);
        assert.equal(result.alreadyMissing, true);
        assert.equal(result.cachePurgeConfigured, false);
        assert.equal(result.localCacheInvalidated, true);
        assert.equal(result.cacheInvalidated, true);
        assert.equal(deletedUrl, cdnUrl);
    }, {
        cacheDelete: async (request) => {
            deletedUrl = request.url;
            return true;
        },
    });
});

test('single-file provider failure is generic and keeps the registry record', async () => {
    const fileId = 'nav-notes/user-a/r2-failure.png';
    const env = makeEnv(fileId, { Channel: 'CloudflareR2' });
    const requestUrl = `https://pic.example/api/manage/delete/${fileId}`;
    const response = await deleteRoute({
        env,
        request: new Request(requestUrl, { method: 'DELETE' }),
        params: { path: fileId },
        waitUntil: () => {},
        data: {
            auth: {
                authorized: true,
                credentialType: 'adminSession',
            },
        },
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
        success: false,
        error: 'Delete file failed',
    });
    assert.notEqual((await env.img_url.getWithMetadata(fileId)).metadata, null);
});

test('registry deletion happens only after the provider confirms deletion', async () => {
    const fileId = 'nav-notes/user-a/provider-success.png';
    const env = makeEnv(fileId, { Channel: 'S3' });
    const events = [];
    const originalDelete = env.img_url.delete.bind(env.img_url);
    env.img_url.delete = async (key) => {
        events.push('db-delete');
        await originalDelete(key);
    };

    await withRuntimeStubs(async () => new Response('', { status: 500 }), async () => {
        const result = await deleteFile(
            env,
            fileId,
            `https://pic.example/file/${fileId}`,
            new URL('https://pic.example'),
            {
                deleteStoredSource: async () => {
                    events.push('provider-delete');
                    return {
                        success: true,
                        sourceDeleted: true,
                        detached: false,
                        legacy: false,
                    };
                },
            }
        );

        assert.equal(result.success, true);
        assert.equal(result.sourceDeleted, true);
        assert.deepEqual(events, ['provider-delete', 'db-delete']);
        assert.equal((await env.img_url.getWithMetadata(fileId)).metadata, null);
    });
});

test('legacy Telegram records without message_id detach explicitly', async () => {
    const fileId = 'nav-notes/user-a/legacy.png';
    const env = makeEnv(fileId, {
        Channel: 'TelegramNew',
        ChannelName: 'primary',
        TgFileId: 'legacy-file-id',
        TimeStamp: Date.now() - 72 * 60 * 60 * 1000,
    });

    await withRuntimeStubs(async () => new Response('', { status: 500 }), async () => {
        const result = await deleteFile(
            env,
            fileId,
            `https://pic.example/file/${fileId}`,
            new URL('https://pic.example')
        );

        assert.equal(result.success, true);
        assert.equal(result.sourceDeleted, false);
        assert.equal(result.detached, true);
        assert.equal(result.legacy, true);
        assert.equal((await env.img_url.getWithMetadata(fileId)).metadata, null);
    });
});

test('capability-declared Telegram records with a missing message id fail closed', async () => {
    const fileId = 'nav-notes/user-a/corrupt-capability.png';
    const env = makeEnv(fileId, {
        Channel: 'TelegramNew',
        ChannelName: 'Telegram_env',
        TgChatId: '-100123',
        DeleteCapability: TELEGRAM_DELETE_CAPABILITY,
        TimeStamp: Date.now() - 72 * 60 * 60 * 1000,
    });

    const result = await deleteFile(
        env,
        fileId,
        `https://pic.example/file/${fileId}`,
        new URL('https://pic.example')
    );
    assert.equal(result.success, false);
    assert.notEqual((await env.img_url.getWithMetadata(fileId)).metadata, null);
});

test('fresh Telegram records without capability or message id are not misclassified as legacy', async () => {
    const fileId = 'nav-notes/user-a/fresh-corrupt.png';
    const env = makeEnv(fileId, {
        Channel: 'TelegramNew',
        ChannelName: 'Telegram_env',
        TgChatId: '-100123',
        TimeStamp: Date.parse('2026-08-01T08:31:00.000Z'),
    });

    const result = await deleteFile(
        env,
        fileId,
        `https://pic.example/file/${fileId}`,
        new URL('https://pic.example')
    );
    assert.equal(result.success, false);
    assert.notEqual((await env.img_url.getWithMetadata(fileId)).metadata, null);
});

test('Telegram records inside the rollout window remain eligible for legacy detach', async () => {
    const fileId = 'nav-notes/user-a/rollout-window.png';
    const env = makeEnv(fileId, {
        Channel: 'TelegramNew',
        ChannelName: 'Telegram_env',
        TgChatId: '-100123',
        TimeStamp: Date.parse('2026-08-01T08:15:00.000Z'),
    });

    await withRuntimeStubs(async () => new Response('', { status: 500 }), async () => {
        const result = await deleteFile(
            env,
            fileId,
            `https://pic.example/file/${fileId}`,
            new URL('https://pic.example')
        );
        assert.equal(result.success, true);
        assert.equal(result.detached, true);
        assert.equal(result.legacy, true);
        assert.equal((await env.img_url.getWithMetadata(fileId)).metadata, null);
    });
});

test('fresh Telegram delete failure keeps metadata for a safe retry', async () => {
    const fileId = 'nav-notes/user-a/fresh.png';
    const env = makeEnv(fileId, {
        Channel: 'TelegramNew',
        ChannelName: 'Telegram_env',
        TgFileId: 'file-id',
        TgMessageId: 88,
        TgChatId: '-100123',
        DeleteCapability: TELEGRAM_DELETE_CAPABILITY,
        TimeStamp: Date.now(),
    });
    env.TG_BOT_TOKEN = 'test-token';
    env.TG_CHAT_ID = '-100123';

    await withRuntimeStubs(async () => new Response(JSON.stringify({
        ok: false,
        description: "Bad Request: message can't be deleted for everyone",
    }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
    }), async () => {
        const result = await deleteFile(
            env,
            fileId,
            `https://pic.example/file/${fileId}`,
            new URL('https://pic.example')
        );

        assert.equal(result.success, false);
        assert.notEqual((await env.img_url.getWithMetadata(fileId)).metadata, null);
    });
});

test('Telegram 48-hour limit degrades to explicit legacy detach', async () => {
    const fileId = 'nav-notes/user-a/expired.png';
    const env = makeEnv(fileId, {
        Channel: 'TelegramNew',
        ChannelName: 'Telegram_env',
        TgFileId: 'file-id',
        TgMessageId: 99,
        TgChatId: '-100123',
        DeleteCapability: TELEGRAM_DELETE_CAPABILITY,
        TimeStamp: Date.now() - 49 * 60 * 60 * 1000,
    });
    env.TG_BOT_TOKEN = 'test-token';
    env.TG_CHAT_ID = '-100123';

    await withRuntimeStubs(async () => new Response(JSON.stringify({
        ok: false,
        description: "Bad Request: message can't be deleted for everyone",
    }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
    }), async () => {
        const result = await deleteFile(
            env,
            fileId,
            `https://pic.example/file/${fileId}`,
            new URL('https://pic.example')
        );

        assert.equal(result.success, true);
        assert.equal(result.sourceDeleted, false);
        assert.equal(result.detached, true);
        assert.equal(result.legacy, true);
        assert.equal((await env.img_url.getWithMetadata(fileId)).metadata, null);
    });
});

test('Telegram chunk expiry uses each persisted chunk uploadTime', async () => {
    const fileId = 'nav-notes/user-a/expired-chunks.bin';
    const oldChunkTime = Date.now() - 49 * 60 * 60 * 1000;
    const env = makeEnv(fileId, {
        Channel: 'TelegramNew',
        ChannelName: 'Telegram_env',
        TgChatId: '-100123',
        DeleteCapability: TELEGRAM_DELETE_CAPABILITY,
        IsChunked: true,
        TimeStamp: Date.now(),
    }, JSON.stringify([
        { messageId: 201, uploadTime: oldChunkTime },
        { messageId: 202, uploadTime: oldChunkTime },
    ]));
    env.TG_BOT_TOKEN = 'test-token';
    env.TG_CHAT_ID = '-100123';
    let deleteCalls = 0;

    await withRuntimeStubs(async () => {
        deleteCalls++;
        return new Response(JSON.stringify({
            ok: false,
            description: "Bad Request: message can't be deleted for everyone",
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    }, async () => {
        const result = await deleteFile(
            env,
            fileId,
            `https://pic.example/file/${fileId}`,
            new URL('https://pic.example')
        );
        assert.equal(deleteCalls, 2);
        assert.equal(result.success, true);
        assert.equal(result.sourceDeleted, false);
        assert.equal(result.detached, true);
        assert.equal(result.legacy, true);
        assert.equal((await env.img_url.getWithMetadata(fileId)).metadata, null);
    });
});

test('Telegram deleteMessage success removes metadata and reports source deletion', async () => {
    const fileId = 'nav-notes/user-a/deleted.png';
    const env = makeEnv(fileId, {
        Channel: 'TelegramNew',
        ChannelName: 'Telegram_env',
        TgFileId: 'file-id',
        TgMessageId: 123,
        TgChatId: '-100456',
        DeleteCapability: TELEGRAM_DELETE_CAPABILITY,
        TimeStamp: Date.now(),
    });
    env.TG_BOT_TOKEN = 'test-token';
    env.TG_CHAT_ID = '-100999';
    let deleteRequest = null;

    await withRuntimeStubs(async (requestUrl, init = {}) => {
        deleteRequest = {
            url: String(requestUrl),
            body: JSON.parse(init.body),
        };
        return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }, async () => {
        const result = await deleteFile(
            env,
            fileId,
            `https://pic.example/file/${fileId}`,
            new URL('https://pic.example')
        );

        assert.equal(result.success, true);
        assert.equal(result.sourceDeleted, true);
        assert.equal(result.detached, false);
        assert.match(deleteRequest.url, /\/deleteMessage$/);
        assert.deepEqual(deleteRequest.body, {
            chat_id: '-100456',
            message_id: 123,
        });
        assert.equal((await env.img_url.getWithMetadata(fileId)).metadata, null);
    });
});

test('Discord chunk deletion removes every persisted message before deleting metadata', async () => {
    const fileId = 'nav-notes/user-a/discord-chunks.bin';
    const env = makeEnv(fileId, {
        Channel: 'Discord',
        ChannelName: 'Discord_env',
        DiscordChannelId: '12345',
        IsChunked: true,
        TimeStamp: Date.now(),
    }, JSON.stringify([
        { messageId: '1001' },
        { messageId: '1002' },
    ]));
    env.DISCORD_BOT_TOKEN = 'test-token';
    env.DISCORD_CHANNEL_ID = '99999';
    const deleteRequests = [];

    await withRuntimeStubs(async (requestUrl, init = {}) => {
        deleteRequests.push({ url: String(requestUrl), method: init.method });
        return new Response(null, { status: 204 });
    }, async () => {
        const result = await deleteFile(
            env,
            fileId,
            `https://pic.example/file/${fileId}`,
            new URL('https://pic.example')
        );

        assert.equal(result.success, true);
        assert.equal(result.sourceDeleted, true);
        assert.deepEqual(deleteRequests, [
            {
                url: 'https://discord.com/api/v10/channels/12345/messages/1001',
                method: 'DELETE',
            },
            {
                url: 'https://discord.com/api/v10/channels/12345/messages/1002',
                method: 'DELETE',
            },
        ]);
        assert.equal((await env.img_url.getWithMetadata(fileId)).metadata, null);
    });
});

test('Discord partial chunk failure retains metadata and a retry tolerates prior deletion', async () => {
    const fileId = 'nav-notes/user-a/discord-retry.bin';
    const env = makeEnv(fileId, {
        Channel: 'Discord',
        ChannelName: 'Discord_env',
        DiscordChannelId: '12345',
        IsChunked: true,
        TimeStamp: Date.now(),
    }, JSON.stringify([
        { messageId: '2001' },
        { messageId: '2002' },
    ]));
    env.DISCORD_BOT_TOKEN = 'test-token';
    env.DISCORD_CHANNEL_ID = '99999';
    let attempt = 1;
    const deleteRequests = [];

    await withRuntimeStubs(async (requestUrl) => {
        const messageId = String(requestUrl).split('/').pop();
        deleteRequests.push(`${attempt}:${messageId}`);
        if (attempt === 1) {
            return new Response(null, { status: messageId === '2001' ? 204 : 500 });
        }
        return new Response(null, { status: messageId === '2001' ? 404 : 204 });
    }, async () => {
        const firstResult = await deleteFile(
            env,
            fileId,
            `https://pic.example/file/${fileId}`,
            new URL('https://pic.example')
        );
        assert.equal(firstResult.success, false);
        assert.notEqual((await env.img_url.getWithMetadata(fileId)).metadata, null);

        attempt = 2;
        const retryResult = await deleteFile(
            env,
            fileId,
            `https://pic.example/file/${fileId}`,
            new URL('https://pic.example')
        );
        assert.equal(retryResult.success, true);
        assert.equal(retryResult.sourceDeleted, true);
        assert.deepEqual(deleteRequests, [
            '1:2001',
            '1:2002',
            '2:2001',
            '2:2002',
        ]);
        assert.equal((await env.img_url.getWithMetadata(fileId)).metadata, null);
    });
});

test('Discord chunk records with a missing message id fail closed', async () => {
    const fileId = 'nav-notes/user-a/discord-corrupt.bin';
    const env = makeEnv(fileId, {
        Channel: 'Discord',
        ChannelName: 'Discord_env',
        DiscordChannelId: '12345',
        IsChunked: true,
        TimeStamp: Date.now(),
    }, JSON.stringify([
        { messageId: '3001' },
        { size: 42 },
    ]));
    env.DISCORD_BOT_TOKEN = 'test-token';
    env.DISCORD_CHANNEL_ID = '99999';

    const result = await deleteFile(
        env,
        fileId,
        `https://pic.example/file/${fileId}`,
        new URL('https://pic.example')
    );
    assert.equal(result.success, false);
    assert.notEqual((await env.img_url.getWithMetadata(fileId)).metadata, null);
});
