# CareerAgent 同步服务端（任意 Linux 服务器版）

哑云同步服务：复用与 Cloudflare Worker / 腾讯云 CloudBase 完全相同的 `/v1` 协议与
`cloud/sync-worker/src/handler.ts`，用 **SQLite + 磁盘 blob** 持久化，可直接跑在任意
Linux 服务器（已在腾讯云轻量应用服务器 2 核 2G 场景验证）。云端永远只见密文。

## 为什么是这一版

- `/v1` 协议、授权模型、E2EE、CAS、seq 分配逻辑全部在 `cloud/sync-worker/src/handler.ts`，
  本包**不重写**任何协议代码，只提供一个 Node 入口 + 一个 SQLite 存储实现。
- 客户端 `src/server/sync/remote-transport.ts` 的 `RemoteSyncTransport` 本就厂商无关，
  只需把 `baseUrl` 指向本服务即可，无需任何厂商专属适配器。
- 比 Cloudflare Worker（R2 订阅 + `*.workers.dev` 境内不可达）和 CloudBase 云函数
  （控制台 UI 自动化在本机不可用）都省心：标准 Linux + 公网 IP + 免费。

## 架构

```
Node http.Server
  └─ server.ts      原生请求 → Web Request → handleSyncRequest → Response → 原生响应
       └─ handler.ts  （来自 cloud/sync-worker，零改动）
            └─ SqliteSyncStore
                 ├─ SQLite: vaults / devices / events（密文事件流）
                 └─ 磁盘:   data/blobs/<vaultId>/<objectKey>（加密 blob，内容寻址幂等）
```

seq 是 20 位定长数字字符串，字典序 == 数值序，SQLite 的 TEXT 列直接 `ORDER BY` / 比较；
CAS 用 `PRIMARY KEY (vault_id, seq)` 冲突兜底，并发推进过头的事务整批回滚，不留序号空洞。

## 本地构建与自检

```bash
npm install            # 装 better-sqlite3（含预编译）与 esbuild
npm run build          # 产出 dist/index.js（external better-sqlite3）
npm run smoke          # 本地起临时 SQLite + HTTP，跑全链路协议自检
```

`npm run smoke` 会在随机回环端口起服务，用主项目同一套加密 / 通用 `RemoteSyncTransport`
验证 health、建 vault、E2EE 推拉解密、CAS、blob 往返、跨 vault 隔离、未授权 401。

## 部署到服务器（以 106.55.30.22 / 广州轻量云为例）

服务端已内置可选 HTTPS（自签名证书也能直接对外），**无需 nginx / Caddy 反向代理**。
客户端 `RemoteSyncTransport` 对非回环地址强制 https；无域名时选择「自签名 + 客户端
`insecureTls` 临时跳过校验」（见末尾客户端配置）。

### 1) 上传

```bash
# 在本机构建后，把产物上服务器（无需源码头文件）
scp -r cloud/sync-server/dist cloud/sync-server/package.json \
    cloud/sync-server/.env.example cloud/sync-server/scripts/deploy.sh \
    user@106.55.30.22:/opt/career-agent-sync/
```

### 2) 一键部署（root 运行）

`deploy.sh` 会：装 Node 20（缺失/过旧时从 nodejs.org 拉二进制，不依赖包管理器）、
装运行时依赖、生成自签名证书、写 `.env`、注册 systemd 并启动：

```bash
ssh user@106.55.30.22
cd /opt/career-agent-sync
APP_DIR=/opt/career-agent-sync PORT=8443 bash scripts/deploy.sh
```

- 对外 HTTPS 端口默认 `8443`（避免 root 绑 443 的权限问题；客户端 baseUrl 带此端口）。
- 自签名证书 `certs/cert.pem` 有效期 365 天，过期后重跑脚本或手动 `openssl x509 -req` 续期。
- `8788` 仅作回环/http 兜底，正式部署用 `8443` 的 https。

### 3) 防火墙

腾讯云防火墙放行 TCP `8443`（仅此端口对外；SQLite / blob 都在本地磁盘，不暴露）。

### 4) 部署后自检

```bash
# 本机对正在运行的部署做协议全链路自检（自签名需跳过校验）
NODE_TLS_REJECT_UNAUTHORIZED=0 BASE_URL=https://106.55.30.22:8443 npm run smoke
```

## 客户端配置

主项目 `SYNC_TRANSPORT` 选通用 http 通道（或直接 `new RemoteSyncTransport({ baseUrl })`）：
把 `baseUrl` 指向 `https://<公网IP>:8443`，**并传 `insecureTls: true`** 接受自签名证书：

```ts
new RemoteSyncTransport({ baseUrl: 'https://106.55.30.22:8443', keys, deviceId, insecureTls: true });
```

启用同步时本地生成一次性恢复码，另一台设备输入同一恢复码加入同一 vault，密钥绝不落云端。
后续若有正规域名 + 受信证书，去掉 `insecureTls` 即可。

## 安全边界

- 云端只存 `sha256(authKey)`、事件密文（aad 是明文路由信息，ciphertext 永不解密）、blob 密文。
- 授权头 `X-CA-Auth` 是 authKey 的 hex，云端只存其哈希；比对用常量时间比较。
- 恢复码与派生密钥绝不落库、绝不出本机；改登录密码不影响同步密钥。
