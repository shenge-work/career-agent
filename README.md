# CareerAgent · 个人求职 Agent 工作台

**本地服务器部署**的求职工作台：账号登录 + 行级数据隔离 + PostgreSQL 兼容数据库，
以**岗位（Application）为第一公民**，承载简历编辑（A4 实时预览 / 矢量与图片版 PDF）、
公司档案（求职情报底座）、投递追踪（含 BOSS 聊天采集）、AI 模型转发与本地版本历史。
数据全部在本机，不出你的电脑。

> 本项目由「零后端单文件简历编辑器（v1）」重构而来：v1 已于 2026-11-04 退役，
> 其渲染引擎资产收编至 `legacy/` 继续服役（预览与 PDF 同源）。重构全过程见
> [docs/v2重构归档/README.md](./docs/v2重构归档/README.md)。

---

## 🚀 快速开始（Node ≥ 22.12）

```bash
npm install                 # 首次
npm run db:migrate          # 应用 drizzle/*.sql（PGlite 数据落 ./pgdata）
npm run seed:user -- --email me@local.test --password '<强密码>' --role admin
npm run dev                 # 前端 5173 / API 3000
```

浏览器打开 `http://127.0.0.1:5173` 登录即可。

| 命令 | 用途 |
|---|---|
| `npm run dev` / `dev:server` / `dev:web` | 全链路 / 只起 API / 只起前端 |
| `npm test` / `test:watch` | Vitest 全量 / 监听 |
| `npm run build` | tsc + vite build（`dist-server/`、`dist-web/`） |
| `npm start` | 跑编译后的 `dist-server/server/main.js` |
| `npm run db:migrate` | 顺序应用 `drizzle/*.sql`（**停 dev 后执行**，PGlite 单进程） |
| `npm run seed:user` | CLI 建号 |
| `npm run import:v1` | 从旧 `data/` 导入（迁移工具，已完成历史使命） |

## ✨ 当前功能

**账号与数据**：多账号登录（Argon2id + HttpOnly 会话）、全部业务数据按账号行级隔离
（跨用户资源一律 404）；PGlite（PostgreSQL WASM）存储，数据目录 `./pgdata`，可平替切换真 PostgreSQL。

**简历**：多简历库（母简历 / JD 派生版 / 空白模板）、设主简历；双栏编辑器——左侧 v1
渲染管线（vm 沙箱）输出的 A4 实时预览，右侧结构感知表单 + 原始 JSON 兜底，停 800ms 自动保存；
导出矢量 PDF（文字可选中）与图片版 PDF（精确分页）；**本地版本历史**——编辑自动留痕、
手动快照永不清理、一键恢复（恢复前当前内容自动备份，恢复可逆）。

**公司档案**：公司六维调研、岗位 JD、行业分类检索；面试前一键生成 Markdown 简报
（详见 [D7 设计](./docs/需求文档/D7-公司档案板块设计.md)）。

**投递追踪**：投递状态管理、公司档案只读回链、BOSS 直聘聊天采集（本机 Chrome 调试端口，直写库去重）。

**AI**：按账号配置 OpenAI 兼容上游（DeepSeek / 本地 Ollama 等），Key 只存服务端、
GET 永不回显；流式试用台；按账号统计用量。

**附件库**（`#/attachments`）：拖拽 / 多选上传、归属标记与筛选、图片与 PDF 预览、
下载、软删除、同步增量预览。20MB 上限，字节按 sha256 内容寻址落在本地 `blobs/`，
读取全程走会话鉴权，界面沿用黑白灰主题。

## 🏗️ 架构

```
浏览器 ── 127.0.0.1:5173 ──> Vite（React SPA）
                │  /api 代理
                v
        127.0.0.1:3000  NestJS + Fastify
                ├─ PGlite（进程内 PostgreSQL，数据 ./pgdata）
                ├─ blobs/（附件字节，sha256 内容寻址，PG 只存元数据）
                ├─ legacy/ 渲染引擎资产（vm 沙箱加载，v1 遗产继续服役）
                └─ 按需 spawn：headless Chrome（PDF）/ boss-collect（采集）
```

