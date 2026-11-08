import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  assertObjectKey,
  formatSeq,
  INITIAL_SEQ,
  nextSeq,
  parseSeq,
  SeqConflictError,
  SYNC_PROTOCOL_VERSION,
  type SyncEnvelope,
  type SyncPullResult,
  type SyncPushResult,
  type SyncTransport,
} from './transport';

/**
 * 离线增量包：SyncTransport 的参考实现，也是「先不接任何云」的可交付方案。
 *
 * 目录即协议（整个目录拷进任意网盘 / U 盘 / WebDAV 即可）：
 *   manifest.json             vaultId / 当前 seq / 计数
 *   events/<20位seq>.json     加密事件封包，定长文件名 → 字典序即事件顺序
 *   blobs/<objectKey>.bin     已加密的 blob 字节，key 由 HMAC 派生
 *
 * 它是「哑云」的本地镜像：同样只分配 seq、只存密文、绝不解析业务内容，
 * 换云厂商时 SyncEngine 一行不改，只把 SyncTransport 换成 HTTP 实现。
 */

interface PackManifest {
  v: typeof SYNC_PROTOCOL_VERSION;
  vaultId: string;
  seq: string;
  createdAt: string;
  updatedAt: string;
  events: number;
  blobs: number;
}

const SEQ_FILE_RE = /^\d{20}\.json$/;

export class OfflinePackTransport implements SyncTransport {
  readonly kind = 'offline-pack';

  private constructor(
    readonly root: string,
    private manifest: PackManifest
  ) {}

  private get eventsDir(): string {
    return path.join(this.root, 'events');
  }

  private get blobsDir(): string {
    return path.join(this.root, 'blobs');
  }

  private get manifestPath(): string {
    return path.join(this.root, 'manifest.json');
  }

  /** 新建一个空包；vaultId 由恢复码派生，包内不含任何密钥材料。 */
  static async create(root: string, vaultId: string): Promise<OfflinePackTransport> {
    if (!/^[0-9a-f]{32}$/.test(vaultId)) throw new Error('非法 vaultId');
    await mkdir(path.join(root, 'events'), { recursive: true });
    await mkdir(path.join(root, 'blobs'), { recursive: true });
    const now = new Date().toISOString();
    const manifest: PackManifest = {
      v: SYNC_PROTOCOL_VERSION,
      vaultId,
      seq: INITIAL_SEQ,
      createdAt: now,
      updatedAt: now,
      events: 0,
      blobs: 0,
    };
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return new OfflinePackTransport(path.resolve(root), manifest);
  }

