import { authenticate, AUTH_SCOPE } from "../../utils/auth/authCore.js";
import {
  isPathAllowedForToken,
  normalizeResourcePath,
  requireCanonicalResourcePath,
} from "../../utils/auth/tokenPolicy.js";

const DEFAULT_MANAGE_CACHE_CONTROL = 'private, no-store, max-age=0';

function withDefaultCacheControl(response) {
  if (response.headers.has('Cache-Control')) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('Cache-Control', DEFAULT_MANAGE_CACHE_CONTROL);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function errorHandling(context) {
  try {
    return withDefaultCacheControl(await context.next());
  } catch (err) {
    console.error(
      'Manage API request failed',
      err instanceof Error ? err.message : String(err)
    );
    return new Response('Internal server error', {
      status: 500,
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Cache-Control': DEFAULT_MANAGE_CACHE_CONTROL,
      },
    });
  }
}

function UnauthorizedException(reason) {
  return new Response(reason, {
    status: 401,
    statusText: 'Unauthorized',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Cache-Control': 'no-store',
      'Content-Length': reason.length,
    },
  });
}

/**
 * 根据请求路径提取所需权限
 * @param {URL} url - 请求 URL
 * @returns {string} 需要的权限类型
 */
export function extractRequiredPermission(url) {
  const pathname = url.pathname.toLowerCase().replace(/\/+$/, '');

  if (pathname === '/api/manage/delete' || pathname.startsWith('/api/manage/delete/')) {
    return 'delete';
  }

  if (pathname === '/api/manage/list') {
    // /api/manage/list?action=* performs global index administration and must
    // never be available to a read-only list token.
    if (url.searchParams.has('action')) {
      return 'manage';
    }
    return 'list';
  }

  // 其他 /api/manage 下的操作需要管理权限
  return 'manage';
}

function forbidden(reason) {
  return new Response(reason, {
    status: 403,
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}

function methodNotAllowed(allowed) {
  return new Response('Method not allowed', {
    status: 405,
    headers: {
      'Allow': allowed,
      'Cache-Control': 'no-store',
    },
  });
}

export function extractDeleteResourcePath(pathname) {
  const routePrefix = '/api/manage/delete/';
  if (!pathname.toLowerCase().startsWith(routePrefix)) {
    throw new TypeError('删除路径无效');
  }

  const rawPath = pathname.slice(routePrefix.length).split(',').join('/');
  return normalizeResourcePath(rawPath);
}

export function validateManageRequestScope(url, request, authResult) {
  const pathname = url.pathname.toLowerCase().replace(/\/+$/, '');
  const isApiToken = authResult.credentialType === 'apiToken';

  if (pathname.startsWith('/api/manage/delete/')) {
    if (isApiToken && request.method !== 'DELETE') {
      return methodNotAllowed('DELETE, OPTIONS');
    }

    if (!isApiToken && !['GET', 'DELETE'].includes(request.method)) {
      return methodNotAllowed('GET, DELETE, OPTIONS');
    }

    // Folder deletion is only available to an explicitly opted-in management
    // token. A normal delete token can never widen itself to a directory.
    if (isApiToken && url.searchParams.get('folder') === 'true') {
      const canDeleteFolder = authResult.token.permissions.includes('manage')
        && authResult.token.allowFolderDelete === true;
      if (!canDeleteFolder) {
        return forbidden('Token is not allowed to delete folders');
      }
    }

    if (isApiToken) {
      try {
        const resourcePath = extractDeleteResourcePath(url.pathname);
        if (!isPathAllowedForToken(authResult.token, resourcePath)) {
          return forbidden('Token path is outside its allowed prefixes');
        }
      } catch {
        return forbidden('Invalid or unauthorized delete path');
      }
    }
  }

  if (pathname === '/api/manage/list' && !url.searchParams.has('action') && isApiToken) {
    try {
      const directory = requireCanonicalResourcePath(
        url.searchParams.get('dir') || '',
        { allowEmpty: true }
      );
      if (!isPathAllowedForToken(authResult.token, directory)) {
        return forbidden('Token path is outside its allowed prefixes');
      }
      if (directory) {
        url.searchParams.set('dir', directory);
      } else {
        url.searchParams.delete('dir');
      }
    } catch {
      return forbidden('Invalid or unauthorized list path');
    }
  }

  return null;
}

// CORS 跨域响应头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

async function authentication(context) {
  // OPTIONS 预检请求不需要鉴权，直接返回 CORS 响应
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  const url = new URL(context.request.url);
  const requiredPermission = extractRequiredPermission(url);

  const result = await authenticate({
    env: context.env,
    request: context.request,
    requiredPermission,
    authScope: AUTH_SCOPE.ADMIN,
  });

  if (!result.authorized) {
    return UnauthorizedException('You need to login');
  }

  context.data = context.data || {};
  context.data.auth = result;

  const scopeError = validateManageRequestScope(url, context.request, result);
  if (scopeError) {
    return scopeError;
  }

  return context.next();
}

export const onRequest = [errorHandling, authentication];