- `src/server/` NestJS：auth（认证）/ tenant（行级隔离唯一入口）/ resumes / business /
  render（渲染孤岛与双 PDF）/ ai / collect / users / security（回环守卫）
- `src/web/` React：登录 / 简历库 / 编辑器 / 附件库 / 冲突恢复 / 公司档案 / 投递 / AI / 面经 / 账号与设置
- `legacy/` v1 渲染引擎资产（8 个 JS + style.css + html2canvas/jspdf + boss-collect），
  只读引用、只改 bug 不重构
- `drizzle/` 手写迁移 SQL（`_migrations` 记录已应用）
- `test/` Vitest 端到端（内存 PGlite，`app.inject()`）

## 📎 本地附件与数据目录（local-first，可同步）

附件字节**不进数据库**：按 sha256 内容寻址落在 `blobs/sha256/<前2>/<后62>`（无扩展名），
`attachments` 表只存元数据与归属，因此 DBeaver 里能查到完整附件清单，字节与 hash 一一对应。
上传流式写临时文件 + `rename` 原子落盘，同内容天然去重；类型由 magic number 白名单判定，
绝不采信客户端的 content-type 或扩展名。读取只有 `GET /api/attachments/:id/raw` 一条路，
带会话鉴权 + `nosniff` + `CSP: sandbox`，SVG / zip / 文本一律强制下载，**绝不静态直挂 blobs 目录**。

| 端点 | 用途 |
|---|---|
| `POST /api/attachments`（multipart，字段 `file`，可选 `?ownerType=&ownerId=`） | 上传，20MB 上限 |
| `GET /api/attachments`（可选 owner 过滤） | 附件清单 |
| `GET /api/attachments/:id` / `:id/raw` | 元数据 / 字节流 |
| `DELETE /api/attachments/:id` | 软删除（写墓碑，不删 blob） |
| `GET /api/attachments/sync/changes?since=<cursor>&limit=` | 同步增量（附件 + 全部业务表），返回 `nextCursor`，limit ≤ 1000 |

> 前端调用注意 `api.ts` 铁律：无 body 的 `DELETE` / `GET` 不要带 `Content-Type: application/json`；
> multipart 上传也不要手动设 `Content-Type`（浏览器需自动生成 boundary）。

**为将来上云预留**：`BLOB_STORE` 是唯一可替换点，业务代码只依赖 `BlobStore` 接口；
云端 object key 直接复用 sha256，零映射、天然增量（先交换 hash 清单，只传缺失的）。
`change_log` 已覆盖**附件 + 全部业务表**：附件模块在应用层同事务记账，其余 12 张业务表
由 `0010` / `0011` 的触发器自动记账（与业务写同事务、应用代码零侵入，
软删除与物理删除都留下 `delete` 墓碑）。拉取游标由数据库单一序列统一生成、严格单调，
同一毫秒批量写不会因重复 HLC 被游标吃掉；账号 / 会话 / 统计表刻意不进入同步流，
且 `api_key` 等敏感列绝不写进 outbox。

### 冲突地基（0011，本地侧已完成）

`drizzle/0011_sync_semantics.sql` 把业务表改造成可跨设备合并的形态，**不依赖云端即可验证**：

| 能力 | 落地 |
|---|---|
| HLC 时钟 | 12 张业务表统一加 `hlc / device_id / deleted_at`；`ca_hlc_state` 单行状态表 + `BEFORE` 触发器统一领号（同毫秒 `.000000 → .000001` 严格单调），收到远端时钟会 `observe`，保证后续本地写一定排在已见远端写之后。应用代码不自己算时钟，`import:v1` 和直接 SQL 也自动覆盖 |
| 软删除墓碑 | 8 张可变实体表（简历 / 公司 / JD / 投递 / 岗位 / 作品集 / 面试复盘 / 面经）的删除改成 `UPDATE deleted_at`；`TenantDb` 所有读走 `active()` 自动过滤，写也排除已删行；同 id 重建走 `revive()` 复活，不撞 `(user_id,id)` 复合主键。`versions / application_events / settings / ai_configs` 是「只增不删」的流水与单例，仍走物理删除 |
| 冲突快照 | 回灌时按业务 HLC + `device_id` 做 LWW：**无论谁胜都把落败方整行留进 `conflict_snapshots`**（远端胜存本地旧版，本地胜存远端版本），敏感列先经 `ca_safe_row_json` 剔除。刻意不复用 `versions`——那是用户手动版本历史，混进去会污染版本列表 |
| chat append-only | `tracker.payload.chat[]` 仍由前端与采集器整块写，触发器按 `(user, tracker, role+text+ts)` 幂等投影成 `tracker_chat_events`；将来合并两台设备的聊天记录按 `dedupe_key` 取并集，而不是让整块 jsonb 的 LWW 吞掉一边的对话 |