  /** 打开另一台设备拷来的包；manifest 缺失或损坏直接拒绝，不猜。 */
  static async open(root: string): Promise<OfflinePackTransport> {
    const raw = await readFile(path.join(root, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw) as PackManifest;
    if (manifest.v !== SYNC_PROTOCOL_VERSION || !/^\d{20}$/.test(manifest.seq || '')) {
      throw new Error('增量包版本或序号非法');
    }
    await mkdir(path.join(root, 'events'), { recursive: true });
    await mkdir(path.join(root, 'blobs'), { recursive: true });
    return new OfflinePackTransport(path.resolve(root), manifest);
  }

  /** 每次重新读盘：包可能被另一台设备/网盘同步覆盖，不能只信内存里的副本。 */
  private async current(): Promise<PackManifest> {
    const raw = await readFile(this.manifestPath, 'utf8');
    this.manifest = JSON.parse(raw) as PackManifest;
    return this.manifest;
  }

  private async save(manifest: PackManifest): Promise<void> {
    const tmp = path.join(this.root, `.manifest.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
    await rename(tmp, this.manifestPath);
    this.manifest = manifest;
  }

  get vaultId(): string {
    return this.manifest.vaultId;
  }

  async head(): Promise<{ seq: string }> {
    return { seq: (await this.current()).seq };
  }

  /**
   * CAS 推送：expectedSeq 落后立刻抛 SeqConflictError，客户端先 pull 重放再重试。
   * 先写事件文件、最后原子更新 manifest：中途失败只会留下 > seq 的孤儿文件，
   * pull 只认 manifest.seq 以内，绝不把半成品同步出去。
   */
  async push(envelopes: SyncEnvelope[], expectedSeq: string): Promise<SyncPushResult> {
    const manifest = await this.current();
    if (expectedSeq !== manifest.seq) {
      throw new SeqConflictError(expectedSeq, manifest.seq);
    }
    let seq = manifest.seq;
    for (const envelope of envelopes) {
      if (envelope.vaultId !== manifest.vaultId) throw new Error('封包 vaultId 与增量包不匹配');
      seq = nextSeq(seq);
      envelope.seq = seq;
      const dest = path.join(this.eventsDir, `${seq}.json`);
      const tmp = path.join(this.eventsDir, `.${seq}.${randomUUID()}.tmp`);
      await writeFile(tmp, JSON.stringify(envelope), 'utf8');
      await rename(tmp, dest);
    }
    await this.save({
      ...manifest,
      seq,
      updatedAt: new Date().toISOString(),
      events: manifest.events + envelopes.length,
    });
    return { accepted: envelopes.length, nextSeq: seq };
  }

  async pull(sinceSeq: string, limit = 500): Promise<SyncPullResult> {
    const upper = (await this.current()).seq;
    const since = parseSeq(sinceSeq || INITIAL_SEQ);
    const upperN = parseSeq(upper);
    const names = (await readdir(this.eventsDir))
      .filter((n) => SEQ_FILE_RE.test(n))
      .map((n) => n.slice(0, -5))
      .filter((s) => {
        const n = parseSeq(s);
        return n > since && n <= upperN;
      })
      .sort()
      .slice(0, Math.min(Math.max(1, limit), 1000));

    const envelopes: SyncEnvelope[] = [];
    for (const seq of names) {
      envelopes.push(JSON.parse(await readFile(path.join(this.eventsDir, `${seq}.json`), 'utf8')));
    }
    return {
      envelopes,
      nextSeq: envelopes.length ? envelopes[envelopes.length - 1].seq : formatSeq(upperN),
    };
  }

  private blobPath(objectKey: string): string {
    return path.join(this.blobsDir, `${assertObjectKey(objectKey)}.bin`);
  }

  /** 密文字节；同 key 重复写幂等（内容寻址，中断重传不会产生脏副本）。 */
  async putBlob(objectKey: string, stream: Readable, bytes: number): Promise<void> {
    assertObjectKey(objectKey);
    const dest = this.blobPath(objectKey);
    const info = await stat(dest).catch(() => null);
    if (info?.isFile() && info.size === bytes) {
      stream.resume(); // 消费掉输入，避免上游 backpressure 卡住
      return;
    }
    const tmp = path.join(this.blobsDir, `.${randomUUID()}.tmp`);
    try {
      await pipeline(stream, createWriteStream(tmp, { flags: 'wx' }));
      const written = await stat(tmp);
      if (written.size !== bytes) throw new Error('blob 字节数与声明不一致');
      await rename(tmp, dest);
      const manifest = await this.current();
      if (!info?.isFile()) {
        await this.save({ ...manifest, blobs: manifest.blobs + 1, updatedAt: new Date().toISOString() });
      }
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  async getBlob(objectKey: string): Promise<Readable> {
    const dest = this.blobPath(objectKey);
    const info = await stat(dest).catch(() => null);
    if (!info?.isFile()) throw new Error('云端 blob 不存在，请先同步');
    return createReadStream(dest);
  }

  async hasBlob(objectKey: string): Promise<boolean> {
    const info = await stat(this.blobPath(objectKey)).catch(() => null);
    return !!info?.isFile();
  }

  /** 供 UI / 排障展示的包统计，不参与协议判定。 */
  async info(): Promise<{ vaultId: string; seq: string; events: number; blobs: number }> {
    const m = await this.current();
    return { vaultId: m.vaultId, seq: m.seq, events: m.events, blobs: m.blobs };
  }
}
