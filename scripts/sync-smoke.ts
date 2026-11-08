/**
 * 真实 Cloudflare 端点联调（手动运行，不属于测试套件）：
 *   SYNC_BASE_URL=https://career-agent-sync.<subdomain>.workers.dev \
 *   SYNC_RECOVERY_CODE=<恢复码> npx ts-node scripts/sync-smoke.ts
 *
 * 可选：SYNC_SKIP_BLOB=1 跳过 blob（R2 未开通时）；SYNC_RECOVERY_CODE 不传则生成新码并打印。
 * 可重复运行：vault 已存在时自动 attach，push 以当前 head 为 CAS 游标。
 * 云端只留密文与测试 vault，不写任何本地业务库。
 */
import { Readable } from 'node:stream';
import { CloudflareTransport } from '../src/server/sync/cloudflare-transport';
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
const CODE = process.env.SYNC_RECOVERY_CODE || generateRecoveryCode();
const SKIP_BLOB = process.env.SYNC_SKIP_BLOB === '1';
const SHA = 'd'.repeat(64);

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

async function connect() {
  const keys = deriveVaultKeys(CODE);
  const opts = { baseUrl: BASE!, keys, deviceId: 'smoke-A' };
  try {
    return await CloudflareTransport.createVault(opts);
  } catch (err) {
    if (String(err).includes('409') || String(err).includes('vault_exists')) {
      return await CloudflareTransport.attach(opts);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  if (!BASE) throw new Error('SYNC_BASE_URL 必填，例如 https://career-agent-sync.xxx.workers.dev');
  const keys = deriveVaultKeys(CODE);
  console.log(JSON.stringify({ baseUrl: BASE, vaultId: keys.vaultId, recoveryCode: CODE, skipBlob: SKIP_BLOB }));

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

  const deviceB = await CloudflareTransport.joinVault({
    baseUrl: BASE,
    recoveryCode: CODE,
    deviceId: 'smoke-B',
  });
  console.log('[6] joinVault', { vaultId: deviceB.vaultId, head: await deviceB.head() });

  if (!SKIP_BLOB) {
    const objectKey = blobObjectKey(keys, SHA);
    const sealed = sealBlob(keys, SHA, Buffer.from('real cloudflare R2 blob'));
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
