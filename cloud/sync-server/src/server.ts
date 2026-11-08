/**
 * Node HTTP 入口：把原生 http.IncomingMessage 转成 Web 标准 Request，交给
 * cloud/sync-worker/src/handler.ts（同一份 /v1 协议），再把 Response 转回 ServerResponse。
 *
 * 不引入任何框架，纯 Node 标准库 + 一个 better-sqlite3。部署时由 Caddy / Nginx 反向代理
 * 提供 HTTPS 与域名（客户端 RemoteSyncTransport 强制 https）。
 */

import http from 'node:http';
import https from 'node:https';
import type { SyncStore } from '../../sync-worker/src/store';
import { handleSyncRequest } from '../../sync-worker/src/handler';

export interface SyncServerTls {
  cert: string;
  key: string;
  /** 私钥口令（可选）。 */
  passphrase?: string;
}

export interface SyncServerOptions {
  /** 失败时打印日志（部署后可由 pm2 等捕获）。 */
  onError?: (error: unknown) => void;
  /** 提供则直接以 HTTPS 对外（自签名证书场景），无需反向代理。 */
  tls?: SyncServerTls;
}

export function createSyncServer(
  store: SyncStore,
  options: SyncServerOptions = {}
): http.Server | https.Server {
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      // handler 只读取 pathname 与 search，host 用占位即可
      const url = `http://localhost${req.url ?? '/'}`;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value == null) continue;
        if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
        else headers.set(key, value);
      }

      let body: Buffer | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        body = Buffer.concat(chunks);
      }

      const request = new Request(url, {
        method: req.method,
        headers,
        body: body as unknown as BodyInit,
      });

      const response = await handleSyncRequest(request, { store });

      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));

      if (response.body) {
        const buffer = Buffer.from(await response.arrayBuffer());
        res.end(buffer);
      } else {
        res.end();
      }
    } catch (error) {
      options.onError?.(error);
      if (!res.headersSent) res.statusCode = 500;
      res.end('internal_error');
    }
  };

  if (options.tls) {
    return https.createServer(
      { cert: options.tls.cert, key: options.tls.key, passphrase: options.tls.passphrase },
      handler
    );
  }
  return http.createServer(handler);
}
