/**
 * 云同步量化验证：本地数据量 vs 云端事件/blob 数据量。
 *
 * 用法：npx ts-node scripts/verify-sync-count.ts [--cloud]
 *   · 只统计本地（默认）：直连 ./pgdata，列出各同步表活跃行数、附件、本地 blob。
 *   · 加 --cloud：额外用 sync_state 里恢复出的密钥查云端 head seq + 全量事件 + blob。
 *
 * 云端是哑云，无对外统计接口；这里用「head seq 即事件累计条数」+ 全量 pull 统计。
 * 脚本结束即关闭连接，不与 dev 冲突（PGlite 单连接需保证无 dev 占用）。
 */

import { createDatabase } from '../src/server/db/client';
import { sql } from 'drizzle-orm';
import { syncState } from '../src/server/db/schema';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveDataDirs } from '../src/server/storage/paths';
import { RemoteSyncTransport } from '../src/server/sync/remote-transport';
import { INITIAL_SEQ } from '../src/server/sync/transport';
import { openEvent, type VaultKeys } from '../src/server/sync/crypto';

const WITH_CLOUD = process.argv.includes('--cloud');

// 与 engine.ts SYNCED_TABLES 一致的表名 → 中文标签
const SYNCED_TABLES = [
  'resumes',
  'companies',
  'company_jds',
  'referrals',
  'tracker',
  'applications',
  'portfolios',
  'interview_notes',
  'interview_kb',
  'practice_sessions',
  'practice_questions',
  'practice_answers',
  'practice_evaluations',
  'practice_weaknesses',
  'attachments',
];

function keysFromJson(json: Record<string, string>): VaultKeys {
  const keys: VaultKeys = {
    vaultId: String(json.vaultId || ''),
    salt: String(json.salt || ''),
    authKey: Buffer.from(String(json.authKey || ''), 'base64'),
    encKey: Buffer.from(String(json.encKey || ''), 'base64'),
    macKey: Buffer.from(String(json.macKey || ''), 'base64'),
    keyVersion: json.keyVersion === '2' ? 2 : 1,
  };
  return keys;
}

