import {
    isPathAllowedForToken,
    requireCanonicalResourcePath,
} from './tokenPolicy.js';

// Keep this aligned with sanitizeUploadFolder. Scoped requests must not rely
// on a later lossy replacement because that would change the authorized key.
const STORAGE_AMBIGUOUS_CHARACTERS = /[\\:\*\?"'<>\| \(\)\[\]\{\}#%\^`~;@&=\+\$,]/;

export function canonicalizeUploadFolder(rawFolder) {
    const folder = requireCanonicalResourcePath(rawFolder, { allowEmpty: true });
    if (STORAGE_AMBIGUOUS_CHARACTERS.test(folder)) {
        throw new TypeError('上传路径包含会改变资源标识的字符');
    }
    return folder;
}

export function authorizeUploadFolder(authResult, rawFolder) {
    const folder = canonicalizeUploadFolder(rawFolder);
    if (authResult?.credentialType === 'apiToken'
        && !isPathAllowedForToken(authResult.token, folder)) {
        throw new TypeError('上传路径超出 Token 允许范围');
    }
    return folder;
}

export function writeCanonicalUploadFolder(url, folder) {
    if (folder) {
        url.searchParams.set('uploadFolder', folder);
    } else {
        url.searchParams.delete('uploadFolder');
    }
}
