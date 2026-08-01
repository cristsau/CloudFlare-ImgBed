import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isPathAllowedForToken,
    normalizeAllowedPrefixes,
    normalizePermissions,
    normalizeResourcePath,
    publicTokenIdentity,
    requireCanonicalResourcePath,
} from '../functions/utils/auth/tokenPolicy.js';
import { authorizeUploadFolder } from '../functions/utils/auth/uploadPolicy.js';
import { authenticate, AUTH_SCOPE } from '../functions/utils/auth/authCore.js';
import {
    extractDeleteResourcePath,
    extractRequiredPermission,
    onRequest as manageMiddleware,
    validateManageRequestScope,
} from '../functions/api/manage/_middleware.js';
import { isMissingStoredFile } from '../functions/utils/deletePolicy.js';
import { createApiToken } from '../functions/api/manage/apiTokens.js';
import { onRequestPost as adminLogin } from '../functions/api/auth/adminLogin.js';
import { onRequest as listRoute } from '../functions/api/manage/list.js';
import {
    createHuggingFaceUploadGrant,
    deleteHuggingFaceUploadGrant,
    isHuggingFaceDirectUploadAllowed,
    validateHuggingFaceUploadGrant,
} from '../functions/upload/huggingface/uploadGrant.js';

class MemoryKV {
    constructor(entries = {}) {
        this.entries = new Map(Object.entries(entries));
    }

    async get(key) {
        return this.entries.get(key) ?? null;
    }

    async put(key, value) {
        this.entries.set(key, value);
    }

    async delete(key) {
        this.entries.delete(key);
    }

    async getWithMetadata(key) {
        if (!this.entries.has(key)) return { value: null, metadata: null };
        return { value: this.entries.get(key), metadata: null };
    }

    async list() {
        return { keys: [], list_complete: true };
    }
}

function tokenRecord(overrides = {}) {
    return {
        id: 'token-id',
        name: 'NAV test token',
        token: 'imgbed_test_token',
        owner: 'test',
        permissions: ['upload', 'list', 'delete'],
        allowedPrefixes: ['nav-notes/'],
        allowFolderDelete: false,
        type: 'user',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        expiresAt: null,
        autoDelete: false,
        ...overrides,
    };
}

function envWithToken(overrides = {}, envOverrides = {}) {
    const token = tokenRecord(overrides);
    const security = {
        auth: {
            admin: { adminUsername: 'admin', adminPassword: 'configured' },
            user: { authCode: 'configured' },
        },
        apiTokens: { tokens: { [token.id]: token } },
    };

    return {
        img_url: new MemoryKV({
            'manage@sysConfig@security': JSON.stringify(security),
        }),
        ...envOverrides,
    };
}

function apiTokenAuth(overrides = {}) {
    const token = publicTokenIdentity(tokenRecord(overrides));
    return {
        authorized: true,
        authType: 'admin',
        credentialType: 'apiToken',
        token,
    };
}

test('permissions require a non-empty strict whitelist array', () => {
    assert.deepEqual(normalizePermissions(['list', 'delete', 'list']), ['list', 'delete']);
    assert.throws(() => normalizePermissions('list'), /非空数组/);
    assert.throws(() => normalizePermissions([]), /非空数组/);
    assert.throws(() => normalizePermissions(['list', 'owner']), /未知权限/);
});

test('prefixes normalize to segment boundaries and reject ambiguous paths', () => {
    assert.deepEqual(normalizeAllowedPrefixes(['/nav-notes/user-a/']), ['nav-notes/user-a/']);
    assert.equal(isPathAllowedForToken(tokenRecord(), 'nav-notes/file.png'), true);
    assert.equal(isPathAllowedForToken(tokenRecord(), 'nav-notes-evil/file.png'), false);

    for (const path of [
        'nav-notes/../private',
        'nav-notes/%252e%252e/private',
        'nav-notes\\private',
        'nav-notes/\u0000private',
        'nav-notes\u2215private',
        'nav-notes\uff0fprivate',
    ]) {
        assert.throws(() => normalizeResourcePath(path));
    }
});

test('scoped request paths reject lossy canonicalization before storage', () => {
    assert.equal(requireCanonicalResourcePath('nav-notes/user-a'), 'nav-notes/user-a');
    assert.throws(() => requireCanonicalResourcePath(' nav-notes/user-a'), /规范形式/);
    assert.throws(() => requireCanonicalResourcePath('nav-notes//user-a'), /规范形式/);

    const auth = apiTokenAuth({ allowedPrefixes: ['nav-notes/user-a/'] });
    assert.equal(authorizeUploadFolder(auth, 'nav-notes/user-a'), 'nav-notes/user-a');

    const multiplyEncoded = new URL(
        'https://pic.example/upload?uploadFolder=nav-notes%25252Fuser-a'
    ).searchParams.get('uploadFolder');
    assert.equal(multiplyEncoded, 'nav-notes%252Fuser-a');
    assert.throws(() => authorizeUploadFolder(auth, multiplyEncoded), /规范形式/);
    assert.throws(() => authorizeUploadFolder(auth, ' nav-notes/user-a'), /规范形式/);
    assert.throws(() => authorizeUploadFolder(auth, 'private/files'), /允许范围/);
});