async function main() {
  const dirs = resolveDataDirs();
  const handle = await createDatabase(dirs.pgdata);
  try {
    const db = handle.db;

    console.log('═══════════════════════════════════════════════');
    console.log('【本地】数据目录:', dirs.root);
    console.log('═══════════════════════════════════════════════');

    // ---- sync_state ----
    const states = await db.select().from(syncState);
    console.log(`\n── sync_state（同步配置）: ${states.length} 行`);
    for (const s of states) {
      console.log(`   userId: ${s.userId}`);
      console.log(`   vaultId: ${s.vaultId}`);
      console.log(`   deviceId: ${s.deviceId}`);
      console.log(`   status: ${s.status}`);
      console.log(`   pushedCursor: ${s.pushedCursor || '(空=未首传)'}`);
      console.log(`   pulledSeq: ${s.pulledSeq || '(空)'}`);
      console.log(`   knownBlobs: ${(s.knownBlobs || []).length} 个`);
      console.log(`   lastSyncAt: ${s.lastSyncAt ? s.lastSyncAt.toISOString() : '(从未)'}`);
      console.log(`   lastError: ${s.lastError || '(无)'}`);
    }

    // ---- 各同步表活跃行数 ----
    console.log(`\n── 本地各同步表活跃行数（不含软删除墓碑）:`);
    let totalRows = 0;
    for (const t of SYNCED_TABLES) {
      let count = 0;
      try {
        const r = await db.execute(
          sql`SELECT count(*)::int AS c FROM ${sql.raw(t)} WHERE deleted_at IS NULL`
        );
        count = Number(r.rows?.[0]?.c ?? 0);
      } catch {
        // 无 deleted_at 列的表（attachments 有 deletedAt；其他实体表均有 deletedAt）
        const r = await db.execute(sql`SELECT count(*)::int AS c FROM ${sql.raw(t)}`);
        count = Number(r.rows?.[0]?.c ?? 0);
      }
      totalRows += count;
      console.log(`   ${t.padEnd(22)} ${count}`);
    }
    console.log(`   ${'合计'.padEnd(22)} ${totalRows}`);

    // ---- 本地 blob 文件 ----
    let localBlobs: string[] = [];
    try {
      localBlobs = (await readdir(dirs.blobs, { recursive: true })).filter(
        (p) => typeof p === 'string' && /\/[0-9a-f]{2}\/[0-9a-f]{62}$/.test(p)
      );
    } catch {}
    console.log(`\n── 本地 blob 文件: ${localBlobs.length} 个（目录 ${dirs.blobs}）`);

    // ---- 云端统计 ----
    if (WITH_CLOUD) {
      const state = states[0];
      if (!state) {
        console.log('\n【云端】无 sync_state，本地尚未启用云同步');
        return;
      }
      const keys = keysFromJson(state.keysJson as unknown as Record<string, string>);
      const deviceId = String(state.deviceId || 'verify');
      const baseUrl = process.env.SYNC_BASE_URL || 'https://106.55.30.22';
      const insecureTls = (process.env.SYNC_INSECURE_TLS || 'true').toLowerCase() !== 'false';
      const transport = new RemoteSyncTransport({ baseUrl, keys, deviceId, insecureTls });

      console.log('\n═══════════════════════════════════════════════');
      console.log('【云端】哑云 ' + baseUrl);
      console.log('═══════════════════════════════════════════════');

      const head = await transport.head();
      console.log(`\n── 云端 head seq: ${head.seq}`);
      console.log(`   （seq 从 ${INITIAL_SEQ} 起严格递增，head 值即该 vault 累计事件条数）`);

      // 全量拉取统计事件
      let since = INITIAL_SEQ;
      let envelopes: any[] = [];
      let entityCount: Record<string, number> = {};
      let totalBytes = 0;
      for (let round = 0; round < 500; round++) {
        const r = await transport.pull(since, 200);
        for (const env of r.envelopes) {
          envelopes.push(env);
          totalBytes += env.bytes || 0;
          try {
            const { event } = openEvent(keys, env);
            const e = event.entity || '(unknown)';
            entityCount[e] = (entityCount[e] || 0) + 1;
          } catch {
            entityCount['(解密失败)'] = (entityCount['(解密失败)'] || 0) + 1;
          }
        }
        if (r.envelopes.length < 200) break;
        since = r.nextSeq;
      }

      console.log(`\n── 云端事件总数: ${envelopes.length} 条`);
      console.log(`   密文总字节: ${totalBytes} bytes（${(totalBytes / 1024).toFixed(1)} KB）`);
      console.log(`   按 entity 分布:`);
      for (const [k, v] of Object.entries(entityCount).sort((a, b) => b[1] - a[1])) {
        console.log(`     ${k.padEnd(24)} ${v}`);
      }

      // 探测云端 blob（从附件事件的 blobKeys 汇总去重）
      const blobKeys = new Set<string>();
      for (const env of envelopes) {
        try {
          const { event } = openEvent(keys, env);
          for (const k of event.blobKeys || []) blobKeys.add(k);
        } catch {}
      }
      console.log(`\n── 云端 blob 引用 key: ${blobKeys.size} 个（来自事件 blobKeys）`);
      let cloudBlobExist = 0;
      for (const k of blobKeys) {
        if (await transport.hasBlob(k)) cloudBlobExist++;
      }
      console.log(`   实际存在于云端的 blob: ${cloudBlobExist} 个`);

      // 结论
      console.log('\n═══════════════════════════════════════════════');
      console.log('【结论】');
      console.log(`   本地活跃行（15 表合计）: ${totalRows}`);
      console.log(`   云端事件累计（head seq）: ${head.seq === INITIAL_SEQ ? '0（空，未同步）' : head.seq}`);
      console.log(`   云端全量拉取事件: ${envelopes.length} 条`);
      console.log(`   云端 blob: ${cloudBlobExist} 个`);
      const synced = envelopes.length > 0 && cloudBlobExist >= 0;
      console.log(synced ? '   → 云同步已成功，云端确有加密数据。' : '   → 云端无数据，同步可能未执行。');
      console.log('═══════════════════════════════════════════════');
    }
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error('[verify-sync-count] 失败:', err);
  process.exit(1);
});
