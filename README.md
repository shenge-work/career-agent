# CareerAgent · 让 AI 替你搞定求职杂活

**本地服务器部署**的个人求职 Agent 工作台：让 AI 自动化掉求职中「投递、调研公司、反复改简历」这些
繁杂又无意义的工作，让求职者把精力专注在**自身专业能力提升与面试训练**上。

技术上以**岗位（Application）为第一公民**，承载简历编辑（A4 实时预览 / 矢量与图片版 PDF）、
公司档案（求职情报底座）、投递追踪（含 BOSS 聊天采集）、AI 模型转发与本地版本历史；
账号登录 + 行级数据隔离 + PostgreSQL 兼容数据库。数据全部在本机，不出你的电脑。

> 本项目由「零后端单文件简历编辑器（v1）」重构而来：v1 已于 2026-11-04 退役，
> 其渲染引擎资产收编至 `legacy/` 继续服役（预览与 PDF 同源）。重构全过程见
> [docs/v2重构归档/README.md](./docs/v2重构归档/README.md)。

---

## 💡 核心理念

求职的本质，是让合适的人被合适的岗位看见；而求职的过程，却充满了大量**繁杂、机械、无意义**的琐事——
海投复制粘贴、反复改简历措辞、到处调研公司、手动追踪进度。这些事占用了求职者最宝贵的精力，却几乎不产生成长。

CareerAgent 的立场很明确：

- **杂活交给 AI**：投递、公司调研、简历修改、进度追踪……这些「不得不做却不值钱」的事，交给 AI 自动化完成。
- **你专注专业与面试**：省下的时间，全部投入到**自身专业能力提升**和**面试能力训练**上——这才是决定 offer 归属的关键。
- **数据不出本机**：AI 替你干活，但简历、投递记录、公司情报永远留在你自己的电脑里，不把隐私交给云端。

> 一句话：**让求职者只做两件事——变得更强，以及让这份强被看见。**

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

### 🖥️ 桌面客户端（Windows / macOS）

Electron 壳内嵌同一个 NestJS 服务，数据仍全部留在本机。完整说明见
[docs/桌面客户端.md](./docs/桌面客户端.md)。

```bash
npm run desktop:dev          # 开发壳：先 npm run dev，再开一个终端跑它
npm run desktop:smoke        # 无窗口自检：内嵌服务 + SPA + 向导页
npm run desktop:pack:win     # Windows NSIS 安装包 + portable exe → release/
npm run desktop:pack:win:dir # Windows 免安装绿色版 → release/win-unpacked/
npm run desktop:pack:mac     # macOS dmg + zip（需在 macOS 上执行）
```

首次启动会自动打开建号向导（库里没有任何账号时）；数据写在
Windows `%APPDATA%\CareerAgent\data` / macOS `~/Library/Application Support/CareerAgent/data`，
与安装目录分离。

## ✨ 当前功能

**账号与数据**：多账号登录（Argon2id + HttpOnly 会话）、全部业务数据按账号行级隔离
（跨用户资源一律 404）；PGlite（PostgreSQL WASM）存储，数据目录 `./pgdata`，可平替切换真 PostgreSQL。

**简历**：多简历库（母简历 / JD 派生版 / 空白模板）、设主简历；双栏编辑器——左侧 v1
渲染管线（vm 沙箱）输出的 A4 实时预览，右侧结构感知表单 + 原始 JSON 兜底，停 800ms 自动保存；
导出矢量 PDF（文字可选中）与图片版 PDF（精确分页）；**本地版本历史**——编辑自动留痕、
手动快照永不清理、一键恢复（恢复前当前内容自动备份，恢复可逆）。

**公司档案**：公司六维调研、岗位 JD、行业分类检索、招聘官网链接；详情页关联该公司的内推信息；
面试前一键生成 Markdown 简报
（详见 [D7 设计](./docs/需求文档/D7-公司档案板块设计.md)）。

**内推管理**（`#/referrals`）：统一管理所有内推信息——内推人、渠道、岗位、内推码、有效期、
跟进节奏与进度状态；按公司自动关联回公司档案，列表按「进行中优先 + 下次跟进日期」排序，
逾期 / 3 天内需跟进直接标在卡片上（详见 [D9 设计](./docs/需求文档/D9-内推管理板块.md)）。

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
  referral（内推）/ render（渲染孤岛与双 PDF）/ ai / collect / users / security（回环守卫）
- `src/web/` React：登录 / 简历库 / 编辑器 / 附件库 / 冲突恢复 / 公司档案 / 内推 / 投递 / AI / 面经 / 账号与设置
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