**三个时钟别混用**：`change_log.hlc` = 本地增量拉取游标；业务行 `hlc` = 跨设备 HLC 因果时钟；
`updatedAt / savedAt` = 本机墙钟，只用于 UI 展示与排序，绝不参与冲突判定。云端上线后仍需
由服务端统一授时。这是**应用级逻辑同步**，不是 `pgDump`/WAL 物理复制——PGlite 的 `pgdata`
无法被原生 PostgreSQL 打开。

**回灌约定**（`src/server/sync/sync-import.ts`）：云端变更落回本地必须包在
`withSyncImport()` / `applyRemoteUpsert()` 里，即打开会话 GUC `app.sync_import='on'`。
窗口内业务行保留远端 `hlc / device_id`、跳过 `change_log` 记账（防止「云端推来 → 本地又推回
云端」成环），窗口由 `try/finally` 复位。远端行必须显式自带 `id / userId / hlc / deviceId`，
远端 delete 事件传 `deletedAt`。`GET /api/sync/conflicts`、`GET /api/sync/chat-events?trackerId=`
是本地审计窗口（0012 起前者还支持恢复 / 忽略），全部走 `SessionGuard` + `TenantDb.forUser`。

> 真实库已应用 0011（备份 `backups/pgdata-before-0011-*`）。迁移中的历史行回填会顺带产生
> 一批全量 `upsert` 增量信号——首次接云本来就要做全量首传，这是预期行为，不是脏数据。

### 冲突恢复（0012，前端 `#/conflicts` 已可用）

`drizzle/0012_conflict_restore.sql` 给 `conflict_snapshots` 加 `status`
（`pending / restored / dismissed`）、`resolved_at`、`restored_from`，并允许
`resolution='restore'` 的留底行。前端页面提供状态 / 实体 / 记录 ID 筛选、落败方整行 JSON 原文、
复制 JSON、恢复（二次确认）、忽略，以及深链跳到对应的简历 / 公司 / 岗位 / 投递记录。

| 端点 | 用途 |
|---|---|
| `GET /api/sync/conflicts?status=&entity=&entityId=` | 快照列表（最多 200 条） |
| `GET /api/sync/conflicts/:id` | 单条详情（含原文） |
| `POST /api/sync/conflicts/:id/restore` | 恢复落败方版本（200） |
| `DELETE /api/sync/conflicts/:id` | 标记忽略（不删原文） |

**恢复铁律**：恢复 = 一次新的本地写，绝不把快照里的 `hlc / device_id` 抄回去——回拨因果时钟
会让云端把这次改动当成过期变更拒收。`src/server/sync/restore.ts` 只把业务列从快照翻译回
drizzle 行，同步三元组与墙钟列一律跳过、`deletedAt` 置 null（撤销软删）；`BEFORE` 守卫重新领
HLC、归因本机，`AFTER` 触发器照常写 `change_log`。事务内还会把被换下的当前版本留成一条
`resolution='restore'` 的 pending 快照（`restored_from` 指向原快照），因此可以来回切换、永不丢改动。

只开放 8 张有 `(user_id,id)` 身份的可变实体表；`versions / application_events / settings /
ai_configs` 是流水或单例，恢复接口返回 400、前端禁用按钮。快照是纯本地审计数据，不进
`change_log`、不参与云端同步；敏感列在 0011 写入时已被剔除，恢复时也不会回写。
重复恢复 / 忽略返回 409，跨用户一律 404。真实库已应用 0012（备份 `backups/pgdata-before-0012-*`）。

