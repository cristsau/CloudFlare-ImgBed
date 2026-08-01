const GRANT_PREFIX = 'manage@huggingfaceUploadGrant@';
const GRANT_TTL_SECONDS = 15 * 60;

export function isHuggingFaceDirectUploadAllowed(authResult) {
    // KV cannot atomically consume a one-time grant. Keep external API tokens
    // on the normal /upload path so a concurrent replay cannot trigger two
    // HuggingFace commits. Interactive first-party sessions retain the legacy
    // direct-upload flow with the field-bound short-lived grant as defense in depth.
    return ['adminSession', 'userSession'].includes(authResult?.credentialType);
}

function normalizeGrantFields(fields) {
    const normalized = {
        fullId: fields?.fullId,
        filePath: fields?.filePath,
        sha256: fields?.sha256,
        fileSize: Number(fields?.fileSize),
        channelName: fields?.channelName || '',
    };

    if (typeof normalized.fullId !== 'string' || !normalized.fullId
        || typeof normalized.filePath !== 'string' || !normalized.filePath
        || typeof normalized.sha256 !== 'string' || !normalized.sha256
        || typeof normalized.channelName !== 'string'
        || !Number.isFinite(normalized.fileSize) || normalized.fileSize <= 0) {
        throw new TypeError('Invalid HuggingFace upload grant fields');
    }

    return normalized;
}

function credentialBinding(authResult) {
    if (authResult?.credentialType === 'apiToken') {
        if (!authResult.token?.id) {
            throw new TypeError('API Token identity is missing');
        }
        return `apiToken:${authResult.token.id}`;
    }

    return authResult?.credentialType || 'unknown';
}

async function grantKey(authResult, fields) {
    const payload = JSON.stringify({
        credential: credentialBinding(authResult),
        ...normalizeGrantFields(fields),
    });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return `${GRANT_PREFIX}${hex}`;
}

export async function createHuggingFaceUploadGrant(db, authResult, fields, now = Date.now()) {
    const normalized = normalizeGrantFields(fields);
    const key = await grantKey(authResult, normalized);
    const grant = {
        credential: credentialBinding(authResult),
        ...normalized,
        expiresAt: now + GRANT_TTL_SECONDS * 1000,
    };
    await db.put(key, JSON.stringify(grant), { expirationTtl: GRANT_TTL_SECONDS });
    return { key, grant };
}

export async function validateHuggingFaceUploadGrant(db, authResult, fields, now = Date.now()) {
    const normalized = normalizeGrantFields(fields);
    const key = await grantKey(authResult, normalized);
    const stored = await db.get(key);
    if (!stored) return null;

    try {
        const grant = JSON.parse(stored);
        if (grant.expiresAt <= now
            || grant.credential !== credentialBinding(authResult)
            || grant.fullId !== normalized.fullId
            || grant.filePath !== normalized.filePath
            || grant.sha256 !== normalized.sha256
            || grant.fileSize !== normalized.fileSize
            || grant.channelName !== normalized.channelName) {
            return null;
        }
        return { key, grant };
    } catch {
        return null;
    }
}

export async function deleteHuggingFaceUploadGrant(db, key) {
    await db.delete(key);
}