**最终拍板（2026-11-08 用户确认）：Cloudflare Workers + D1 + R2，密钥体系为恢复码 + E2EE。**
离线增量包已作为第一阶段先行交付；境内合规备选原本就是腾讯云 CloudBase / COS。

> **2026-11-09 通道调整（用户拍板）**：Cloudflare 链路**暂时冻结待定**——R2 订阅卡在
> Dashboard 结账页（需账单 / 卡信息）、`*.workers.dev` 在当前网络代理 502 / 直连超时，
> 且账号暂无自有域名 zone。用户先尝试接入腾讯云 CloudBase（已落地代码、未部署），随后发现
> 本机浏览器工具对腾讯云控制台 UI 自动化不可用、本机也无 CLI 登录态；于是决定**直接复用账号下
> 已有的腾讯云轻量应用服务器（公网 106.55.30.22 / 广州 / 2 核 2G）自建同步服务**——
> 复用同一套 `/v1` 协议与 `handler.ts`，配 SQLite + 磁盘 blob，零额外费用、公网可达、不受
> R2 订阅与 workers.dev 限制。**这是当前首选落地通道**；Cloudflare 与 CloudBase 代码全部保留，
> 随时可切回或并行。详见「任意 Linux 服务器自建同步服务（当前首选）」。

**结论：云端不建业务库。** HLC 授时 / LWW / 软删除 / 冲突快照 / 人工恢复已全部由 0010~0012
在本地完成；E2EE 下云端只见密文，托管 PG 的触发器 / RLS / Realtime 全无用武之地。
云端只需四件事：设备授权、分配严格递增序号、存加密事件流、存加密 blob。
**换云厂商 = 换一个 `SyncTransport` 实现，业务代码一行不改。**

| 候选 | 成本（2026-11 口径） | 国内访问 | 结论 |
|---|---|---|---|
| **腾讯云轻量服务器自建（当前首选，已落地）** | 复用已有 VPS，零新增成本；2 核 2G 够单人，可随需升配 | 公网直连、最稳 | ✅ 复用 `/v1` 协议 + `handler.ts`，SQLite + 磁盘 blob，`cloud/sync-server/` 已在本地全链路验证 |
| Cloudflare Workers + D1 + R2 | 免费档够单人；超额 $5/月起 | `workers.dev` 不稳，需绑自定义域 | 🧊 冻结待定：R2 订阅卡结账页、境内不可达；代码与配置原样保留 |
| 腾讯云 CloudBase / COS | 免费 3000 资源点/月 | 最稳、数据境内 | 已接入代码未部署；控制台 UI 自动化在本机不可用，留作备选 |
| 自建 NestJS + PG（多用户 SaaS，未来） | VPS + 域名 + 证书 | 完全自控 | 留给将来多用户；当前单人用轻量服务器版即可 |
| Supabase 托管 PG | 免费 500MB DB / 1GB 存储 | 常超时 | **不推荐**：E2EE 下其全部优势失效 |
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

### 腾讯云 CloudBase 通道（2026-11-09 已接入，未部署）

用户选择「先做代码 + 本地模拟」：**本轮没有创建任何云资源、没有部署、没有产生费用。**
`cloud/sync-cloudbase/` 与 `src/server/sync/cloudbase-transport.ts` 已可用，`remote-transport.ts`
把两个厂商共用的协议逻辑抽了出来，`CloudflareTransport` 的静态 API 与行为零回归。

| 层 | 文件 | 作用 |
|---|---|---|
| 云函数入口 | `src/gateway.ts` | HTTP 访问服务事件 ↔ 标准 `Request/Response`；`pathToV1()` 自动剥掉函数路径前缀 |
| 云函数逻辑 | `src/app.ts` | 复用 `cloud/sync-worker/src/handler.ts`，**不依赖腾讯云 SDK** |
| 存储实现 | `src/cloudbase-store.ts` | `SyncStore` 的 CloudBase 版：`runTransaction` 快照隔离做 CAS，云数据库存密文事件，云存储存密文 blob |
| SDK 适配 | `src/index.ts` | `@cloudbase/node-sdk` 差异只收敛在这一处（`set` / `update({data})` / `runTransaction` 返回 `{result}` / `db.command.gt`） |
| 客户端 | `src/server/sync/cloudbase-transport.ts` | `CloudBaseTransport`，支持 `pathPrefix` / 额外网关头 / `createVaultFromEnv` 等 |

四个集合：`ca_vaults`（`authHash` 哈希 + 公开 `salt` + `headSeq`）、`ca_devices`、
`ca_events`（`_id = vaultId:seq`）、`ca_blobs`（存云存储 `fileID`）。云端依旧只见密文。