### 云端选型定稿（2026-11-08）：哑云 + E2EE + 可替换 Transport

**最终拍板（同日用户确认）：Cloudflare Workers + D1 + R2，密钥体系为恢复码 + E2EE。**
离线增量包已作为第一阶段先行交付；云适配器按此实现，境内合规备选腾讯云 CloudBase / COS。

**结论：云端不建业务库。** HLC 授时 / LWW / 软删除 / 冲突快照 / 人工恢复已全部由 0010~0012
在本地完成；E2EE 下云端只见密文，托管 PG 的触发器 / RLS / Realtime 全无用武之地。
云端只需四件事：设备授权、分配严格递增序号、存加密事件流、存加密 blob。
**换云厂商 = 换一个 `SyncTransport` 实现，业务代码一行不改。**

| 候选 | 成本（2026-11 口径） | 国内访问 | 结论 |
|---|---|---|---|
| Cloudflare Workers + D1 + R2 | 免费档够单人：Workers 10 万请求/日、R2 10GB 零出口费、D1 5GB；超额 $5/月起 | 三者中相对最稳，`workers.dev` 域名不稳需绑自定义域 | ✅ **已选定**：零运维，哑管道约 200 行 V8 代码 |
| 腾讯云 CloudBase / COS | 免费 3000 资源点/月（≈¥3），个人版 ¥19.9/月 | 最稳、数据境内、合规最好 | 「必须境内」时选它；注意免费环境 6 个月续期、资源点计费切换不可逆 |
| 自建 NestJS + PG + S3 兼容 | VPS + 域名 + 证书，成本最高 | 完全自控 | 同栈适配成本最低，但个人用偏重；留给将来多用户 SaaS |
| Supabase 托管 PG | 免费 500MB DB / 1GB 存储，闲置 7 天暂停；Pro $25/月 | 常超时 | **不推荐**：E2EE 下其全部优势失效 |
| 离线增量包（任意网盘） | ¥0，零账号零运维 | 不涉及 | **第一阶段先交付**，也是 Sync Engine 的零依赖验证环境 |

密钥体系与登录账号解耦：启用同步时本地生成一次性恢复码，另一台设备输入同一恢复码即可加入
vault；改登录密码不影响同步密钥，也不需要邮箱找回。恢复码与派生密钥绝不落库、绝不出本机。
**salt 由恢复码确定性派生**（`recoveryCodeSalt()`），所以只需抄一串码，不用再抄第二串 salt；
云端另存一份公开 salt 供加入时核对。`deriveVaultKeys(code, salt)` 旧签名保留给离线包与历史数据。

**协议契约**（`src/server/sync/`）：
- `transport.ts`：20 位定长 `seq`（字典序 = 数值序）、`SyncEvent` / `SyncEnvelope`、
  `SyncTransport`（`head / push / pull / putBlob / getBlob / hasBlob`）、CAS 冲突 `SeqConflictError`；
- `crypto.ts`：`scrypt(恢复码, salt) → HKDF` 派生 `vaultId / authKey / encKey / macKey`；
  事件与 blob 均用 AES-256-GCM，AAD 绑定 vault / device / batch / index；
  `objectKey = HMAC(macKey, sha256(明文))` 兼顾保密与同用户去重，云端只存 `sha256(authKey)`；
- `offline-pack.ts`：协议映射到目录（`manifest.json` + `events/<seq>.json` + `blobs/<key>.bin`），
  整个目录拷进任意网盘即可跨设备同步。它同样只分配 seq、只存密文、绝不解析业务内容；
- `cloudflare-transport.ts`：`SyncTransport` 的云端实现（`createVault / joinVault / attach`），
  与离线包平级，SyncEngine 换适配器即可切换通道。

**三个序号职责**（接云最容易写歪）：`change_log.hlc` 是本地增量拉取游标（0010 单序列，只在本机
有效）；业务行 `hlc` 是跨设备 LWW 因果时钟（0011，随事件封包）；云端 `seq` 是全局事件顺序，
只管断点续传、绝不参与冲突判定——正是 0010 注释里预留的「独立 seq」。

