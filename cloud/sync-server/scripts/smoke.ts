/**
 * 同步服务端集成冒烟：把 SqliteSyncStore + 真实 Node HTTP 入口在随机回环端口跑起来，
 * 用主项目同一套加密 / 通用 RemoteSyncTransport 跑完整协议。
 *
 * 既能在本地证明服务端在 Node 上完全可用，也能在服务器部署后作为 `npm run smoke` 自检。
 *
 * 用法（在 cloud/sync-server 目录下）：
 *   BASE_URL=http://127.0.0.1:8788   npm run smoke     # 对已在运行的部署做远端自检
 *   npm run smoke                                    # 自带内存级 SQLite 起本地服务做全链路验证
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { SqliteSyncStore } from '../src/sqlite-store';
import { createSyncServer } from '../src/server';
import {
  authVerifier,
  blobObjectKey,
  deriveVaultKeys,
  generateRecoveryCode,
  openBlob,
  openEvent,
  sealBlob,
  sealEvent,
} from '../../../src/server/sync/crypto';
import { RemoteSyncTransport } from '../../../src/server/sync/remote-transport';
import { INITIAL_SEQ, SeqConflictError, SYNC_PROTOCOL_VERSION } from '../../../src/server/sync/transport';

function assert(cond: unknown, label: string): void {
  if (!cond) throw new Error(`冒烟失败：${label}`);
  console.log(`  ✓ ${label}`);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

async function withLocalServer(fn: (base: string) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ca-sync-smoke-'));
  const store = new SqliteSyncStore(
    path.join(dataDir, 'sync.db'),
    path.join(dataDir, 'blobs')
  );
  const server = createSyncServer(store);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    server.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function bootstrapCreate(base: string, keys: ReturnType<typeof deriveVaultKeys>): Promise<void> {
  const res = await fetch(`${base}/v1/vaults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      vaultId: keys.vaultId,
      authHash: authVerifier(keys),
      salt: keys.salt,
      deviceId: 'device-A',
    }),
  });
  if (res.status !== 201) throw new Error(`创建 vault 失败 HTTP ${res.status}`);
}

async function run(base: string): Promise<void> {
  const code = generateRecoveryCode();
  const keys = deriveVaultKeys(code);

  console.log('[1] 部署自检 health');
  const ping = await fetch(`${base}/v1/health`).then((r) => r.json());
  assert(ping.ok && ping.v === SYNC_PROTOCOL_VERSION, 'health 返回 ok 且协议版本一致');

  console.log('[2] 创建 vault（第一台设备）');
  await bootstrapCreate(base, keys);
  const transport = new RemoteSyncTransport({ baseUrl: base, keys, deviceId: 'device-A' });

  console.log('[3] head 初始游标');
  const head0 = await transport.head();
  assert(head0.seq === INITIAL_SEQ, 'head 为初始 seq');

  console.log('[4] 推送两个加密事件 + 拉取解密还原中文');
  const e1 = sealEvent(
    keys,
    { entity: 'resume', entityId: 'r1', op: 'upsert', payload: { name: '陈培胜' } },
    { deviceId: 'device-A', batchId: 'b1', index: 0 }
  );
  const e2 = sealEvent(
    keys,
    { entity: 'resume', entityId: 'r2', op: 'upsert', payload: { name: '中文测试内容' } },
    { deviceId: 'device-A', batchId: 'b1', index: 1 }
  );
  const pushRes = await transport.push([e1, e2], INITIAL_SEQ);
  assert(pushRes.accepted === 2 && /^\d{20}$/.test(pushRes.nextSeq), 'push 接受 2 条并回写服务端 seq');

  const pulled = await transport.pull(INITIAL_SEQ);
  assert(pulled.envelopes.length === 2, 'pull 返回 2 条');
  const opened = openEvent(keys, pulled.envelopes[1]);
  assert(opened.event.payload.name === '中文测试内容', '拉取后解密还原中文明文');
  assert(pulled.envelopes[1].ciphertext !== JSON.stringify(opened.event), '云端只存密文，ciphertext ≠ 明文');

  console.log('[5] CAS 冲突：用落后游标 push 必须 409');
  let conflicted = false;
  try {
    await transport.push([e1], INITIAL_SEQ);
  } catch (err) {
    conflicted = err instanceof SeqConflictError;
  }
  assert(conflicted, '落后游标 push 抛 SeqConflictError');

  console.log('[6] blob 加密往返');
  const sha = 'd'.repeat(64);
  const blobPlain = Buffer.from('二进制 blob 内容 中文 🗂️');
  const sealed = sealBlob(keys, sha, blobPlain);
  await transport.putBlob(blobObjectKey(keys, sha), Readable.from([sealed]), sealed.length);
  const got = await transport.getBlob(blobObjectKey(keys, sha));
  const buf = await streamToBuffer(got);
  assert(openBlob(keys, sha, buf).equals(blobPlain), 'blob 上传下载解密后字节一致');

  console.log('[6.5] blob 删除（云端引用计数 GC）');
  const key = blobObjectKey(keys, sha);
  assert(await transport.hasBlob(key), '删除前 hasBlob 为 true');
  await transport.deleteBlob(key);
  assert(!(await transport.hasBlob(key)), 'deleteBlob 后 hasBlob 为 false');
  await transport.deleteBlob(key); // 幂等：重复删除不报错
  assert(true, '重复 deleteBlob 幂等');

  console.log('[7] 跨 vault 隔离');
  const keys2 = deriveVaultKeys(generateRecoveryCode());
  await bootstrapCreate(base, keys2);
  const transport2 = new RemoteSyncTransport({ baseUrl: base, keys: keys2, deviceId: 'device-B' });
  const head2 = await transport2.head();
  assert(head2.seq === INITIAL_SEQ, '另一个 vault 独立游标，互不干扰');

  console.log('[8] 未授权访问必须 401');
  const unauth = await fetch(`${base}/v1/vaults/${keys.vaultId}/head`);
  assert(unauth.status === 401, '无 X-CA-Auth 头返回 401');

  console.log('\n全部冒烟用例通过 ✅');
}

async function main(): Promise<void> {
  const base = process.env.BASE_URL;
  if (base) {
    console.log(`对已在运行的同步服务自检：${base}`);
    await run(base);
  } else {
    console.log('本地起临时 SQLite + HTTP 服务做全链路验证');
    await withLocalServer(run);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
