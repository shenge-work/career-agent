/**
 * Cloudflare Worker 哑云服务：只做四件事，绝不解析业务内容。
 *
 *   1. vault 注册与设备授权（TLS 内提交 authKey，云端只存 sha256 哈希）；
 *   2. 给事件分配全局严格递增 seq（CAS，序号只管断点续传，不参与冲突判定）；
 *   3. 存/取加密事件封包（aad 是明文路由信息，ciphertext 永远不解密）；
 *   4. 存/取已加密 blob（objectKey 是 HMAC 派生的 64 位 hex）。
 *
 * 路由（全部挂在 /v1）：
 *   POST /v1/vaults                               创建 vault（不可覆盖）
 *   GET  /v1/vaults/:id                            vault 元数据（含公开 salt）
 *   POST /v1/vaults/:id/devices                    注册设备
 *   GET  /v1/vaults/:id/head                      当前 seq
 *   POST /v1/vaults/:id/events                     CAS 批量推送
 *   GET  /v1/vaults/:id/events?since=&limit=      增量拉取
 *   PUT  /v1/vaults/:id/blobs/:objectKey           上传密文 blob
 *   GET  /v1/vaults/:id/blobs/:objectKey           下载密文 blob
 *   HEAD /v1/vaults/:id/blobs/:objectKey            探测是否存在
 *   DELETE /v1/vaults/:id/blobs/:objectKey          删除 blob（客户端 GC 用，幂等）
 *   GET  /v1/health                                部署自检
 *
 * 请求头：X-CA-Auth = authKey 的 64 位 hex；X-CA-Device = 设备 ID。
 */

import {
  AUTH_KEY_RE,
  DEFAULT_PULL_LIMIT,
  DEVICE_ID_RE,
  INITIAL_SEQ,
  isBase64,
  jsonResponse,
  MAX_BATCH,
  MAX_BLOB_BYTES,
  MAX_ENVELOPE_BYTES,
  MAX_PULL_LIMIT,
  MAX_REQUEST_BYTES,
  OBJECT_KEY_RE,
  SEQ_RE,
  SHA256_HEX_RE,
  SYNC_PROTOCOL_VERSION,
  SyncHttpError,
  VAULT_ID_RE,
  errorBody,
} from './protocol';
import { assignSeq, type NewEvent, type SyncStore, type VaultRecord } from './store';

export interface SyncWorkerEnv {
  store: SyncStore;
  /** 测试可注入固定时间；生产用 new Date()。 */
  now?: () => string;
}

interface PushEnvelope {
  v: number;
  vaultId: string;
  deviceId: string;
  seq?: string;
  aad: string;
  nonce: string;
  ciphertext: string;
  bytes: number;
}

function fail(status: number, code: string, message: string, headSeq?: string): never {
  throw new SyncHttpError(status, code, message, headSeq);
}

function assertVaultId(value: string): string {
  if (!VAULT_ID_RE.test(value)) fail(400, 'bad_vault_id', '非法 vaultId');
  return value;
}

function assertObjectKey(value: string): string {
  if (!OBJECT_KEY_RE.test(value)) fail(400, 'bad_object_key', '非法 objectKey：拒绝非 HMAC 派生路径');
  return value;
}

