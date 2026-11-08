import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveDataDirs } from './paths';

/**
 * 本地对象存储（内容寻址 blob 层）。
 *
 *   · 业务代码只依赖 BlobStore 接口，将来接云端只需换一个 RemoteBlobStore 实现；
 *   · object key = sha256，本地相对路径与云端 key 是同一个值，接云时零映射；
 *   · 不可变：同名即同内容，幂等重试 / 断点重传 / 天然去重；
 *   · 先写 .tmp 再 rename，校验失败只删临时文件，绝不污染 blobs 目录；
 *   · 磁盘路径只由 64 位 hex 派生，用户输入永远不参与拼路径。
 */
export const MAX_BLOB_BYTES = 20 * 1024 * 1024;
const HEAD_BYTES = 512;
const SHA256_RE = /^[0-9a-f]{64}$/;

export class BlobTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`文件超过 ${Math.floor(maxBytes / 1024 / 1024)}MB 上限`);
    this.name = 'BlobTooLargeError';
  }
}

export class BlobNotFoundError extends Error {
  constructor(sha256: string) {
    super('附件字节不存在');
    this.name = 'BlobNotFoundError';
    void sha256;
  }
}

export interface PutOptions {
  maxBytes?: number;
  /** 写完临时文件后、rename 之前校验文件头；抛错即丢弃临时文件。 */
  validateHeader?: (head: Buffer) => void;
}

export interface PutResult {
  sha256: string;
  bytes: number;
}

export interface BlobStore {
  /** 流式写入，返回内容指纹；相同内容重复写不会新增文件。 */
  put(stream: Readable, opts?: PutOptions): Promise<PutResult>;
  get(sha256: string): Promise<Readable>;
  exists(sha256: string): Promise<boolean>;
  stat(sha256: string): Promise<{ bytes: number } | null>;
  /** 仅供 GC 使用：删除前必须确认没有任何 attachments 行引用该 hash。 */
  remove(sha256: string): Promise<void>;
}

/** Nest DI token：测试 / 云端实现可整体替换。 */
export const BLOB_STORE = 'CAREER_AGENT_BLOB_STORE';

export class LocalBlobStore implements BlobStore {
  readonly root: string;

  constructor(root: string = resolveDataDirs().blobs) {
    this.root = path.resolve(root);
  }

  /** 唯一允许把外部字符串转成磁盘路径的地方。 */
  private pathFor(sha256: string): string {
    if (!SHA256_RE.test(sha256)) throw new Error('非法 sha256：拒绝非内容寻址路径');
    return path.join(this.root, 'sha256', sha256.slice(0, 2), sha256.slice(2));
  }

  private tmpPath(): string {
    return path.join(this.root, '.tmp', randomUUID());
  }

  async put(stream: Readable, opts: PutOptions = {}): Promise<PutResult> {
    const maxBytes = opts.maxBytes ?? MAX_BLOB_BYTES;
    const tmp = this.tmpPath();
    await mkdir(path.dirname(tmp), { recursive: true });

    const hash = createHash('sha256');
    const head: Buffer[] = [];
    let headBytes = 0;
    let bytes = 0;

    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buf.length;
        if (bytes > maxBytes) return cb(new BlobTooLargeError(maxBytes));
        hash.update(buf);
        if (headBytes < HEAD_BYTES) {
          const part = buf.subarray(0, HEAD_BYTES - headBytes);
          head.push(part);
          headBytes += part.length;
        }
        cb(null, buf);
      },
    });

    try {
      await pipeline(stream, meter, createWriteStream(tmp, { flags: 'wx' }));
      if (bytes === 0) throw new Error('空文件');
      opts.validateHeader?.(Buffer.concat(head));
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }

    const digest = hash.digest('hex');
    const dest = this.pathFor(digest);
    await mkdir(path.dirname(dest), { recursive: true });

    if (await this.exists(digest)) {
      await rm(tmp, { force: true }); // 内容寻址去重
    } else {
      try {
        await rename(tmp, dest);
      } catch (e: any) {
        // Windows 下目标已存在可能报 EEXIST/EPERM；并发写同一 hash 内容相同，丢弃临时文件即可。
        if (e?.code === 'EEXIST' || e?.code === 'EPERM') {
          await rm(tmp, { force: true });
        } else {
          await rm(tmp, { force: true }).catch(() => {});
          throw e;
        }
      }
    }
    return { sha256: digest, bytes };
  }

  async get(sha256: string): Promise<Readable> {
    const file = this.pathFor(sha256);
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) throw new BlobNotFoundError(sha256);
    return createReadStream(file);
  }

  async exists(sha256: string): Promise<boolean> {
    const info = await stat(this.pathFor(sha256)).catch(() => null);
    return !!info && info.isFile();
  }

  async stat(sha256: string): Promise<{ bytes: number } | null> {
    const info = await stat(this.pathFor(sha256)).catch(() => null);
    return info && info.isFile() ? { bytes: info.size } : null;
  }

  async remove(sha256: string): Promise<void> {
    await rm(this.pathFor(sha256), { force: true });
  }
}
