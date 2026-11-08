/**
 * Cloudflare Workers + D1 + R2 客户端适配器（SyncTransport 的云端实现）。
 *
 * 全部协议逻辑在 remote-transport.ts，这里只保留通道名与静态工厂，
 * 保证历史调用方 `CloudflareTransport.createVault / joinVault / attach` 行为不变。
 * 与 CloudBaseTransport、OfflinePackTransport 平级：SyncEngine 只认接口。
 *
 * 部署端见 cloud/sync-worker/；本地无云账号时用 MemorySyncStore + 注入 fetch
 * 即可跑完整协议（test/cloudflare-sync.e2e.test.ts）。
 */

import {
  createJoinInstance,
  RemoteSyncTransport,
  type RemoteJoinOptions,
  type RemoteTransportOptions,
} from './remote-transport';

export {
  MAX_SYNC_BLOB_BYTES,
  normalizeBaseUrl,
  normalizePathPrefix,
  type VaultInfo,
} from './remote-transport';

export type CloudflareTransportOptions = RemoteTransportOptions;
export type JoinVaultOptions = RemoteJoinOptions;

export class CloudflareTransport extends RemoteSyncTransport {
  readonly kind = 'cloudflare';

  static async createVault(opts: CloudflareTransportOptions): Promise<CloudflareTransport> {
    const transport = new CloudflareTransport(opts);
    await transport.bootstrapCreate();
    return transport;
  }

  static async joinVault(opts: JoinVaultOptions): Promise<CloudflareTransport> {
    const transport = createJoinInstance(CloudflareTransport, opts);
    await transport.bootstrapJoin();
    return transport;
  }

  static async attach(opts: CloudflareTransportOptions): Promise<CloudflareTransport> {
    const transport = new CloudflareTransport(opts);
    await transport.bootstrapAttach();
    return transport;
  }
}
