import test from 'node:test';
import assert from 'node:assert/strict';

import {
    deleteFile,
    onRequest as deleteRoute,
} from '../functions/api/manage/delete/[[path]].js';
import {
    FILE_CACHE_CONTROL,
    resolveFileCacheControl,
} from '../functions/file/fileTools.js';
import {
    applyTelegramUploadIdentity,
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

async function withRuntimeStubs(fetchImpl, callback) {
    const originalFetch = globalThis.fetch;
    const originalCaches = globalThis.caches;
    globalThis.fetch = fetchImpl;
    globalThis.caches = {
        default: {
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

test('fresh Telegram delete failure keeps metadata for a safe retry', async () => {
    const fileId = 'nav-notes/user-a/fresh.png';
    const env = makeEnv(fileId, {
        Channel: 'TelegramNew',
        ChannelName: 'Telegram_env',
        TgFileId: 'file-id',
        TgMessageId: 88,
        TgChatId: '-100123',
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

test('Telegram deleteMessage success removes metadata and reports source deletion', async () => {
    const fileId = 'nav-notes/user-a/deleted.png';
    const env = makeEnv(fileId, {
        Channel: 'TelegramNew',
        ChannelName: 'Telegram_env',
        TgFileId: 'file-id',
        TgMessageId: 123,
        TgChatId: '-100456',
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