test('missing prefixes preserve legacy access while explicit empty prefixes deny access', () => {
    const legacy = tokenRecord();
    delete legacy.allowedPrefixes;
    assert.equal(isPathAllowedForToken(legacy, 'anywhere/file.png'), true);
    assert.equal(isPathAllowedForToken(tokenRecord({ allowedPrefixes: [] }), 'nav-notes/file.png'), false);
});

test('public token identity carries policy but never the bearer secret', () => {
    const identity = publicTokenIdentity(tokenRecord());
    assert.equal(identity.id, 'token-id');
    assert.deepEqual(identity.permissions, ['upload', 'list', 'delete']);
    assert.deepEqual(identity.allowedPrefixes, ['nav-notes/']);
    assert.equal(identity.allowFolderDelete, false);
    assert.equal('token' in identity, false);
});

test('new token creation persists normalized scoped policy and rejects unknown permissions', async () => {
    const db = new MemoryKV();
    const created = await createApiToken(
        db,
        'Scoped NAV token',
        ['upload', 'list', 'delete'],
        'nav',
        null,
        false,
        'user',
        ['/nav-notes/'],
        false
    );
    assert.deepEqual(created.allowedPrefixes, ['nav-notes/']);

    const stored = JSON.parse(await db.get('manage@sysConfig@security'));
    assert.deepEqual(stored.apiTokens.tokens[created.id].allowedPrefixes, ['nav-notes/']);
    assert.equal(stored.apiTokens.tokens[created.id].allowFolderDelete, false);

    await assert.rejects(
        () => createApiToken(db, 'bad', ['list', 'root'], 'test'),
        /未知权限/
    );
    await assert.rejects(
        () => createApiToken(db, 'bad folder delete', ['delete'], 'test', null, false, 'user', ['nav-notes/'], true),
        /delete 与 manage/
    );
});

test('authentication returns the scoped API token identity', async () => {
    const result = await authenticate({
        env: envWithToken(),
        request: new Request('https://pic.example/api/manage/list?dir=nav-notes', {
            headers: { Authorization: 'Bearer imgbed_test_token' },
        }),
        requiredPermission: 'list',
        authScope: AUTH_SCOPE.ADMIN,
    });

    assert.equal(result.authorized, true);
    assert.equal(result.credentialType, 'apiToken');
    assert.deepEqual(result.token.allowedPrefixes, ['nav-notes/']);
    assert.equal('token' in result.token, false);
});

test('list action always requires manage permission', () => {
    assert.equal(extractRequiredPermission(new URL('https://pic.example/api/manage/list')), 'list');
    assert.equal(extractRequiredPermission(new URL('https://pic.example/api/manage/list/')), 'list');
    assert.equal(extractRequiredPermission(new URL('https://pic.example/api/manage/list?action=')), 'manage');
    assert.equal(extractRequiredPermission(new URL('https://pic.example/api/manage/list?action=rebuild')), 'manage');
    assert.equal(extractRequiredPermission(new URL('https://pic.example/api/manage/delete/file.png')), 'delete');
    assert.equal(extractRequiredPermission(new URL('https://pic.example/api/manage/batch/list')), 'manage');
    assert.equal(extractRequiredPermission(new URL('https://pic.example/api/manage/cusConfig/list')), 'manage');
    assert.equal(
        extractRequiredPermission(new URL('https://pic.example/api/manage/rename/private/delete/file.png')),
        'manage'
    );
});

test('list route rejects unknown actions and rechecks manage permission', async () => {
    const unknownUrl = new URL('https://pic.example/api/manage/list?action=unexpected');
    const unknownResponse = await listRoute({
        request: new Request(unknownUrl),
        data: { auth: apiTokenAuth({ permissions: ['manage'] }) },
        waitUntil() {},
    });
    assert.equal(unknownResponse.status, 400);

    const actionUrl = new URL('https://pic.example/api/manage/list?action=info');
    const deniedResponse = await listRoute({
        request: new Request(actionUrl),
        data: { auth: apiTokenAuth({ permissions: ['list'] }) },
        waitUntil() {},
    });
    assert.equal(deniedResponse.status, 403);
});