```ts
// 只抄一串恢复码即可跨设备加入；端点与路径前缀只含连接信息，不含密钥
const a = await CloudBaseTransport.createVaultFromEnv({ keys: deriveVaultKeys(code), deviceId: deviceId() });
const b = await CloudBaseTransport.joinVaultFromEnv({ recoveryCode: code, deviceId: deviceId() });
```

环境变量（`cloud/sync-cloudbase/.env.example`）：`TCB_SYNC_BASE_URL`、`TCB_SYNC_PATH_PREFIX`、
`TCB_SYNC_EXTRA_HEADERS`；云函数侧 `TCB_ENV_ID`（云函数内免密钥）。部署步骤与上线前
需要核对的 SDK 版本差异见 `cloud/sync-cloudbase/README.md`。

零账号验证：`npx vitest run test/cloudbase-sync.e2e.test.ts`（16 例，用内存版云数据库 /
云存储替身跑**生产** `CloudBaseSyncStore`，经真实云函数入口注入客户端，覆盖网关事件、
base64 二进制、E2EE 推拉、CAS 事务回滚、blob 往返、跨设备加入与三通道契约一致）。

两端点联调脚本已支持切换：

```bash
SYNC_TRANSPORT=cloudbase SYNC_BASE_URL=https://<env>.<region>.app.tcloudbase.com \
SYNC_PATH_PREFIX=/sync-api npx ts-node scripts/sync-smoke.ts
```

### 任意 Linux 服务器自建同步服务（2026-11-09 已落地，当前首选）

用户决定复用账号下已有的腾讯云轻量应用服务器（`Hermes Agent-5bQx`，公网 `106.55.30.22`，
广州，2 核 2G）跑同步服务。本包 `cloud/sync-server/` 与 Cloudflare Worker / CloudBase 跑**同一套**
`/v1` 协议与 `cloud/sync-worker/src/handler.ts`，只把存储换成 **SQLite + 磁盘 blob**，因此是
**零协议改动**的第三套后端实现——也证明「换云厂商 = 换一个 `SyncStore` + 入口，业务代码一行不改」。

| 层 | 文件 | 作用 |
|---|---|---|
| 存储 | `src/sqlite-store.ts` | `SyncStore` 的 SQLite 实现：vaults / devices / events 落库，blob 走磁盘内容寻址（重传幂等）；CAS 靠 `PRIMARY KEY(vault_id, seq)` 冲突整批回滚 |
| 入口 | `src/server.ts` | 原生 http 请求 ↔ Web `Request`，转调 handler，再把 `Response` 转回原生响应 |
| 启动 | `src/index.ts` | polyfill `globalThis.crypto`，读 `PORT / DATA_DIR / DB_PATH / BLOB_DIR` 启动 |

本地构建与全链路自检（E2EE 推拉、CAS、blob 往返、跨 vault 隔离、未授权 401 共 8 组用例全过）：

```bash
cd cloud/sync-server
npm install
npm run build      # 产出 dist/index.js（external better-sqlite3）
npm run smoke       # 本地起临时 SQLite + HTTP，跑完整协议自检
```

部署到服务器（完整步骤见 `cloud/sync-server/README.md`）：上传 `dist/` + `package.json`
→ `npm install --omit=dev` → `node dist/index.js`（默认监听 `0.0.0.0:8788`）。前面用 Caddy / Nginx
反向代理提供 HTTPS（客户端 `RemoteSyncTransport` 强制 https；有域名时 Caddy 自动签发最省事）。
部署后 `BASE_URL=https://<你的域名> npm run smoke` 可做远端自检。

客户端只需把 `baseUrl` 指向上面的 https 域名——`RemoteSyncTransport` 本就厂商无关，
无需任何厂商专属适配器：

```ts
const a = new RemoteSyncTransport({ baseUrl, keys: deriveVaultKeys(code), deviceId: deviceId() });
```

### 真实账号部署进展（2026-11-08，Cloudflare 链路已冻结待定）

已在该 Cloudflare 账号落地：D1 `career-agent-sync`（`9970f317-1b20-4d47-be5c-137b69e6216d`，
`schema.sql` 已应用 3 张表）、Worker `career-agent-sync`（`https://career-agent-sync.shenge-work.workers.dev`）；
本机 `wrangler` 已有该账号 OAuth 授权。

**当前线上是「事件通道版」**：R2 订阅仍停在 Dashboard 结账页（需账单 / 卡信息，由用户手动完成），
所以临时用 `wrangler.events-only.toml`（去掉 `[[r2_buckets]]` 绑定）部署。订阅开通并创建
`career-agent-sync-blobs` 桶后用主 `wrangler.toml` 重新 `npm run deploy` 即为完整版。

