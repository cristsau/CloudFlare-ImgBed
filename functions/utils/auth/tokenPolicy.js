export const TOKEN_PERMISSIONS = Object.freeze([
    'upload',
    'list',
    'delete',
    'manage',
]);

const TOKEN_PERMISSION_SET = new Set(TOKEN_PERMISSIONS);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ENCODED_OCTET = /%[0-9a-f]{2}/i;
const AMBIGUOUS_SLASHES = /[\u2044\u2215\uff0f]/;

function decodePath(value) {
    let decoded = value;

    for (let pass = 0; pass < 3 && ENCODED_OCTET.test(decoded); pass++) {
        try {
            decoded = decodeURIComponent(decoded);
        } catch {
            throw new TypeError('路径包含无效的 URL 编码');
        }
    }

    if (ENCODED_OCTET.test(decoded)) {
        throw new TypeError('路径包含过度编码的字符');
    }

    return decoded;
}

/**
 * Normalize a logical storage path without silently repairing ambiguous input.
 * The returned value never starts or ends with a slash.
 */
export function normalizeResourcePath(value, { allowEmpty = false } = {}) {
    if (typeof value !== 'string') {
        throw new TypeError('路径必须是字符串');
    }

    const decoded = decodePath(value);
    if (AMBIGUOUS_SLASHES.test(decoded)) {
        throw new TypeError('路径包含相似斜杠字符');
    }

    let normalized = decoded.normalize('NFKC').trim();

    if (CONTROL_CHARACTERS.test(normalized) || normalized.includes('\\')) {
        throw new TypeError('路径包含禁止字符');
    }

    if (AMBIGUOUS_SLASHES.test(normalized)) {
        throw new TypeError('路径包含相似斜杠字符');
    }

    normalized = normalized.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');

    if (!normalized) {
        if (allowEmpty) return '';
        throw new TypeError('路径不能为空');
    }

    const segments = normalized.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment.includes('..'))) {
        throw new TypeError('路径包含不安全的层级');
    }

    return segments.join('/');
}

/**
 * Request paths used for authorization must already be in their canonical
 * form. Rejecting lossy normalization prevents the authorization layer and a
 * downstream storage adapter from resolving the same input to different keys.
 */
export function requireCanonicalResourcePath(value, { allowEmpty = false } = {}) {
    const normalized = normalizeResourcePath(value, { allowEmpty });
    if (value !== normalized) {
        throw new TypeError('路径不是规范形式');
    }
    return normalized;
}

export function normalizePermissions(permissions) {
    if (!Array.isArray(permissions) || permissions.length === 0) {
        throw new TypeError('permissions 必须是非空数组');
    }

    const normalized = [];
    const seen = new Set();

    for (const permission of permissions) {
        if (typeof permission !== 'string' || !TOKEN_PERMISSION_SET.has(permission)) {
            throw new TypeError('permissions 包含未知权限');
        }

        if (!seen.has(permission)) {
            seen.add(permission);
            normalized.push(permission);
        }
    }

    return normalized;
}

/**
 * Missing prefixes intentionally remain null for backward compatibility with
 * existing unrestricted tokens. An explicit empty array grants no path access.
 */
export function normalizeAllowedPrefixes(allowedPrefixes) {
    if (allowedPrefixes === undefined || allowedPrefixes === null) {
        return null;
    }

    if (!Array.isArray(allowedPrefixes)) {
        throw new TypeError('allowedPrefixes 必须是数组');
    }

    const normalized = [];
    const seen = new Set();

    for (const prefix of allowedPrefixes) {
        const path = normalizeResourcePath(prefix);
        const directoryPrefix = `${path}/`;
        if (!seen.has(directoryPrefix)) {
            seen.add(directoryPrefix);
            normalized.push(directoryPrefix);
        }
    }

    return normalized;
}

export function normalizeAllowFolderDelete(value) {
    if (value === undefined || value === null) return false;
    if (typeof value !== 'boolean') {
        throw new TypeError('allowFolderDelete 必须是布尔值');
    }
    return value;
}

export function assertFolderDeletePolicy(permissions, allowFolderDelete) {
    if (allowFolderDelete === true
        && (!permissions.includes('manage') || !permissions.includes('delete'))) {
        throw new TypeError('allowFolderDelete 需要 delete 与 manage 权限');
    }
}

export function normalizeTokenPolicy(tokenData) {
    if (!tokenData || typeof tokenData !== 'object') {
        throw new TypeError('Token 配置无效');
    }

    const policy = {
        ...tokenData,
        permissions: normalizePermissions(tokenData.permissions),
        allowedPrefixes: normalizeAllowedPrefixes(tokenData.allowedPrefixes),
        allowFolderDelete: normalizeAllowFolderDelete(tokenData.allowFolderDelete),
    };
    assertFolderDeletePolicy(policy.permissions, policy.allowFolderDelete);
    return policy;
}

export function isPathAllowedForToken(tokenData, resourcePath) {
    const policy = normalizeTokenPolicy(tokenData);

    // Legacy token: no allowedPrefixes field means unrestricted access.
    if (policy.allowedPrefixes === null) {
        return true;
    }

    const path = normalizeResourcePath(resourcePath);
    return policy.allowedPrefixes.some(prefix => {
        const directory = prefix.slice(0, -1);
        return path === directory || path.startsWith(prefix);
    });
}

export function publicTokenIdentity(tokenData) {
    const policy = normalizeTokenPolicy(tokenData);
    return {
        id: policy.id ?? null,
        name: policy.name ?? '',
        owner: policy.owner ?? '',
        type: policy.type ?? 'user',
        permissions: policy.permissions,
        allowedPrefixes: policy.allowedPrefixes,
        allowFolderDelete: policy.allowFolderDelete,
    };
}
