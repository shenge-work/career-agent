import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { TenantDb } from '../tenant/tenant-db';
import { BLOB_STORE, type BlobStore } from '../storage/blob-store';
import { detectMime, safeOriginalName } from '../storage/mime';
import type { AttachmentRow } from '../db/schema';
import { hlcClock } from '../sync/hlc';
import { deviceId } from '../sync/device';

/**
 * 本地附件服务（local-first，可同步版）。
 *
 * 字节 → BlobStore（内容寻址，可整体替换为云端实现）；
 * 元数据 + 归属 + 变更日志 → PG，全部经 TenantDb.forUser(userId)，跨用户 404。
 * 每次写（含软删除）都在同一事务里记一条 change_log，供未来云同步按 hlc 游标拉增量。
 */
@Injectable()
export class AttachmentService {
  constructor(
    @Inject(TenantDb) private readonly tenant: TenantDb,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore
  ) {}

  private t(userId: string) {
    return this.tenant.forUser(userId);
  }

  private syncMeta() {
    return { hlc: hlcClock.next(), deviceId: deviceId() };
  }

  /** 流式上传：先落 blob（校验文件头），再入库 + 记 outbox。 */
  async upload(
    userId: string,
    stream: Readable,
    rawName: string,
    owner: { ownerType?: string; ownerId?: string } = {}
  ) {
    let mime = '';
    const result = await this.blobs.put(stream, {
      validateHeader: (head) => {
        const detected = detectMime(head);
        if (!detected) throw new BadRequestException('不支持的文件类型');
        mime = detected.mime;
      },
    });

    const { hlc, deviceId: dev } = this.syncMeta();
    const id = 'att_' + randomBytes(9).toString('hex');
    const originalName = safeOriginalName(rawName);
    const ownerType = owner.ownerType?.slice(0, 40) || null;
    const ownerId = owner.ownerId?.slice(0, 120) || null;

    const rows = await this.t(userId).insertAttachmentWithChange(
      {
        id,
        sha256: result.sha256,
        mime,
        bytes: result.bytes,
        originalName,
        ownerType,
        ownerId,
        syncState: 'local',
        remoteKey: null,
        hlc,
        deviceId: dev,
      },
      {
        userId,
        entity: 'attachments',
        entityId: id,
        op: 'upsert',
        hlc,
        deviceId: dev,
        payload: {
          sha256: result.sha256,
          mime,
          bytes: result.bytes,
          originalName,
          ownerType,
          ownerId,
          syncState: 'local',
        },
      }
    );
    return rows[0];
  }

  list(userId: string, filter: { ownerType?: string; ownerId?: string } = {}) {
    return this.t(userId).listAttachments(filter);
  }

  async get(userId: string, id: string) {
    const rows = await this.t(userId).getAttachment(id);
    if (!rows.length) throw new NotFoundException('附件不存在');
    return rows[0];
  }

  /** 读取字节前先做归属校验；blob 流只从 sha256 派生路径，不接受用户输入路径。 */
  async open(userId: string, id: string): Promise<{ row: AttachmentRow; stream: Readable }> {
    const row = await this.get(userId, id);
    const stream = await this.blobs.get(row.sha256);
    return { row, stream };
  }

  /** 软删除：只写墓碑 + outbox，绝不直接删 blob（跨设备/云端引用可能还在）。 */
  async remove(userId: string, id: string) {
    const { hlc, deviceId: dev } = this.syncMeta();
    const rows = await this.t(userId).softDeleteAttachmentWithChange(id, {
      userId,
      entity: 'attachments',
      entityId: id,
      op: 'delete',
      hlc,
      deviceId: dev,
      payload: { deletedAt: new Date().toISOString() },
    });
    if (!rows.length) throw new NotFoundException('附件不存在');
    return { ok: true, hlc, deletedAt: rows[0].deletedAt };
  }

  /** 同步增量：云端 / 另一台设备按 nextCursor 续拉。 */
  async changes(userId: string, since = '', limit = 500) {
    const rows = await this.t(userId).listChangesSince(since || '', limit);
    return {
      changes: rows,
      nextCursor: rows.length ? rows[rows.length - 1].hlc : since || '',
    };
  }
}
