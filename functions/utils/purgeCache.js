import { fetchOthersConfig } from "./sysConfig.js";

export async function purgeCFCache(env, cdnUrl) {
    const result = {
        cacheInvalidated: false,
        cachePurgeConfigured: false,
        cachePurgeAttempted: false,
        cachePurgeSucceeded: false,
        localCacheInvalidated: false,
    };

    // Cache API deletion is exact but data-center local. Attempt it even when
    // account-level Cloudflare purge credentials are not configured.
    try {
        if (typeof caches !== 'undefined' && caches.default?.delete) {
            result.localCacheInvalidated = await caches.default.delete(new Request(cdnUrl));
        }
    } catch (error) {
        console.error('Failed to delete exact URL from local cache:', error.message || error);
    }

    try {
        const othersConfig = await fetchOthersConfig(env);
        const cfZoneId = othersConfig.cloudflareApiToken?.CF_ZONE_ID;
        const cfEmail = othersConfig.cloudflareApiToken?.CF_EMAIL;
        const cfApiKey = othersConfig.cloudflareApiToken?.CF_API_KEY;
        result.cachePurgeConfigured = Boolean(cfZoneId && cfEmail && cfApiKey);

        if (!result.cachePurgeConfigured) {
            result.cacheInvalidated = result.localCacheInvalidated;
            return result;
        }

        result.cachePurgeAttempted = true;
        const options = {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'X-Auth-Email': `${cfEmail}`, 'X-Auth-Key': `${cfApiKey}`},
            body: JSON.stringify({ files: [cdnUrl] }),
        };
        const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${cfZoneId}/purge_cache`, options);
        let responseData = null;
        try {
            responseData = await response.json();
        } catch {
            responseData = null;
        }
        result.cachePurgeSucceeded = response.ok && responseData?.success === true;
        if (!result.cachePurgeSucceeded) {
            console.error('Cloudflare cache purge failed:', response.status);
        }
    } catch (error) {
        console.error('Failed to purge CF cache:', error.message || error);
    }

    result.cacheInvalidated = result.cachePurgeSucceeded || result.localCacheInvalidated;
    return result;
}

export async function purgeRandomFileListCache(origin, ...dirs) {
    try {
        const cache = caches.default;
        // cache.delete有bug，通过写入一个max-age=0的response来清除缓存
        const nullResponse = new Response(null, {
            headers: { 'Cache-Control': 'max-age=0' },
        });

        for (const dir of dirs) {
            await cache.put(`${origin}/api/randomFileList?dir=${dir}`, nullResponse);
        }
    } catch (error) {
        console.error('Failed to clear randomFileList cache:', error);
    }
}

export async function purgePublicFileListCache(origin, ...dirs) {
    try {
        const cache = caches.default;
        // cache.delete有bug，通过写入一个max-age=0的response来清除缓存
        const nullResponse = new Response(null, {
            headers: { 'Cache-Control': 'max-age=0' },
        });

        for (const dir of dirs) {
            // 清除递归和非递归两种缓存
            await cache.put(`${origin}/api/publicFileList?dir=${dir}&recursive=false`, nullResponse);
            await cache.put(`${origin}/api/publicFileList?dir=${dir}&recursive=true`, nullResponse);
        }
    } catch (error) {
        console.error('Failed to clear publicFileList cache:', error);
    }
}
