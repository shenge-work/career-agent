/**
 * 腾讯云 CloudBase 客户端适配器（SyncTransport 的境内通道实现）。
 *
 * 与 CloudflareTransport 共用 remote-transport.ts 的全部协议逻辑，只是：
 *   · kind = 'cloudbase'；
 *   · 支持 HTTP 访问服务的函数路径前缀（服务端 pathToV1() 自动剥离）；
 *   · 提供从环境变量读取连接参数的便捷入口，密钥只留在本机内存。
 *
 * 服务端见 cloud/sync-cloudbase/。本轮只做代码 + 本地模拟，未创建云资源、未部署。
 */

import type { VaultKeys } from './crypto';
import {
  createJoinInstance,
  RemoteSyncTransport,
  normalizePathPrefix,
  type RemoteJoinOptions,
  type RemoteTransportOptions,
} from './remote-transport';

export type CloudBaseTransportOptions = RemoteTransportOptions;
export type CloudBaseJoinOptions = RemoteJoinOptions;

export interface CloudBaseEndpoint {
  baseUrl: string;
  pathPrefix?: string;
  extraHeaders?: Record<string, string>;
}

export interface CloudBaseEnvOptions {
  keys: VaultKeys;
  deviceId: string;
  fetchImpl?: typeof fetch;
  /** 测试可注入；默认读 process.env。 */
  env?: Record<string, string | undefined>;
}

/**
 * 从本机环境读取连接参数。绝不读任何密钥材料——同步密钥来自恢复码派生的 VaultKeys，
 * 由调用方在内存里传入；这里只有服务端地址与网关路径。
 */
export function cloudBaseConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): CloudBaseEndpoint {
  const baseUrl = (env.TCB_SYNC_BASE_URL || '').trim();
  if (!baseUrl) throw new Error('未配置 TCB_SYNC_BASE_URL（CloudBase HTTP 访问服务地址）');
  const pathPrefix = normalizePathPrefix((env.TCB_SYNC_PATH_PREFIX || '').trim() || undefined);

  let extraHeaders: Record<string, string> | undefined;
  const rawHeaders = (env.TCB_SYNC_EXTRA_HEADERS || '').trim();
  if (rawHeaders) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawHeaders);
    } catch {
      throw new Error('TCB_SYNC_EXTRA_HEADERS 不是合法 JSON 对象');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('TCB_SYNC_EXTRA_HEADERS 必须是字符串到字符串的对象');
    }
    extraHeaders = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') throw new Error('TCB_SYNC_EXTRA_HEADERS 的值必须是字符串');
      extraHeaders[key] = value;
    }
  }
  return { baseUrl, pathPrefix, extraHeaders };
}

export function cloudBaseOptionsFromEnv(opts: CloudBaseEnvOptions): RemoteTransportOptions {
  return {
    ...cloudBaseConfigFromEnv(opts.env),
    keys: opts.keys,
    deviceId: opts.deviceId,
    fetchImpl: opts.fetchImpl,
  };
}

export class CloudBaseTransport extends RemoteSyncTransport {
  readonly kind = 'cloudbase';

  static async createVault(opts: CloudBaseTransportOptions): Promise<CloudBaseTransport> {
    const transport = new CloudBaseTransport(opts);
    await transport.bootstrapCreate();
    return transport;
  }

  static async joinVault(opts: CloudBaseJoinOptions): Promise<CloudBaseTransport> {
    const transport = createJoinInstance(CloudBaseTransport, opts);
    await transport.bootstrapJoin();
    return transport;
  }

  static async attach(opts: CloudBaseTransportOptions): Promise<CloudBaseTransport> {
    const transport = new CloudBaseTransport(opts);
    await transport.bootstrapAttach();
    return transport;
  }

  /** 本机已配置好环境变量时的便捷入口。 */
  static async createVaultFromEnv(opts: CloudBaseEnvOptions): Promise<CloudBaseTransport> {
    return CloudBaseTransport.createVault(cloudBaseOptionsFromEnv(opts));
  }

  static async attachFromEnv(opts: CloudBaseEnvOptions): Promise<CloudBaseTransport> {
    return CloudBaseTransport.attach(cloudBaseOptionsFromEnv(opts));
  }

  static async joinVaultFromEnv(
    opts: Omit<CloudBaseEnvOptions, 'keys'> & { recoveryCode: string }
  ): Promise<CloudBaseTransport> {
    const endpoint = cloudBaseConfigFromEnv(opts.env);
    return CloudBaseTransport.joinVault({
      ...endpoint,
      recoveryCode: opts.recoveryCode,
      deviceId: opts.deviceId,
      fetchImpl: opts.fetchImpl,
    });
  }
}
