# 路线图（Roadmap）

2026-11-04 起项目切换为**本地服务器形态**（v2 成为唯一主线）：v1 代码退役，渲染引擎资产
收编至 `legacy/`。重构全记录见 [docs/v2重构归档/README.md](./docs/v2重构归档/README.md)。

状态图例：📋 规划中 · 🚧 进行中 · ✅ 已完成 · ⏸ 暂不实施

---

## ✅ 已完成（本轮切换，2026-11-04）

- ✅ **v2 升级为项目主目录**：`v2/*` 上移至仓库根，v1 代码全部移除（git 历史可追溯），
  渲染引擎 8 个 JS / style.css / html2canvas / jspdf / boss-collect 收编至 `legacy/`。
- ✅ **飞书远程存储整体拆除**：sync 模块、三张 sync 表（`0004_drop_sync.sql`）、
  OAuth 回调豁免、前端配置面板全部移除；AI 的 `ai.config.json` 文件回退同步移除。
- ✅ **版本历史结合 PostgreSQL 重新设计**：`POST /api/resumes/:id/versions/:versionId/restore`
  ——恢复前当前内容自动存为新版本（恢复可逆）；保留策略：手动快照永不清理、
  自动留痕最近 50 条全保 + 更早按每天首尾 2 条 + 30 天窗口降采样（v1 N11 策略的服务端化）。
- ✅ **公司档案 D7 第一批**：行业分类词表与同义词检索、卡片化列表、详情完整度/摘要、
  Markdown 简报（详见 [D7](./docs/需求文档/D7-公司档案板块设计.md) 实施记录）。

---

## 📋 高优先级：v1 退役后待补的编辑与投递能力（在 v2 分期重建）

> v1 的这些能力未随切换迁移，按价值排序分期在 v2 重做（技术形态全部改为服务端 + React）。

- 📋 **多格式导出**：Word（.docx 真 OOXML）/ TXT / Markdown——求职刚需，v1 已有成熟纯函数可移植。
- 📋 **投递体检**：页数 / 内容完整性 / 量化 / ATS 友好度 / 敏感信息三级检查（v1 `audit.js` 规则移植）。
- 📋 **JD 匹配分析 + JD 派生**：粘贴 JD → 已覆盖 / 弱覆盖 / 缺失三档 + 一键生成定制版简历
  （v1 `jd-match.js` / `jd-derive.js` 移植；v2 已有血缘字段 `parentId/kind/jobId` 落点）。
- 📋 **撤销 / 重做**：编辑器级撤销栈（按简历隔离、输入框内放行原生撤销）。
- 📋 **简历模板系统**：多主题模板画廊 + **一键换模板**（D8 设计的模板部分，v1 `theme-templates.js` 5 套主题可移植）。
- 📋 **简历缩略图仪表盘**：库页卡片渲染迷你预览（v1 N5 的 `buildResumeHtml` 受保护交换思路）。
- 📋 **面试逐字稿 / 求职准备材料**（D8 关联设计）：挂投递维度的自我介绍 / 项目逐字稿 / 常见问答。

## 📋 中优先级：产品深化

- 📋 **D7 后续批次**：图片相册（服务端媒体目录 / 未来对象存储）、薪资 / 融资 / 转型 SVG 图、
  多公司对比、批量粘贴导入、简报 PNG 图片版、面经与待核实清单（见 D7 §八 P1）。
- 📋 **D8 简历库重设计实施**：他人简历借鉴库（上传 / 阅读 / 借鉴标注）、模板参考库、
  一键换模板（见 [D8](./docs/需求文档/D8-简历库重设计-借鉴库与模板.md)）。
- ✅ **本地对象存储（可同步版，2026-11-08）**：`blobs/` sha256 内容寻址 + `attachments` 元数据表 +
  `change_log` 同步 outbox（HLC / device_id / 软删除墓碑）+ `BlobStore` 可替换接口；
  上传流式写盘、鉴权读取、magic number 白名单；前端 `#/attachments` 附件库（上传 / 预览 /
  下载 / 归属筛选 / 软删除 / 增量预览）。图片相册 / 借鉴库等上层业务可直接复用。
- ✅ **全业务表增量日志（0010，2026-11-08）**：12 张业务表的 AFTER INSERT/UPDATE/DELETE
  触发器自动写 `change_log`，与业务写同事务、应用代码零侵入；物理删除留下 delete 墓碑，
  游标由 DB 单序列统一授时（严格单调，同毫秒不漏），敏感列不进 outbox。
  `seed:user` 也统一走 `CAREER_AGENT_DATA_DIR`。