**推事件必须带整行**：0010 的 `change_log.payload` 只是轻量信号（`table/op/id`），
SyncEngine 在 push 前要按 entity / entityId 读取当时的完整业务行快照填进 `SyncEvent.row`；
回灌仍走 `applyRemoteUpsert()`。云端 seq 刻意不进 AAD，否则服务端分配 seq 后密文解不开；
seq 的完整性改由 pull 时「严格递增且与 nextSeq 吻合」校验。

### 云端哑云服务（2026-11-08 已落地，可独立部署）

`cloud/sync-worker/` 是零第三方运行时依赖的独立 Worker 包，可整目录拷出去部署：

| 文件 | 作用 |
|---|---|
| `src/protocol.ts` | 版本 / seq / 限额 / 错误码；与主项目 `transport.ts` 由契约测试对齐 |
| `src/store.ts` | `SyncStore` 门面 + `D1R2Store`（生产）+ `MemorySyncStore`（本地验证） |
| `src/handler.ts` | 路由与授权，纯 `Request → Response`，不依赖 Cloudflare 运行时 |
| `src/index.ts` | Worker 入口，只做 D1 / R2 绑定适配 |
| `schema.sql` / `wrangler.toml` | D1 三张表（vaults / devices / events）与绑定配置 |

端点（全部挂 `/v1`）：`POST /vaults`（建 vault，同 id 禁止重置授权）、`GET /vaults/:id`（含公开 salt）、
`POST /vaults/:id/devices`、`GET .../head`、`POST .../events`（CAS 推）、
`GET .../events?since=&limit=`、`PUT / GET / HEAD .../blobs/:objectKey`、`GET /health`。

安全与一致性：

- `X-CA-Auth` 在 TLS 内提交 authKey，D1 只存 `sha256(authKey)` 并做常量时间比对；创建 vault 时只提交哈希。
- 云端只写 `aad`（路由信息）与密文，绝不解密；校验 `vaultId / deviceId / batchId / index` 一致性，
  挡住跨 vault 重放与批内乱序。
- CAS 靠 `events` 主键 `(vault_id, seq)` + `D1 batch` 单事务：落后游标返回 409，并发撞主键整批回滚，
  不会出现序号空洞或半批写入。
- 限额：单批 200 条 / 单条 512KB / 单请求 4MB / blob 25MB；`objectKey` 只接受 64 位 hex，防路径穿越。

部署（需 Cloudflare 账号；`workers.dev` 境内不稳，建议绑自定义域名）：

```bash
cd cloud/sync-worker
npm install
npx wrangler login
npx wrangler d1 create career-agent-sync         # 把返回的 database_id 填进 wrangler.toml
npx wrangler r2 bucket create career-agent-sync-blobs
npm run db:init                                   # 应用 schema.sql
npm run deploy                                    # 客户端 baseUrl 设为 https://<你的域名>
```

无账号也能验证全链路：`test/cloudflare-sync.e2e.test.ts` 用 `MemorySyncStore` + 注入 fetch 打通真实
handler，`test/cloudflare-d1-store.test.ts` 用内存 D1 / R2 替身跑生产 `D1R2Store`，均不联网。

客户端用法（`src/server/sync/cloudflare-transport.ts`）：

```ts
const code = generateRecoveryCode();          // 只需保存 / 抄写这一串恢复码
const keys = deriveVaultKeys(code);
const a = await CloudflareTransport.createVault({ baseUrl, keys, deviceId: deviceId() });
const b = await CloudflareTransport.joinVault({ baseUrl, recoveryCode: code, deviceId: deviceId() });
```

`attach()` 用于同设备重启后附着；`push()` 会回写云端分配的 seq；`pull()` 校验序号严格递增并与
`nextSeq` 吻合；409 映射为 `SeqConflictError`。它与 `OfflinePackTransport` 实现同一个 `SyncTransport`。

### 接云还差什么（尚未实施）

- Sync Engine 本体：全量首传 + 增量推拉 + 断点续传 + 回灌调度 + 重试，`sync_state` 表持久化游标；
- 前端 `#/sync`：启用同步、显示恢复码、另一台设备加入、手动 / 自动同步、进度与冲突入口；
- blob 云端引用计数 GC（本地删 ≠ 云端删，否则其它设备会拿到坏引用）；
- 真实 Cloudflare 账号下的部署联调（自定义域名 / 配额 / 压测）——本地协议链路已全部覆盖测试。