async function readJson(request: Request, maxTextBytes: number): Promise<Record<string, unknown>> {
  const text = await request.text();
  // Workers 运行时没有 Buffer，用 Web 标准 TextEncoder 量字节数
  if (new TextEncoder().encode(text).length > maxTextBytes) {
    fail(413, 'payload_too_large', '请求体过大');
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed as Record<string, unknown>;
  } catch {
    fail(400, 'bad_json', '请求体不是合法 JSON 对象');
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // 拷进普通 ArrayBuffer：Web Crypto 的 BufferSource 不接受 SharedArrayBuffer 视图
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 常量时间比较，避免按前缀逐字节 timing 泄漏 authHash。 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function authorize(request: Request, vault: VaultRecord): Promise<void> {
  const header = request.headers.get('x-ca-auth') || '';
  if (!AUTH_KEY_RE.test(header)) fail(401, 'unauthorized', '缺少或非法的同步授权头');
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) raw[i] = parseInt(header.slice(i * 2, i * 2 + 2), 16);
  const provided = await sha256Hex(raw);
  if (!constantTimeEqual(provided, vault.authHash)) {
    fail(401, 'unauthorized', '同步授权失败：恢复码或设备密钥不匹配');
  }
}

/**
 * 校验封包形状。云端不解密，但必须挡住跨 vault 重放、AAD 与外层不一致、
 * 批内 index 乱序、伪造 bytes 这几类「只改明文头就能破坏对端」的攻击。
 * 云端会忽略客户端自带 seq 并按 expectedSeq 重新分配。
 */
function validateEnvelopes(body: Record<string, unknown>, vaultId: string): PushEnvelope[] {
  const expectedSeq = body.expectedSeq;
  if (typeof expectedSeq !== 'string' || !SEQ_RE.test(expectedSeq)) {
    fail(400, 'bad_cursor', 'expectedSeq 必须是 20 位定长数字');
  }
  const list = body.envelopes;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH) {
    fail(400, 'bad_batch', `单批事件数必须在 1..${MAX_BATCH}`);
  }
  let total = 0;
  let lastIndex = -1;
  const result: PushEnvelope[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'bad_envelope', '封包格式非法');
    const e = raw as unknown as PushEnvelope;
    if (e.v !== SYNC_PROTOCOL_VERSION) fail(400, 'bad_version', '不支持的同步协议版本');
    if (e.vaultId !== vaultId) fail(400, 'vault_mismatch', '封包 vaultId 与请求路径不一致');
    if (typeof e.deviceId !== 'string' || !DEVICE_ID_RE.test(e.deviceId)) {
      fail(400, 'bad_device_id', '非法 deviceId');
    }
    if (e.seq !== undefined && e.seq !== '' && !SEQ_RE.test(String(e.seq))) {
      fail(400, 'bad_seq', '客户端不允许自带非法 seq');
    }
    if (typeof e.aad !== 'string' || e.aad.length > 2048) fail(400, 'bad_aad', '非法 AAD');
    let aad: Record<string, unknown>;
    try {
      aad = JSON.parse(e.aad) as Record<string, unknown>;
    } catch {
      fail(400, 'bad_aad', 'AAD 不是合法 JSON');
    }
    if (
      aad.v !== SYNC_PROTOCOL_VERSION ||
      aad.vaultId !== vaultId ||
      aad.deviceId !== e.deviceId ||
      typeof aad.batchId !== 'string' ||
      !aad.batchId ||
      aad.batchId.length > 128 ||
      !Number.isInteger(aad.index) ||
      (aad.index as number) < 0 ||
      (aad.index as number) <= lastIndex ||
      typeof aad.createdAt !== 'string'
    ) {
      fail(400, 'bad_aad', 'AAD 与封包不一致或批内 index 未严格递增');
    }
    lastIndex = aad.index as number;
    if (!isBase64(e.nonce, 64) || !isBase64(e.ciphertext, MAX_ENVELOPE_BYTES)) {
      fail(400, 'bad_ciphertext', 'nonce / ciphertext 不是合法 base64 或超出单条上限');
    }
    if (!Number.isInteger(e.bytes) || e.bytes !== e.ciphertext.length || e.bytes <= 32) {
      fail(400, 'bad_bytes', 'bytes 必须等于密文字节数');
    }
    total += e.bytes;
    if (total > MAX_REQUEST_BYTES) fail(413, 'payload_too_large', '单批密文总量超限');
    result.push(e);
  }
  return result;
}

function toEnvelope(row: {
  seq: string;
  vaultId: string;
  deviceId: string;
  aad: string;
  nonce: string;
  ciphertext: string;
  bytes: number;
}): PushEnvelope {
  return {
    v: SYNC_PROTOCOL_VERSION,
    vaultId: row.vaultId,
    deviceId: row.deviceId,
    seq: row.seq,
    aad: row.aad,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    bytes: row.bytes,
  };
}

function noStoreHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'cache-control': 'no-store', ...extra };
}