- ✅ **业务表同步语义 / 冲突地基（0011，2026-11-08）**：12 张业务表统一 `hlc / device_id /
  deleted_at`，DB 触发器统一授时且能 observe 远端；8 张实体表改软删除墓碑 + 读过滤 + 同 id 复活；
  跨设备回灌按 HLC 做 LWW 并把落败方整行留进 `conflict_snapshots`；`tracker.chat[]` 投影成
  append-only 事件流；回灌窗口跳过 `change_log` 防成环，`/api/sync/*` 只读审计接口。
  真实库已迁移并备份。至此「本地侧冲突地基」完成，接云只需做云端与传输部分。
- ✅ **冲突恢复 UI（0012，2026-11-08）**：`conflict_snapshots` 加 `status / resolved_at /
  restored_from` 状态机；`restore.ts` 把落败方业务列翻译回本地写（新 HLC、本机归因、
  `change_log` 增量，绝不回拨时钟），事务内给被换下的当前版本留 `resolution='restore'` 快照，
  可来回切换；`POST /restore` / `DELETE` 忽略 / 状态筛选齐全，跨用户 404、重复操作 409。
  前端 `#/conflicts`：筛选、原文 JSON、二次确认恢复、忽略、深链到业务记录。真实库已迁移并备份。
- ✅ **云端哑云服务 + 客户端适配器（2026-11-08）**：`cloud/sync-worker/`（Workers + D1 + R2，
  `schema.sql` / `wrangler.toml`）与 `src/server/sync/cloudflare-transport.ts`。云端只做授权 /
  分配 seq / 存密文：D1 三张表、`events` 主键承担 CAS 并发回滚，R2 存已加密 blob；
  客户端 `createVault / joinVault / attach` 与离线包实现同一个 `SyncTransport`。
  恢复码自包含公开 salt，另一台设备只抄一串码即可加入。  两套端到端测试（内存 Store 与
  D1/R2 替身）零账号零网络验证全链路。
- 🚧 **真实账号部署联调（2026-11-08 进行中）**：D1 `career-agent-sync` 已建表、Worker 已部署到
  `career-agent-sync.shenge-work.workers.dev`、本机 wrangler 已授权；在真实 Workers 运行时用
  `scripts/sync-smoke.ts` 跑通 health / 建 vault / E2EE 推拉 / CAS / 跨设备加入。阻塞项：
  ① R2 订阅仍停在 Dashboard 结账页（需用户手动提交账单与卡信息），当前线上为去掉 R2 绑定的
  「事件通道版」；② `*.workers.dev` 在当前网络代理 502 / 直连超时，公网联调需绑定自定义域名或换网络；
  ③ `wrangler dev` 远程 D1 绑定报 Cloudflare internal error（同一 SQL 经 `d1 execute --remote` 正常），
  判定为 Wrangler 远程绑定链路问题。详见 README「真实账号部署进展」。
  **2026-11-09 用户决定此链路冻结待定**，先接境内可用通道，代码与部署配置全部保留。
- ✅ **腾讯云 CloudBase 通道（2026-11-09 已接入，未部署）**：用户拍板「Cloudflare 先待定，
  先接腾讯 CloudBase 用着先」，并选择只做代码 + 本地模拟（不创建云资源、不产生费用）。
  `cloud/sync-cloudbase/`：`gateway.ts` 做 HTTP 访问服务事件 ↔ `Request/Response`，
  `app.ts` 复用同一份 Worker handler，`cloudbase-store.ts` 用 `runTransaction` 快照隔离实现
  CAS（云数据库存密文事件 + 云存储存密文 blob），`index.ts` 收敛 node-sdk 版本差异；
  `src/server/sync/remote-transport.ts` 抽出厂商无关协议逻辑，
  `CloudflareTransport` 静态 API 零回归，新增 `CloudBaseTransport`（`pathPrefix` / 环境变量入口）。
  `scripts/sync-smoke.ts` 支持 `SYNC_TRANSPORT` 切换两端点。16 例零账号端到端测试 + 全套
  287 通过 / 3 跳过；主 tsc、Worker / CloudBase 源码独立 tsc、esbuild 云函数打包、`npm run build` 均通过。
  下一步需真实账号：建四个集合、部署云函数、核对 SDK 适配层与配额。