test('manage middleware enforces permission and path scope before the handler runs', async () => {
    const invoke = async (url, tokenOverrides = {}, method = 'GET') => {
        const context = {
            env: envWithToken(tokenOverrides),
            request: new Request(url, {
                method,
                headers: { Authorization: 'Bearer imgbed_test_token' },
            }),
            data: {},
            next: async () => new Response('next'),
        };
        return { context, response: await manageMiddleware[1](context) };
    };

    const actionDenied = await invoke('https://pic.example/api/manage/list?action=rebuild');
    assert.equal(actionDenied.response.status, 401);

    const actionAllowed = await invoke(
        'https://pic.example/api/manage/list?action=info',
        { permissions: ['manage'] }
    );
    assert.equal(actionAllowed.response.status, 200);
    assert.equal(actionAllowed.context.data.auth.credentialType, 'apiToken');

    const listAllowed = await invoke('https://pic.example/api/manage/list?dir=nav-notes/user-a');
    assert.equal(listAllowed.response.status, 200);

    const listDenied = await invoke('https://pic.example/api/manage/list?dir=nav-notes-evil');
    assert.equal(listDenied.response.status, 403);

    const ambiguousList = await invoke(
        'https://pic.example/api/manage/list?dir=nav-notes%25252Fuser-a'
    );
    assert.equal(ambiguousList.response.status, 403);

    const batchListDenied = await invoke('https://pic.example/api/manage/batch/list');
    assert.equal(batchListDenied.response.status, 401);

    const renameDeleteSegmentDenied = await invoke(
        'https://pic.example/api/manage/rename/private/delete/file.png',
        {},
        'POST'
    );
    assert.equal(renameDeleteSegmentDenied.response.status, 401);

    const legacyGetDelete = await invoke('https://pic.example/api/manage/delete/nav-notes/file.png');
    assert.equal(legacyGetDelete.response.status, 405);
});

test('scoped list/delete requests reject traversal, sibling prefixes, wrong methods and folder widening', () => {
    const auth = apiTokenAuth();

    const allowedList = validateManageRequestScope(
        new URL('https://pic.example/api/manage/list?dir=nav-notes'),
        new Request('https://pic.example/api/manage/list?dir=nav-notes'),
        auth
    );
    assert.equal(allowedList, null);

    const siblingList = validateManageRequestScope(
        new URL('https://pic.example/api/manage/list?dir=nav-notes-evil'),
        new Request('https://pic.example/api/manage/list?dir=nav-notes-evil'),
        auth
    );
    assert.equal(siblingList.status, 403);

    const ambiguousListUrl = new URL(
        'https://pic.example/api/manage/list?dir=nav-notes%25252Fuser-a'
    );
    const ambiguousList = validateManageRequestScope(
        ambiguousListUrl,
        new Request(ambiguousListUrl),
        auth
    );
    assert.equal(ambiguousList.status, 403);

    const encodedTraversalUrl = new URL('https://pic.example/api/manage/delete/nav-notes/%252e%252e/private.png');
    const encodedTraversal = validateManageRequestScope(
        encodedTraversalUrl,
        new Request(encodedTraversalUrl, { method: 'DELETE' }),
        auth
    );
    assert.equal(encodedTraversal.status, 403);

    const getDeleteUrl = new URL('https://pic.example/api/manage/delete/nav-notes/file.png');
    const getDelete = validateManageRequestScope(getDeleteUrl, new Request(getDeleteUrl), auth);
    assert.equal(getDelete.status, 405);
    assert.equal(getDelete.headers.get('Allow'), 'DELETE, OPTIONS');

    const folderDeleteUrl = new URL('https://pic.example/api/manage/delete/nav-notes?folder=true');
    const folderDelete = validateManageRequestScope(
        folderDeleteUrl,
        new Request(folderDeleteUrl, { method: 'DELETE' }),
        auth
    );
    assert.equal(folderDelete.status, 403);
});

test('HuggingFace commit fields must match a live grant from the same API token', async () => {
    const db = new MemoryKV();
    const auth = apiTokenAuth({ allowedPrefixes: ['nav-notes/user-a/'] });
    const fields = {
        fullId: 'nav-notes/user-a/file.png',
        filePath: 'nav-notes/user-a/uuid_file.png',
        sha256: 'a'.repeat(64),
        fileSize: 1024,
        channelName: 'primary',
    };
    const now = Date.parse('2026-08-01T00:00:00.000Z');

    const created = await createHuggingFaceUploadGrant(db, auth, fields, now);
    assert.ok(await validateHuggingFaceUploadGrant(db, auth, fields, now + 1));
    assert.equal(
        await validateHuggingFaceUploadGrant(
            db,
            auth,
            { ...fields, fullId: 'private/file.png' },
            now + 1
        ),
        null
    );
    assert.equal(
        await validateHuggingFaceUploadGrant(
            db,
            apiTokenAuth({ id: 'other-token', allowedPrefixes: ['nav-notes/user-a/'] }),
            fields,
            now + 1
        ),
        null
    );
    assert.equal(
        await validateHuggingFaceUploadGrant(db, auth, fields, now + 16 * 60 * 1000),
        null
    );

    await deleteHuggingFaceUploadGrant(db, created.key);
    assert.equal(await validateHuggingFaceUploadGrant(db, auth, fields, now + 1), null);
});

