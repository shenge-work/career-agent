# CareerAgent 同步哑云服务 · 腾讯云 CloudBase 版

> 状态（2026-11-09）：**代码与本地模拟已完成，本轮未创建任何云资源、未部署、未产生费用。**
> Cloudflare 链路因 R2 订阅需账单信息、`workers.dev` 境内不可达而暂时冻结，本通道作为境内可用替代先接进来。

云端是「哑管道」：**不建业务库、不解密、不理解业务表**。它只做四件事：设备授权、
分配严格递增 `seq`、存加密事件流、存加密 blob。HLC / LWW / 软删除 / 冲突快照 / 人工恢复
全部留在本地（0010~0012），换厂商只换一个 `SyncTransport` 实现。

## 与 Cloudflare 版的关系

两套服务跑的是**同一套 `/v1` 协议**（`cloud/sync-worker/src/handler.ts` 的
`handleSyncRequest()`），差别只在三处：

| | Cloudflare | 腾讯云 CloudBase |
|---|---|---|
| 运行时入口 | Worker `fetch(Request)` | 云函数 `main(event)`，本包 `gateway.ts` 做事件 ↔ `Request/Response` 转换 |
| 存储 | D1 + R2（`D1R2Store`） | 云数据库 + 云存储（`CloudBaseSyncStore`） |
| CAS | `events` 主键 + `D1 batch` 单事务 | `db.runTransaction()` 快照隔离 + 文档锁 |
| 客户端 | `CloudflareTransport` | `CloudBaseTransport` |

因此 `test/cloudflare-sync.e2e.test.ts` 里的协议断言对腾讯云版同样成立；
`test/cloudbase-sync.e2e.test.ts` 再补上云函数事件转换与生产 Store 的验证。

## 目录

| 文件 | 作用 |
|---|---|
| `src/gateway.ts` | HTTP 访问服务事件 ↔ 标准 `Request`/`Response`；自动剥离函数路径前缀 |
| `src/cloudbase-store.ts` | `SyncStore` 实现；事务化 CAS、密文事件流、密文 blob |
| `src/app.ts` | 处理器工厂，**不依赖腾讯云 SDK**，本地可用内存替身直接跑 |
| `src/index.ts` | 云函数入口；`@cloudbase/node-sdk` 适配层，SDK 版本差异只在这里收敛 |
| `src/cloudbase-sdk.d.ts` | 未安装 SDK 时的最小类型声明（避免把云 SDK 拉进本地安装包） |
| `.env.example` | 环境变量样例（无真实密钥） |

## 云数据库集合

首次部署前在控制台建好四个集合（或让首次 `add` 自动建），建议给 `ca_events` 的
`seq` 建索引以支撑 `where(seq gt ...).orderBy('seq').limit()`：

| 集合 | `_id` | 主要字段 |
|---|---|---|
| `ca_vaults` | `vaultId` | `authHash`（sha256(authKey)）、`salt`（公开）、`headSeq`、`createdAt` |
| `ca_devices` | `vaultId:deviceId` | `firstSeenAt` / `lastSeenAt` |
| `ca_events` | `vaultId:seq` | `aad`（明文路由信息）、`nonce`、`ciphertext`、`bytes` |
| `ca_blobs` | `vaultId:objectKey` | `fileID`（云存储文件 ID） |

云存储路径：`v1/<vaultId>/blobs/<objectKey>`，`objectKey` 是 HMAC 派生的 64 位 hex。

## 部署（本轮未执行）

```bash
cd cloud/sync-cloudbase
npm install                 # 只装 @cloudbase/node-sdk（部署时用）
npm run build               # 打包成单文件 dist/index.js，内联 Worker 协议层
# 控制台：云函数 → 新建 Node 18 函数 career-agent-sync，上传 dist/index.js + package.json
#         开启「HTTP 访问服务」，记下访问路径
```

环境变量：`TCB_ENV_ID`（云函数内一般自动注入）；本地直连才需要
`TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY`。**密钥绝不写进仓库或前端。**

客户端配置：`TCB_SYNC_BASE_URL` = HTTP 访问服务地址，`TCB_SYNC_PATH_PREFIX` = 函数路径
（例如 `/sync-api`）。网关会把这段前缀带进 `event.path`，`gateway.ts` 的 `pathToV1()`
自动剥掉，无需在服务端重复配置。

部署后自检：

```bash
curl https://<env>.<region>.app.tcloudbase.com/<function-path>/v1/health
# {"ok":true,"v":1}
```

## 本地零账号验证

不需要 CloudBase 账号、不联网：

```bash
npx vitest run test/cloudbase-sync.e2e.test.ts
```

测试用内存版云数据库 / 云存储替身跑**生产** `CloudBaseSyncStore`，再经真实的
`createCloudBaseHandler()` 把标准 `Request` 转成网关事件，注入 `CloudBaseTransport`：
授权、E2EE 推拉、CAS 事务回滚、blob 往返、路径前缀、密文不可读全部覆盖。

## 上线前需要核对的点

- `src/index.ts` 的 SDK 适配层按 `@cloudbase/node-sdk` 事务文档写的：
  `doc().set(data)` 平铺字段、`doc().update({data})` 包装、`runTransaction` 返回
  `{result, errMsg}`、`db.command.gt()`。若账号里 SDK 版本行为不同，只需改这一个文件。
- CloudBase 事务有 10 秒上限、事务内不支持 `where`；单批上限 200 条已在协议层限制。
- 免费额度 / 资源点计费与「6 个月续期」规则以控制台当期说明为准，部署前请自行确认。
- blob 云端引用计数 GC 尚未实现：本地删除不等于云端删除，避免其它设备拿到坏引用。
