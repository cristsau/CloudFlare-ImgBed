import { checkDatabaseConfig } from "../../../utils/databaseAdapter.js";

const BACKUP_TOKEN_SHA256 =
  "b41b2ba126c2cca97c35cb51ec33b16d8059c6e5ac1a9cb44ad9a5c0c6fcc6a0";

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      ...extraHeaders,
    },
  });
}

function extractBearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : "";
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function isAuthorized(request) {
  const token = extractBearerToken(request);
  if (!token) return false;

  const actualHash = await sha256Hex(token);
  return constantTimeEqual(actualHash, BACKUP_TOKEN_SHA256);
}

async function backupKv(kv) {
  const manage = {};
  let cursor;

  do {
    const page = await kv.list({
      prefix: "manage@",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });

    for (const key of page.keys) {
      manage[key.name] = await kv.get(key.name);
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return {
    databaseMode: "kv",
    manage,
    stats: {
      manageKeyCount: Object.keys(manage).length,
    },
  };
}

async function backupD1(d1) {
  const [settingsResult, legacyManageResult, statsResult] = await Promise.all([
    d1.prepare(
      "SELECT key, value, category FROM settings ORDER BY key"
    ).all(),
    d1.prepare(
      "SELECT id, value, metadata FROM files WHERE id LIKE 'manage@%' ORDER BY id"
    ).all(),
    d1.prepare(
      "SELECT " +
        "(SELECT COUNT(*) FROM files) AS file_count, " +
        "(SELECT COUNT(*) FROM settings) AS setting_count"
    ).first(),
  ]);

  return {
    databaseMode: "d1",
    settings: settingsResult.results || [],
    legacyManageRecords: legacyManageResult.results || [],
    stats: {
      fileCount: Number(statsResult?.file_count || 0),
      settingCount: Number(statsResult?.setting_count || 0),
      legacyManageCount: (legacyManageResult.results || []).length,
    },
  };
}

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, {
      Allow: "GET",
    });
  }

  if (!(await isAuthorized(context.request))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const database = checkDatabaseConfig(context.env);
  let data;

  if (database.usingKV) {
    data = await backupKv(context.env.img_url);
  } else if (database.usingD1) {
    data = await backupD1(context.env.img_d1);
  } else {
    return jsonResponse({ error: "Database not configured" }, 503);
  }

  return jsonResponse(
    {
      backupType: "cloudflare-imgbed-pre-upgrade-config",
      sourceVersion: "v2.3.4",
      createdAt: new Date().toISOString(),
      ...data,
    },
    200,
    {
      "Content-Disposition":
        'attachment; filename="cloudflare-imgbed-pre-upgrade-config.json"',
    }
  );
}
