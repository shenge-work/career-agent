import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB_TOKEN } from '../../shared/constants';
import type { Database } from '../db/client';
import { syncState } from '../db/schema';
import { BLOB_STORE, type BlobStore } from '../storage/blob-store';
import { deviceId as machineDeviceId } from './device';
import { deriveVaultKeys, normalizeRecoveryCode, type VaultKeys } from './crypto';
import { SyncEngine, type SyncStats } from './engine';
import { RemoteSyncTransport } from './remote-transport';

/**
 * 云同步编排：配置（恢复码）→ 状态持久化（sync_state）→ 引擎调度。
 *
 * 密钥安全模型：
 *   · 恢复码只在「启用 / 另一台设备加入」时出现，绝不落库、绝不出现在日志；
 *   · scrypt 单向，落库的是派生密钥（keysJson）——本机磁盘本就是可信边界
 *     （攻击者能读 sync_state 就能读整个 pgdata），云端永远拿不到任何密钥；
 *   · 换设备 / 重装后必须手抄恢复码重新加入，这是 E2EE 的代价也是保证。
 *
 * 通道配置：SYNC_BASE_URL（默认已部署的自建服务），SYNC_INSECURE_TLS
 * （自签名证书时为 true；换成受信域名 + 正式证书后务必改回 false）。
 */

function keysToJson(keys: VaultKeys): Record<string, string> {
  return {
    vaultId: keys.vaultId,
    salt: keys.salt,
    authKey: keys.authKey.toString('base64'),
    encKey: keys.encKey.toString('base64'),
    macKey: keys.macKey.toString('base64'),
  };
}

function keysFromJson(json: Record<string, string>): VaultKeys {
  const keys: VaultKeys = {
    vaultId: String(json.vaultId || ''),
    salt: String(json.salt || ''),
    authKey: Buffer.from(String(json.authKey || ''), 'base64'),
    encKey: Buffer.from(String(json.encKey || ''), 'base64'),
    macKey: Buffer.from(String(json.macKey || ''), 'base64'),
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
}

export interface SyncSetupResult {
  mode: 'created' | 'joined';
  recoveryCode: string;
  stats: SyncStats;
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
    };
  }

  /**
   * 启用同步：恢复码 → 派生密钥 → 建 vault（或加入）→ 基线全量首传。
   * 恢复码只在响应里回显这一次，前端必须引导用户立即抄写保存。
   */
  async enable(userId: string, recoveryCode: string): Promise<SyncSetupResult> {
    const existing = await this.db
      .select({ userId: syncState.userId })
      .from(syncState)
      .where(eq(syncState.userId, userId))
      .limit(1);
    if (existing.length) {
      throw Object.assign(new Error('同步已启用；如需更换请先停用'), { status: 409 });
    }

    const code = normalizeRecoveryCode(recoveryCode); // 非法格式直接抛错
    const keys = deriveVaultKeys(code);
    const device = machineDeviceId();
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
    return { mode, recoveryCode: code, stats };
  }

  async run(userId: string): Promise<SyncStats> {
    const rows = await this.db.select().from(syncState).where(eq(syncState.userId, userId)).limit(1);
    const row = rows[0];
    if (!row) {
      throw Object.assign(new Error('同步未启用'), { status: 404 });
    }
    if (row.status === 'syncing') {
      throw Object.assign(new Error('同步正在进行中，请稍候'), { status: 409 });
    }
    const keys = keysFromJson(row.keysJson);
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
