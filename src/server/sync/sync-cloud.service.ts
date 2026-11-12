import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { DB_TOKEN } from '../../shared/constants';
import type { Database } from '../db/client';
import { syncState } from '../db/schema';
import { BLOB_STORE, type BlobStore } from '../storage/blob-store';
import { deviceId as machineDeviceId } from './device';
import {
  deriveVaultKeys,
  normalizeRecoveryCode,
  withAccountScope,
  type VaultKeys,
} from './crypto';
import { SyncEngine, type SyncStats } from './engine';
import { RemoteSyncTransport } from './remote-transport';
import { INITIAL_SEQ } from './transport';

/**
 * 云同步编排：配置（恢复码 + 账号因子）→ 状态持久化（sync_state）→ 引擎调度。
 *
 * I1 账号隔离：
 *   · 新启用同步用「恢复码 + 账号因子」派生 vaultId/密钥（v2）。账号因子是规范化邮箱，
 *     跨设备稳定（本地 user.id 每台设备都不同，不能用）。不同账号即使填完全相同的
 *     恢复码也会落到不同的云端空间、用不同的密钥，互不干扰。
 *   · 存量 v1 vault 完全由恢复码派生，与账号解耦。升级不重建、不换凭证：
 *     已有 sync_state 的账号继续从 keysJson 恢复原密钥；新设备加入时由
 *     legacyVaultForAccount() 用密文 AAD 里的不透明账号指纹判断归属后沿用。
 *   · 云端三套后端一行未改，仍只认 vaultId + 只存密文，不持有任何账号身份。
 *
 * 密钥安全模型：恢复码只在启用/加入时出现，绝不落库、绝不出现在日志；
 * 落库的是派生密钥（keysJson）——本地磁盘本就是可信边界，云端永远拿不到任何密钥。
 */

/** 认领存量 vault 时探查的事件条数上限（只读 AAD，不解密业务内容）。 */
const LEGACY_PROBE_LIMIT = 200;

/**
 * 存量 vault 归属判定（纯函数，便于直接测试）。
 *
 * 判据是封包 AAD 里的账号隔离指纹（不透明 hex，云端无法反推身份）：
 *   · 出现任何不匹配的指纹 → 已被别的账号认领，返回 false；
 *   · 全部匹配，或一条带指纹的事件都没有（尚未认领）→ 返回 true，
 *     允许当前账号沿用；随后 baselinePush 会推带指纹事件完成认领标记。
 * 这样「两个账号填同一恢复码」不会串进同一个存量空间，而「同一账号换新设备」
 * 仍能读到升级前的全部历史数据。
 */
export function legacyVaultOwnedBy(
  envelopes: Array<{ aad: string }>,
  accountScope?: string
): boolean {
  if (!accountScope) return false;
  for (const envelope of envelopes) {
    let aad: { accountScope?: string };
    try {
      aad = JSON.parse(envelope.aad) as { accountScope?: string };
    } catch {
      return false;
    }
    if (aad.accountScope && aad.accountScope !== accountScope) return false;
  }
  return true;
}

function keysToJson(keys: VaultKeys): Record<string, string> {
  return {
    vaultId: keys.vaultId,
    salt: keys.salt,
    authKey: keys.authKey.toString('base64'),
    encKey: keys.encKey.toString('base64'),
    macKey: keys.macKey.toString('base64'),
    keyVersion: String(keys.keyVersion || 1),
  };
}

function keysFromJson(json: Record<string, string>): VaultKeys {
  const keys: VaultKeys = {
    vaultId: String(json.vaultId || ''),
    salt: String(json.salt || ''),
    authKey: Buffer.from(String(json.authKey || ''), 'base64'),
    encKey: Buffer.from(String(json.encKey || ''), 'base64'),
    macKey: Buffer.from(String(json.macKey || ''), 'base64'),
    keyVersion: json.keyVersion === '2' ? 2 : 1,
  };
  if (!keys.vaultId || keys.authKey.length !== 32 || keys.encKey.length !== 32 || keys.macKey.length !== 32) {
    throw new Error('本地同步密钥损坏：请停用后用恢复码重新启用');
  }
  return keys;
}

export interface SyncStatusDto {
  enabled: boolean;
  vaultId?: string;
  deviceId?: string;
  status?: 'idle' | 'syncing' | 'error' | 'disabled';
  lastError?: string | null;
  lastSyncAt?: string | null;
  pushedCursor?: string;
  pulledSeq?: string;
  baseUrl?: string;
  /** 1 = 存量空间（按账号指纹认领）；2 = 账号绑定空间。 */
  keyVersion?: number;
}

export interface SyncSetupResult {
  mode: 'created' | 'joined';
  recoveryCode: string;
  stats: SyncStats;
  keyVersion: number;
}

