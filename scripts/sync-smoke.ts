/**
 * 真实云端点联调（手动运行，不属于测试套件）。两套服务跑同一套 /v1 协议，
 * 用 SYNC_TRANSPORT 切换客户端适配器：
 *
 *   # 腾讯云 CloudBase（HTTP 访问服务，境内直连）
 *   SYNC_TRANSPORT=cloudbase \
 *   SYNC_BASE_URL=https://<env>.ap-shanghai.app.tcloudbase.com \
 *   SYNC_PATH_PREFIX=/sync-api \
 *   npx ts-node scripts/sync-smoke.ts
 *
 *   # Cloudflare（需可达 workers.dev 或自定义域名）
 *   SYNC_TRANSPORT=cloudflare SYNC_BASE_URL=https://<域名> npx ts-node scripts/sync-smoke.ts
 *
 * 可选：SYNC_SKIP_BLOB=1 跳过 blob（对象存储未开通时）；SYNC_RECOVERY_CODE 不传则生成新码并打印。
 * 可重复运行：vault 已存在时自动 attach，push 以当前 head 为 CAS 游标。
 * 云端只留密文与测试 vault，不写任何本地业务库。
 */
import { Readable } from 'node:stream';
import { CloudflareTransport } from '../src/server/sync/cloudflare-transport';
import { CloudBaseTransport } from '../src/server/sync/cloudbase-transport';
import type { RemoteTransportOptions } from '../src/server/sync/remote-transport';
import {
  blobObjectKey,
  deriveVaultKeys,
  generateRecoveryCode,
  openBlob,
  openEvent,
  sealBlob,
  sealEvent,
} from '../src/server/sync/crypto';
import { INITIAL_SEQ, SeqConflictError, type SyncEvent } from '../src/server/sync/transport';

const BASE = process.env.SYNC_BASE_URL;
const PROVIDER = (process.env.SYNC_TRANSPORT || 'cloudflare').trim().toLowerCase();
const PATH_PREFIX = process.env.SYNC_PATH_PREFIX || undefined;
const CODE = process.env.SYNC_RECOVERY_CODE || generateRecoveryCode();
const SKIP_BLOB = process.env.SYNC_SKIP_BLOB === '1';
const INSECURE_TLS = process.env.SYNC_INSECURE_TLS === 'true';
const SHA = 'd'.repeat(64);

type AnyTransport = CloudflareTransport | CloudBaseTransport;

function sample(entityId: string, title: string): SyncEvent {
  return {
    localCursor: '00000170000000000.000000',
    entity: 'resumes',
    entityId,
    op: 'upsert',
    rowHlc: '00000170000000001.000002',
    deviceId: 'smoke-A',
    row: { id: entityId, title },
    blobKeys: [],
  };
}

function options(): RemoteTransportOptions {
  return {
    baseUrl: BASE!,
    pathPrefix: PATH_PREFIX,
    keys: deriveVaultKeys(CODE),
    deviceId: 'smoke-A',
    insecureTls: INSECURE_TLS,
  };
}

async function connect(): Promise<AnyTransport> {
  const opts = options();
  const create = () =>
    PROVIDER === 'cloudbase'
      ? CloudBaseTransport.createVault(opts)
      : CloudflareTransport.createVault(opts);
  const attach = () =>
    PROVIDER === 'cloudbase'
      ? CloudBaseTransport.attach(opts)
      : CloudflareTransport.attach(opts);
  try {
    return await create();
  } catch (err) {
    if (String(err).includes('409') || String(err).includes('vault_exists')) return await attach();
    throw err;
  }
}

function join(): Promise<AnyTransport> {
  const joinOpts = {
    baseUrl: BASE!,
    pathPrefix: PATH_PREFIX,
    recoveryCode: CODE,
    deviceId: 'smoke-B',
    insecureTls: INSECURE_TLS,
  };
  return PROVIDER === 'cloudbase'
    ? CloudBaseTransport.joinVault(joinOpts)
    : CloudflareTransport.joinVault(joinOpts);
}

async function main(): Promise<void> {
  if (!BASE) throw new Error('SYNC_BASE_URL 必填，例如 https://career-agent-sync.xxx.workers.dev');
  const keys = deriveVaultKeys(CODE);
  console.log(
    JSON.stringify({
      provider: PROVIDER,
      baseUrl: BASE,
      pathPrefix: PATH_PREFIX || null,
      vaultId: keys.vaultId,
      recoveryCode: CODE,
      skipBlob: SKIP_BLOB,
    })
  );

  const transport = await connect();
  console.log('[1] health', await transport.ping());
  console.log('[2] head before', await transport.head());

  const head = (await transport.head()).seq;
  const envelopes = [
    sealEvent(keys, sample(`smoke-${Date.now()}`, '真实端点联调 A'), {
      deviceId: 'smoke-A', batchId: `smoke-${Date.now()}`, index: 0,
    }),
    sealEvent(keys, { ...sample(`smoke-delete-${Date.now()}`, ''), op: 'delete', row: null, rowHlc: null }, {
      deviceId: 'smoke-A', batchId: `smoke-${Date.now()}`, index: 1,
    }),
  ];
  const pushed = await transport.push(envelopes, head);
  console.log('[3] push', pushed);

  const pulled = await transport.pull(head);
  console.log('[4] pull', {
    count: pulled.envelopes.length,
    nextSeq: pulled.nextSeq,
    firstTitle: pulled.envelopes[0] ? openEvent(keys, pulled.envelopes[0]).event.row?.title : null,
    secondOp: pulled.envelopes[1] ? openEvent(keys, pulled.envelopes[1]).event.op : null,
  });

  try {
    await transport.push([envelopes[0]], head);
    throw new Error('CAS 冲突没有被拒绝');
  } catch (err) {
    if (!(err instanceof SeqConflictError)) throw err;
    console.log('[5] CAS 冲突', { expected: err.expected, actual: err.actual });
  }

  const deviceB = await join();
  console.log('[6] joinVault', { vaultId: deviceB.vaultId, head: await deviceB.head() });

  if (!SKIP_BLOB) {
    const objectKey = blobObjectKey(keys, SHA);
    const sealed = sealBlob(keys, SHA, Buffer.from(`real ${PROVIDER} blob`));
    await transport.putBlob(objectKey, Readable.from([sealed]), sealed.length);
    const chunks: Buffer[] = [];
    for await (const chunk of await transport.getBlob(objectKey)) chunks.push(Buffer.from(chunk));
    const downloaded = Buffer.concat(chunks);
    console.log('[7] blob', {
      hasBlob: await transport.hasBlob(objectKey),
      bytes: downloaded.length,
      roundTrip: openBlob(keys, SHA, downloaded).toString('utf8'),
    });
  } else {
    console.log('[7] blob 跳过（SYNC_SKIP_BLOB=1）');
  }

  console.log('[done] 全部通过；初始游标校验', INITIAL_SEQ.length === 20);
}

main().catch((err) => {
  console.error('[FAIL]', err);
  process.exitCode = 1;
});
