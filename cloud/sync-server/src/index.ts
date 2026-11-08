/**
 * 哑云同步服务端主入口。
 *
 * 部署：先 `npm run build` 产出 dist/index.js（已 external better-sqlite3），
 * 在服务器上 `npm install --omit=dev` 后 `node dist/index.js`。
 * 所有路径都可用环境变量覆盖，默认数据落在 ./data（SQLite + 磁盘 blob）。
 */

import { webcrypto } from 'node:crypto';
// 保证 handler 里的 globalThis.crypto.subtle 在 Node 18/19 上也可用（20+ 已默认）
if (!globalThis.crypto) {
  (globalThis as unknown as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SqliteSyncStore } from './sqlite-store';
import { createSyncServer } from './server';

const PORT = Number(process.env.PORT || 8788);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'sync.db');
const BLOB_DIR = process.env.BLOB_DIR || path.join(DATA_DIR, 'blobs');

// 自签名证书：设置 TLS_CERT_PATH / TLS_KEY_PATH 后服务端直接以 HTTPS 对外，
// 无需 nginx / Caddy。客户端用 RemoteSyncTransport({ insecureTls: true }) 接受。
let tls: { cert: string; key: string; passphrase?: string } | undefined;
const tlsCert = process.env.TLS_CERT_PATH;
const tlsKey = process.env.TLS_KEY_PATH;
if (tlsCert && tlsKey) {
  tls = {
    cert: readFileSync(tlsCert, 'utf8'),
    key: readFileSync(tlsKey, 'utf8'),
    passphrase: process.env.TLS_KEY_PASSPHRASE || undefined,
  };
}

const store = new SqliteSyncStore(DB_PATH, BLOB_DIR);
const server = createSyncServer(store, {
  onError: (error) => console.error('[sync-server] unhandled', error),
  tls,
});

server.listen(PORT, '0.0.0.0', () => {
  const scheme = tls ? 'https' : 'http';
  console.log(`[sync-server] listening on ${scheme}://0.0.0.0:${PORT} (db=${DB_PATH}, blobs=${BLOB_DIR})`);
});

function shutdown(signal: string): void {
  console.log(`[sync-server] received ${signal}, closing`);
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