@Injectable()
export class SyncCloudService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore
  ) {}

  private transportFor(keys: VaultKeys, device: string): RemoteSyncTransport {
    const baseUrl = process.env.SYNC_BASE_URL || 'https://106.55.30.22';
    const insecureTls = (process.env.SYNC_INSECURE_TLS || 'true').toLowerCase() !== 'false';
    return new RemoteSyncTransport({ baseUrl, keys, deviceId: device, insecureTls });
  }

  /**
   * 存量兼容：判断「升级前的 v1 vault」是否属于当前账号。
   *
   * 不能只凭 vault 存在就加入——那正是「两账号填同一恢复码串数据」的根因。
   * 判据是封包 AAD 里的账号隔离指纹（不透明 hex，云端无法反推身份）：
   *   · 有指纹且全部等于当前账号 → 本账号升级前 / 其他设备的空间，沿用；
   *   · 出现不匹配的指纹         → 已被别的账号认领，拒绝，改用 v2 独立空间；
   *   · 一条带指纹的事件都没有   → 尚未认领的旧空间，允许首个账号认领
   *                               （随后 baselinePush 会推带指纹事件完成标记）。
   * 云端不参与判断、不保存身份，只提供密文与不透明 AAD。
   */
  private async legacyVaultForAccount(
    legacy: VaultKeys,
    device: string
  ): Promise<VaultKeys | null> {
    const transport = this.transportFor(legacy, device);
    try {
      const info = await transport.vaultInfo();
      if (info.salt !== legacy.salt) return null;
      const first = await transport.pull(INITIAL_SEQ, LEGACY_PROBE_LIMIT);
      return legacyVaultOwnedBy(first.envelopes, legacy.accountScope) ? legacy : null;
    } catch {
      // vault 不存在 / 云端不可达 / 授权失败 —— 一律回退到账号绑定的新空间
      return null;
    }
  }

  async status(userId: string): Promise<SyncStatusDto> {
    const rows = await this.db.select().from(syncState).where(eq(syncState.userId, userId)).limit(1);
    const row = rows[0];
    if (!row) return { enabled: false };
    return {
      enabled: true,
      vaultId: row.vaultId,
      deviceId: row.deviceId,
      status: row.status,
      lastError: row.lastError,
      lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
      pushedCursor: row.pushedCursor,
      pulledSeq: row.pulledSeq,
      baseUrl: process.env.SYNC_BASE_URL || 'https://106.55.30.22',
      keyVersion: (row.keysJson as Record<string, string>)?.keyVersion === '2' ? 2 : 1,
    };
  }

  /**
   * 启用同步：恢复码 + 账号因子 → 派生密钥 → 建/加入账号级空间 → 基线全量首传。
   * 恢复码只在响应里回显这一次，前端必须引导用户立即抄写保存。
   *
   * accountKey 必须是规范化邮箱，不能用本地 user.id（跨设备不一致会断掉同步）。
   */
  async enable(
    userId: string,
    recoveryCode: string,
    accountKey: string
  ): Promise<SyncSetupResult> {
    const existing = await this.db
      .select({ userId: syncState.userId })
      .from(syncState)
      .where(eq(syncState.userId, userId))
      .limit(1);
    if (existing.length) {
      throw Object.assign(new Error('同步已启用；如需更换请先停用'), { status: 409 });
    }

    const code = normalizeRecoveryCode(recoveryCode); // 非法格式直接抛错
    const v1 = withAccountScope(deriveVaultKeys(code), accountKey);
    const v2 = withAccountScope(deriveVaultKeys(code, undefined, accountKey), accountKey);
    const device = machineDeviceId();

    // 属于本账号的存量空间优先沿用（历史数据不丢、凭证不必更换）；否则用账号绑定的新空间。
    const legacy = await this.legacyVaultForAccount(v1, device);
    const keys = legacy || v2;
    const transport = this.transportFor(keys, device);
    const mode = await transport.setupVault();

    await this.db.insert(syncState).values({
      userId,
      vaultId: keys.vaultId,
      deviceId: device,
      pushedCursor: '',
      pulledSeq: '0'.repeat(20),
      keysJson: keysToJson(keys),
      status: 'idle',
      knownBlobs: [],
    });

    const engine = new SyncEngine(this.db, this.blobs, transport, keys, device);
    const stats = await engine.syncOnce(userId);
    return { mode, recoveryCode: code, stats, keyVersion: keys.keyVersion || 1 };
  }

  async run(userId: string, accountKey: string): Promise<SyncStats> {
    // 原子抢占：把 status 从「非 syncing」改成 syncing，抢到的行才允许继续。
    // 引擎实例非并发安全（seenRemote / knownBlobs 跨阶段共享），并发请求必须互斥；
    // 用 UPDATE ... WHERE status != 'syncing' 而非「先读再判」，杜绝两请求同读 idle 的竞态。
    const claimed = await this.db
      .update(syncState)
      .set({ status: 'syncing', lastError: null })
      .where(and(eq(syncState.userId, userId), ne(syncState.status, 'syncing')))
      .returning({ userId: syncState.userId, keysJson: syncState.keysJson, deviceId: syncState.deviceId });
    const row = claimed[0];
    if (!row) {
      const exists = await this.db
        .select({ userId: syncState.userId })
        .from(syncState)
        .where(eq(syncState.userId, userId))
        .limit(1);
      if (!exists.length) {
        throw Object.assign(new Error('同步未启用'), { status: 404 });
      }
      throw Object.assign(new Error('同步正在进行中，请稍候'), { status: 409 });
    }

    // 从存量 keysJson 恢复的密钥没有账号指纹，这里按当前账号重算后附加：
    // 升级后的存量 vault 因此会自动打上归属标记，供新设备加入时认领。
    const keys = withAccountScope(keysFromJson(row.keysJson), accountKey);
    const transport = this.transportFor(keys, row.deviceId);
    const engine = new SyncEngine(this.db, this.blobs, transport, keys, row.deviceId);
    return engine.syncOnce(userId);
  }

  /** 停用：只清配置与游标，本地业务数据与已下载附件全部保留（local-first）。 */
  async disable(userId: string): Promise<{ ok: true }> {
    await this.db.delete(syncState).where(eq(syncState.userId, userId));
    return { ok: true };
  }
}