async function handleVaultRoute(
  request: Request,
  env: SyncWorkerEnv,
  vaultId: string,
  parts: string[]
): Promise<Response> {
  const vault = await env.store.getVault(vaultId);
  if (!vault) fail(404, 'vault_not_found', 'vault 不存在或尚未创建');
  await authorize(request, vault);

  const resource = parts[0] || '';
  const now = env.now ? env.now() : new Date().toISOString();

  if (!resource && request.method === 'GET') {
    return jsonResponse({
      vaultId: vault.vaultId,
      salt: vault.salt,
      headSeq: await env.store.headSeq(vaultId),
      createdAt: vault.createdAt,
      v: SYNC_PROTOCOL_VERSION,
    });
  }

  if (resource === 'devices' && request.method === 'POST' && parts.length === 1) {
    const body = await readJson(request, 4096);
    const deviceId = body.deviceId;
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
      fail(400, 'bad_device_id', '非法 deviceId');
    }
    await env.store.registerDevice(vaultId, deviceId, now);
    return jsonResponse({ ok: true, headSeq: await env.store.headSeq(vaultId) });
  }

  if (resource === 'head' && request.method === 'GET' && parts.length === 1) {
    return jsonResponse({ seq: await env.store.headSeq(vaultId) });
  }

  if (resource === 'events' && parts.length === 1) {
    if (request.method === 'POST') {
      const body = await readJson(request, MAX_REQUEST_BYTES * 2);
      const envelopes = validateEnvelopes(body, vaultId);
      const expectedSeq = body.expectedSeq as string;
      const { seqs, nextSeq } = assignSeq(expectedSeq, envelopes.length);
      const rows: NewEvent[] = envelopes.map((e, i) => ({
        seq: seqs[i],
        deviceId: e.deviceId,
        aad: e.aad,
        nonce: e.nonce,
        ciphertext: e.ciphertext,
        bytes: e.bytes,
      }));
      const appended = await env.store.appendEvents(vaultId, expectedSeq, rows);
      if (!appended.ok) {
        fail(409, 'seq_conflict', '同步序号冲突：请先 pull 再重试', appended.actual);
      }
      return jsonResponse({ accepted: rows.length, nextSeq: appended.nextSeq });
    }
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const since = url.searchParams.get('since') || INITIAL_SEQ;
      if (!SEQ_RE.test(since)) fail(400, 'bad_cursor', 'since 必须是 20 位定长数字');
      const rawLimit = Number(url.searchParams.get('limit') || DEFAULT_PULL_LIMIT);
      if (!Number.isInteger(rawLimit) || rawLimit < 1) fail(400, 'bad_limit', 'limit 非法');
      const limit = Math.min(rawLimit, MAX_PULL_LIMIT);
      const rows = await env.store.listEvents(vaultId, since, limit);
      return jsonResponse({
        envelopes: rows.map((r) => toEnvelope(r)),
        // 与 OfflinePackTransport 保持一致：无事件时仍返回云端 head，客户端可安全推进游标
        nextSeq: rows.length ? rows[rows.length - 1].seq : await env.store.headSeq(vaultId),
      });
    }
  }

  if (resource === 'blobs' && parts.length === 2) {
    const objectKey = assertObjectKey(parts[1]);
    if (request.method === 'PUT') {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_BLOB_BYTES) {
        fail(413, 'blob_too_large', 'blob 为空或超过 25MB');
      }
      const declared = Number(request.headers.get('x-ca-blob-bytes'));
      if (Number.isFinite(declared) && declared > 0 && declared !== bytes.length) {
        fail(400, 'bad_blob_bytes', '声明字节数与实际不一致');
      }
      await env.store.putBlob(vaultId, objectKey, bytes);
      return jsonResponse({ ok: true, bytes: bytes.length });
    }
    if (request.method === 'GET') {
      const bytes = await env.store.getBlob(vaultId, objectKey);
      if (!bytes) fail(404, 'blob_not_found', '云端 blob 不存在');
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return new Response(buffer, {
        status: 200,
        headers: noStoreHeaders({
          'content-type': 'application/octet-stream',
          'x-content-type-options': 'nosniff',
        }),
      });
    }
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: (await env.store.hasBlob(vaultId, objectKey)) ? 200 : 404,
        headers: noStoreHeaders(),
      });
    }
    if (request.method === 'DELETE') {
      await env.store.deleteBlob(vaultId, objectKey);
      return new Response(null, { status: 204, headers: noStoreHeaders() });
    }
  }

  fail(404, 'not_found', '未知同步端点');
}

/** 与运行时无关的纯请求处理器；index.ts 只负责构造 store 并转调。 */
export async function handleSyncRequest(request: Request, env: SyncWorkerEnv): Promise<Response> {
  try {
    const url = new URL(request.url);
    const segments = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    if (segments[0] !== 'v1') fail(404, 'not_found', '未知协议路径');

    if (segments.length === 2 && segments[1] === 'health' && request.method === 'GET') {
      return jsonResponse({ ok: true, v: SYNC_PROTOCOL_VERSION });
    }

    if (segments.length === 2 && segments[1] === 'vaults' && request.method === 'POST') {
      const body = await readJson(request, 4096);
      const vaultId = body.vaultId;
      const authHash = body.authHash;
      const salt = body.salt;
      const deviceId = body.deviceId;
      if (typeof vaultId !== 'string' || !VAULT_ID_RE.test(vaultId)) {
        fail(400, 'bad_vault_id', '非法 vaultId');
      }
      if (typeof authHash !== 'string' || !SHA256_HEX_RE.test(authHash)) {
        fail(400, 'bad_auth_hash', 'authHash 必须是 sha256 hex');
      }
      if (typeof salt !== 'string' || !/^[A-Za-z0-9+/]{21,24}={0,2}$/.test(salt)) {
        fail(400, 'bad_salt', 'salt 必须是 16 字节 base64');
      }
      if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
        fail(400, 'bad_device_id', '非法 deviceId');
      }
      const createdAt = env.now ? env.now() : new Date().toISOString();
      const { created } = await env.store.createVault({ vaultId, authHash, salt, createdAt });
      // 绝不覆盖已有 vault：否则攻击者可用同 vaultId 重置 authHash 接管同步数据
      if (!created) fail(409, 'vault_exists', 'vault 已存在，请用恢复码加入');
      await env.store.registerDevice(vaultId, deviceId, createdAt);
      return jsonResponse({ vaultId, headSeq: INITIAL_SEQ, createdAt }, 201);
    }

    if (segments[1] === 'vaults' && segments.length >= 3) {
      const vaultId = assertVaultId(segments[2]);
      return await handleVaultRoute(request, env, vaultId, segments.slice(3));
    }

    fail(404, 'not_found', '未知同步端点');
  } catch (err) {
    if (err instanceof SyncHttpError) return jsonResponse(errorBody(err), err.status);
    // 不回显内部错误给客户端；只留日志供 wrangler tail 排查
    console.error('[sync-worker] unexpected error', err);
    return jsonResponse({ error: '云端同步服务内部错误', code: 'internal_error' }, 500);
  }
}