**网络限制（实测）**：`*.workers.dev` 在当前环境走代理返回 `502 CONNECT tunnel failed`、直连超时，
用户 Chrome 也是错误页；账号目前没有自有域名 zone，公网联调需先在 Dashboard `Add a domain`
并给 Worker 绑自定义域名（或换可达网络）。`wrangler dev` 的远程 D1 绑定通道报 Cloudflare
`internal error`，但同一 SQL 经 `wrangler d1 execute --remote` 正常，判定为 Wrangler 远程绑定链路问题，
不是 Worker 代码问题。

**已在真实 Workers 运行时验证**（本地 D1 副本，`scripts/sync-smoke.ts`）：health、建 vault、
加密 push、pull 解密还原业务行、CAS 冲突、另一设备 joinVault 全部通过。

```bash
# 本地 Workers 运行时联调（先 npm run db:init:local + wrangler dev）
SYNC_BASE_URL=http://127.0.0.1:8787 SYNC_SKIP_BLOB=1 npx ts-node scripts/sync-smoke.ts
# 自定义域名就绪后：换成 https 域名并去掉 SYNC_SKIP_BLOB，即可跑含 blob 的完整联调
```

### 接云已全部落地（2026-11-09）· 剩余非阻塞项

✅ **Sync Engine 本体**（`src/server/sync/engine.ts`）：pull → push → GC 三阶段各自独立游标，
基线全量首传 / 增量 `change_log` 推拉 / 断点续传 / CAS 重试 / 回灌调度，`sync_state` 表持久化游标。
✅ **前端 `#/sync`**：启用同步、一次性恢复码展示与复制、另一台设备加入、立即同步、进度与冲突入口。
✅ **blob 云端引用计数 GC**：本地删 ≠ 云端删，`knownBlobs` 比对引用集走 `deleteBlob`（transport 全链路已加）。
✅ **真实服务器部署联调**：`cloud/sync-server/` 已部署到腾讯云轻量服务器 `106.55.30.22` 并开 HTTPS
（自签名 TLS，生产端点 `https://106.55.30.22`），公网端到端 smoke 全过。

**剩余非阻塞项**：`#/sync` 桌面端手测、两台真实设备恢复码加入实测（等桌面安装包发布）；
服务器 2026-12-08 到期需续费；有域名后换 Let's Encrypt 去掉客户端 `insecureTls`。

以上都不影响当前单机功能：断网、无云账号时本地全部可用。完整技术方案见
`docs/技术设计方案/云同步技术设计方案.md`。

**数据目录**：桌面客户端已自动把 `CAREER_AGENT_DATA_DIR` 设到用户可写的绝对路径
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
HttpOnly；AI 上游只放行 https 公网 / http 回环。桌面版首次建号端点 `/api/setup/bootstrap`
只在 `users` 为空时可写，等价于本机 `seed:user` CLI。**≤10 人本机内测安全模型**——对外部署前
先过 [docs/v2重构归档/04-运行维护与后续路线.md](./docs/v2重构归档/04-运行维护与后续路线.md) §6 的内测前清单。

## 📁 文档

- [docs/v2重构归档/](./docs/v2重构归档/README.md)：v1→v2 重构全记录（选型、架构、逐阶段验收、运维）
- [docs/技术设计方案/](./docs/技术设计方案/)：技术设计方案（含 [云同步技术设计方案](./docs/技术设计方案/云同步技术设计方案.md)、[数据采集与统一导入](./docs/技术设计方案/数据采集与统一导入-技术设计方案.md)）
- [docs/需求文档/](./docs/需求文档/README.md)：需求清单（D/N 编号）
- [docs/桌面客户端.md](./docs/桌面客户端.md)：Windows / macOS 客户端架构、打包、数据目录与排障
- [ROADMAP.md](./ROADMAP.md)：路线图（含 v1 退役后待补能力清单）
- [CHANGELOG.md](./CHANGELOG.md)：变更记录

## ⚖️ 已退役（v1 能力，不再维护）

file:// 单文件离线版、**v1 的** Tauri 桌面 / 安卓打包（v2 桌面端已用 Electron 重新实现，见上）、CI 三平台发版、飞书同步（OAuth / Device Flow /
云盘版本）、localStorage / IndexedDB 降级存储、本地 `data/*.json` 文件写入。
其中「投递体检、JD 匹配分析、Word/TXT/MD 导出、撤销/重做、主题模板」等编辑能力
列于 [ROADMAP](./ROADMAP.md) 待在 v2 分期重建。

## License

MIT

> AI生成