test('external API tokens cannot enter the non-atomic HuggingFace direct-upload flow', () => {
    assert.equal(isHuggingFaceDirectUploadAllowed(apiTokenAuth()), false);
    assert.equal(isHuggingFaceDirectUploadAllowed({ credentialType: 'adminSession' }), true);
    assert.equal(isHuggingFaceDirectUploadAllowed({ credentialType: 'userSession' }), true);
    assert.equal(isHuggingFaceDirectUploadAllowed({ credentialType: 'anonymousUser' }), false);
    assert.equal(isHuggingFaceDirectUploadAllowed({ credentialType: 'authCode' }), false);
    assert.equal(isHuggingFaceDirectUploadAllowed({ credentialType: 'developmentBypass' }), false);
    assert.equal(isHuggingFaceDirectUploadAllowed({}), false);
});

test('only an opted-in manage token can use folder deletion', () => {
    const url = new URL('https://pic.example/api/manage/delete/nav-notes?folder=true');
    const response = validateManageRequestScope(
        url,
        new Request(url, { method: 'DELETE' }),
        apiTokenAuth({
            permissions: ['delete', 'manage'],
            allowFolderDelete: true,
        })
    );
    assert.equal(response, null);
});

test('administrator sessions retain legacy GET delete compatibility', () => {
    const url = new URL('https://pic.example/api/manage/delete/nav-notes/file.png');
    const response = validateManageRequestScope(url, new Request(url), {
        authorized: true,
        authType: 'admin',
        credentialType: 'adminSession',
    });
    assert.equal(response, null);
});

test('manage middleware accepts legacy GET delete only for an administrator session', async () => {
    const env = envWithToken();
    await env.img_url.put('manage@session@admin-test-session', JSON.stringify({
        authType: 'admin',
        username: 'admin',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
    }));
    const context = {
        env,
        request: new Request('https://pic.example/api/manage/delete/nav-notes/file.png', {
            headers: { Cookie: 'admin_session=admin-test-session' },
        }),
        data: {},
        next: async () => new Response('next'),
    };

    const response = await manageMiddleware[1](context);
    assert.equal(response.status, 200);
    assert.equal(context.data.auth.credentialType, 'adminSession');
});

test('production without administrator configuration fails closed; explicit development remains compatible', async () => {
    const productionContext = {
        env: { img_url: new MemoryKV() },
        request: new Request('https://pic.example/api/manage/list'),
        data: {},
        next: async () => new Response('next'),
    };
    const productionResponse = await manageMiddleware[1](productionContext);
    assert.equal(productionResponse.status, 401);

    const developmentContext = {
        ...productionContext,
        env: { img_url: new MemoryKV(), dev_mode: 'true' },
        data: {},
    };
    const developmentResponse = await manageMiddleware[1](developmentContext);
    assert.equal(developmentResponse.status, 200);
    assert.equal(await developmentResponse.text(), 'next');
    assert.equal(developmentContext.data.auth.credentialType, 'developmentBypass');
});

test('administrator login also fails closed outside explicit development mode', async () => {
    const makeRequest = () => new Request('https://pic.example/api/auth/adminLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '', password: '' }),
    });

    const productionResponse = await adminLogin({
        env: { img_url: new MemoryKV() },
        request: makeRequest(),
    });
    assert.equal(productionResponse.status, 503);

    const developmentResponse = await adminLogin({
        env: { img_url: new MemoryKV(), dev_mode: 'true' },
        request: makeRequest(),
    });
    assert.equal(developmentResponse.status, 200);
    assert.match(developmentResponse.headers.get('Set-Cookie'), /^admin_session=/);
});

test('delete path parsing is normalized and missing records are idempotent', () => {
    assert.equal(
        extractDeleteResourcePath('/api/manage/delete/nav-notes/user-a/file.png'),
        'nav-notes/user-a/file.png'
    );
    assert.equal(isMissingStoredFile(null), true);
    assert.equal(isMissingStoredFile({ value: null, metadata: null }), true);
    assert.equal(isMissingStoredFile({ value: new ArrayBuffer(0), metadata: null }), false);
});

test('manage middleware does not disclose exception messages or stack traces', async () => {
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        const response = await manageMiddleware[0]({
            next: async () => {
                const error = new Error('sensitive upstream detail');
                error.stack = 'private stack trace';
                throw error;
            },
        });
        assert.equal(response.status, 500);
        assert.equal(await response.text(), 'Internal server error');
        assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
    } finally {
        console.error = originalConsoleError;
    }
});