以上都不影响当前单机功能：断网、无云账号时本地全部可用。离线增量包已可独立验证协议全链路。

**数据目录**：打包时务必设置 `CAREER_AGENT_DATA_DIR` 到用户可写的绝对路径
（macOS `~/Library/Application Support/CareerAgent`、Windows `%APPDATA%\CareerAgent`），
下挂 `pgdata/` 与 `blobs/`；不要落在 `.app` / `Program Files`（签名只读、写入要管理员权限）。
开发态不设时沿用 `./pgdata`，`blobs/` 与之并列。备份 / 卸载 / 导出只需拷这一个目录。
`PGDATA` 可单独覆盖 pgdata 路径，`CAREER_AGENT_DEVICE_ID` 可覆盖设备 id（测试用）。

## 用 PG 客户端查看本地数据（开发者模式，默认关闭）

内置库是 PGlite（进程内 PostgreSQL WASM），默认不监听端口，DBeaver / pgAdmin / DataGrip /
TablePlus / psql 等客户端无法直连。设置 `DB_CLIENT_PORT` 后，应用会在回环上挂一个
PostgreSQL wire protocol 桥，复用同一个数据库实例，启动日志会打印连接串：

```bash
# macOS / Linux：指定端口
DB_CLIENT_PORT=55432 npm start
# 让系统分配空闲端口（日志里会打印实际端口），适合避免端口冲突
DB_CLIENT_PORT=0 npm start

# Windows PowerShell
$env:DB_CLIENT_PORT=55432; npm start
```

连接参数：主机 `127.0.0.1`、端口取启动日志、用户 `postgres`、数据库 `postgres`、密码留空、
**关闭 SSL**（`psql` 用 `PGSSLMODE=disable`，GUI 里 SSL mode = `disable`）。DBeaver 建议关闭
「为元数据读取单独打开连接」，连接数不超过 4；底层是单连接 + 查询队列复用，
`COPY ... FROM STDIN`、并行事务等场景不完全兼容。

注意：

- 桥与业务共用同一个 PGlite 实例，GUI 里**可读写全部账号数据**，会绕过 `TenantDb` 行级隔离；
  因此只绑 `127.0.0.1`、默认关闭，仅用于本机排查。正式安装包请保持关闭，或只暴露只读视图。
- `pgdata/` 是 WASM 版数据目录，不能被原生 PostgreSQL 直接打开；需要导出请用
  `@electric-sql/pglite-tools` 的 `pgDump`。
- 应用内 `DbHandle.close()` 会先停桥再关库；进程直接退出时端口由系统释放。

## 🔒 安全边界（内测形态）

仅监听 `127.0.0.1`；Host/Origin 回环守卫防 DNS rebinding 与跨站写；会话 cookie
HttpOnly；AI 上游只放行 https 公网 / http 回环。**≤10 人本机内测安全模型**——对外部署前
先过 [docs/v2重构归档/04-运行维护与后续路线.md](./docs/v2重构归档/04-运行维护与后续路线.md) §6 的内测前清单。

## 📁 文档

- [docs/v2重构归档/](./docs/v2重构归档/README.md)：v1→v2 重构全记录（选型、架构、逐阶段验收、运维）
- [docs/需求文档/](./docs/需求文档/README.md)：需求清单（D/N 编号）
- [ROADMAP.md](./ROADMAP.md)：路线图（含 v1 退役后待补能力清单）
- [CHANGELOG.md](./CHANGELOG.md)：变更记录

## ⚖️ 已退役（v1 能力，不再维护）

file:// 单文件离线版、Tauri 桌面 / 安卓打包、CI 三平台发版、飞书同步（OAuth / Device Flow /
云盘版本）、localStorage / IndexedDB 降级存储、本地 `data/*.json` 文件写入。
其中「投递体检、JD 匹配分析、Word/TXT/MD 导出、撤销/重做、主题模板」等编辑能力
列于 [ROADMAP](./ROADMAP.md) 待在 v2 分期重建。

## License

MIT

> AI生成