- ✅ **云同步全线落地（2026-11-09）**：`0013_sync_state`（per-user 同步状态表）+ `0014_stale_echo_guard`
  （堵「陈旧回声」回退洞）+ `sync/engine.ts`（pull→push→GC 三阶段独立游标、基线全量首传、增量
  change_log、CAS 重试、附件 blob 先传后推、双端 GC）+ `sync/sync-cloud.service.ts` + controller
  （status/setup/disable/sync/recovery）+ transport 全链路 `deleteBlob` + 前端 `#/sync` +
  `test/sync-engine.e2e.test.ts`(7 例)；`referrals` 纳入 10 张同步表。真实服务器 `106.55.30.22`
  已部署上线（自签名 TLS，公网 smoke 全过）。完整方案见 `docs/技术设计方案/云同步技术设计方案.md`。
- 📋 **P5 切真 PostgreSQL**：`drizzle-orm/pglite` → `node-postgres`，迁移 SQL 方言一致可直接复用；
  先补对照测试（步骤见 v2 重构归档 04 §5）。
- 📋 **STAR 经历素材库**：跨简历复用的经历片段（v1 `snippet-library.js` 移植，落 PG 表）。
- 📋 **分享与权限**：`share_grants` 表已建，接入 API 即可解决「shareToken 无远程吊销」的历史限制。
- 📋 **暗色模式切换**（v2 前端变量体系已就位，缺切换入口）。

## ⏸ 暂不实施

- ⏸ **AI 写作闭环**（润色 / 诊断 / 逐字稿起草）：AI 转发层与试用台已就绪，写作流程等 D8 落地后接。
- ⏸ **JSON Resume 互通 / PDF 解析导入**：v1 有成熟实现，待简历库形态稳定后移植（D8 关联）。
- ⏸ **个人求职官网导出**（Portfolio）。
- ⏸ **公开注册 / 邮箱找回 / 云端托管服务**：产品定位调整为 **local-first**（本地永远完整可用，
  云只是可选备份与跨设备同步通道，断云不降级）。本地侧已备齐：`BlobStore` 接口、
  覆盖附件与全部业务表的 `change_log` 增量（含删除墓碑）、严格单调游标、前端附件库、
  真实数据目录迁移、0011 的业务表 HLC / 软删除 / 冲突快照 / chat 事件流与回灌门面，
  以及 0012 的冲突恢复 UI。2026-11-08 云端选型已定稿：**哑云 + E2EE + 可替换 SyncTransport**
  （云端不建业务库，只做授权 / 分配 seq / 存密文），已落地协议契约、恢复码密钥体系与
  离线增量包适配器（无需任何云账号即可验证全链路）。  **已拍板 Cloudflare Workers + D1 + R2 +
  恢复码 E2EE**；境内合规备选腾讯云 CloudBase / COS，自建 NestJS 留给将来多用户 SaaS，Supabase 否决。
  云端四端点 / D1 schema / wrangler 配置与客户端 `CloudflareTransport` 已落地并经零账号端到端验证。
  2026-11-09 追加腾讯云 CloudBase 作为境内可用通道（同一 `/v1` 协议，只换运行时与存储），
  Cloudflare 链路暂时冻结待定。**Sync Engine 本体（全量首传 / 增量推拉 / 断点续传 /
  回灌调度 / `sync_state` 表）、前端 `#/sync`、blob 云端引用计数 GC 均已于 2026-11-09 落地，
  并完成腾讯云轻量服务器 `106.55.30.22` 真实部署上线（自签名 TLS，公网 smoke 全过）**。
  剩余非阻塞项：`#/sync` 桌面端手测、两台真实设备恢复码加入实测（等安装包发布）、
  服务器 2026-12-08 到期续费。完整方案见 `docs/技术设计方案/云同步技术设计方案.md`。

## ❌ 已否决 / 随 v1 退役

- ❌ file:// 单文件离线版、Tauri 桌面 / 安卓打包、CI 三平台发版流水线。
- ❌ 飞书同步（OAuth / Device Flow / 云盘版本）——版本能力由本地 PostgreSQL 承接。
- ❌ localStorage / IndexedDB 降级存储、本地 `data/*.json` 文件写入。
- ❌ 服务端账号体系对外注册（数据可移植性由 JSON 导入导出覆盖）。

> AI生成
