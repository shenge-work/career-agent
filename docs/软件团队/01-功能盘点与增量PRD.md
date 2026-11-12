# 01 · 全项目功能盘点、优化候选池与增量 PRD

> 撰写人：许清楚（产品经理） · 轮次：软件团队首轮（主理人齐活林派单 · 任务 #1）
> 范围：**只出文档，不修改任何源码**；结论作为架构师代码审查与选点的输入。
> 用户原始诉求：「请查看整个项目架构及功能，审查代码及实现逻辑，挑选一个你觉得可以优化的功能进行打磨」。
> 关键理解：本轮打磨的对象必须是**现有功能**（体验缺口 / 交互一致性 / 健壮性 / 数据安全 / 性能 / 信息架构），
> 不是按 ROADMAP 从零新建大模块。

---

## 0. 盘点口径与一条重要发现

本报告的「现有功能」以**代码为准**（`src/web/App.tsx`、`src/web/pages/`、`src/server/`），
README / ROADMAP 仅作历史背景参照。原因：

> **README「当前功能」与 ROADMAP「待补能力」已明显滞后于实际代码。**
>
> - `App.tsx` L80–101 实际注册了 **22 条业务路由**（另有 `*` 兜底），README L69–95 的「当前功能」与派单背景中的
>   13 条 HashRouter 清单均不完整；`Layout.tsx` L7–31 的侧栏只有 14 个入口，深链页靠列表页跳转。
> - ROADMAP L28–35 列为「📋 待补」的 **多格式导出 / 投递体检 / 撤销重做 / 简历缩略图**，实际均已落地：
>   `Editor.tsx` L1073–1102（体检 + txt/md/doc + 两种 PDF）、L1182–1183（撤销/重做按钮）、
>   `Library.tsx` L21–42（缩略图 iframe）。
> - ROADMAP L95「暗色模式切换（缺切换入口）」也已落地：`Account.tsx` L138–155 已有主题卡 + `theme.ts` 全套。
> - `App.tsx` L39–46 已实现「服务端 settings 覆盖本地主题缓存」；`Library.tsx` L111–124 已有 JD 解析/派生、
>   排序与分页；`Snippets.tsx` / `Portfolio.tsx` / `Interview*.tsx` / `CompanyCompare.tsx` 均为已上线模块。
>
> 因此本轮**不能照 ROADMAP 选题**，否则会把已完成的工作当成新需求重做一遍。
> 文档滞后本身登记为候选 G（P2），但仅改文档不构成「打磨一个已有功能」，不作本轮主选。

**技术形态复核**（与派单一致）：NestJS 12 + Fastify 5 + Drizzle + PGlite（`pgdata/`）、
React 19 + Vite 8 SPA（`HashRouter`）、`legacy/` vm 沙箱渲染、`blobs/` sha256 内容寻址、
云同步「哑云 + 恢复码 E2EE」、`0010`~`0014` 迁移、Vitest（`vitest.config.mts` L5 `environment: 'node'`、
L6 `include: ['test/**/*.test.ts']`，共 34 个测试文件）、Electron 壳在 `desktop/`。
服务端 19 个业务模块见 `src/server/app.module.ts` L20–39，控制器前缀见附录 A。

---

## 1. 现有功能模块清单

| # | 功能模块 | 前端路由 / 页面 | 服务端入口 | 主要能力 | 备注 |
|---|---|---|---|---|---|
| 1 | 账号、行级隔离、会话 | `#/login`、`Layout` 账户菜单、`#/account` | `auth/*`、`users/*`、`tenant/tenant-db.ts`、`setup/*` | Argon2id + HttpOnly 会话、登录限流、`TenantDb.forUser` 行级隔离、跨用户 404、桌面端首次建号向导、成员管理、settings 合并更新、UI 明暗主题 | `Account.tsx` 含主题卡与原始 JSON 两种编辑入口 |
| 2 | 总览仪表盘 | `#/` → `Home.tsx` | `business/applications.controller.ts` 等 | 关键指标、该跟进提醒、投递漏斗、最近动态 | 三个 `useQuery` 均无 error 渲染（见候选 F） |
| 3 | 岗位 / 投递主线 | `#/applications`、`#/applications/:id` | `applications.controller.ts` / `business.service.ts` | 岗位 CRUD、状态机、事件流、简历/JD/公司关联、跟进天数 | README 未提到该模块 |
| 4 | 简历库 | `#/resumes` → `Library.tsx`（624 行） | `resumes/*`、`business/versions.controller.ts`、`jd.controller.ts` | 多简历 + 主简历、缩略图 iframe、排序/分页、详情、手动/自动版本历史 + 恢复、JD 解析与派生 | 无搜索/筛选（见候选 D） |
| 5 | **双栏简历编辑器** | `#/editor/:id` → `Editor.tsx`（1296 行，全站最大页面） | `resumes.service.ts` `PUT`、`render/*` | 左 A4 实时预览（iframe + vm 沙箱，同源高度自适应/缩放）/ 右语义表单 + 原始 JSON、800ms 防抖自动保存、撤销重做、5 套简历主题、投递体检、STAR 素材插入、矢量/图片双 PDF、txt/md/doc 导出 | **本轮推荐打磨对象**（见 §3） |
| 6 | 公司档案 | `#/companies`、`#/companies/:id`、`#/companies/compare` | `companies.controller.ts`、`business/jd.controller.ts` | 六维调研、JD、行业检索、Markdown 简报、内推关联、多公司对比 | 详情页 1255 行，多处 `patchM` 并发覆盖风险（候选 C） |
| 7 | 内推管理 | `#/referrals` | `referral/*` | 内推人/渠道/内推码/有效期/跟进节奏/状态，公司自动关联，逾期与 3 天内跟进标记 | 表单显式提交 + 二次确认删除 |
| 8 | 投递追踪 + 采集 | `#/tracker`、`#/tracker/:id` | `tracker.controller.ts`、`collect/*` | 状态管理、公司只读回链、BOSS 直聘聊天采集（本机 Chrome 调试端口，直写库去重） | chat append-only 投影属同步地基，勿动 |
| 9 | 附件库 | `#/attachments` | `attachments/*`、`storage/blob-store.ts` | 拖拽/多选上传（20MB）、sha256 内容寻址去重、magic number 白名单、图片/PDF 预览、软删除、归属筛选、同步增量预览、鉴权字节流 | 批量上传仅汇总失败（候选 E） |
| 10 | 云同步 / 冲突恢复 | `#/sync`、`#/conflicts` | `sync/*`（engine / transport / crypto / restore / sync-import） | 恢复码 E2EE、pull→push→GC 三阶段游标、离线包 / Cloudflare / CloudBase / 自建服务器四通道、冲突快照列表 + 恢复 + 忽略 + 深链 | **高危底座，本轮铁律：一律不碰** |
| 11 | AI 能力 | `#/ai`、`AiSettings.tsx` | `ai/*`、`agent/*` | OpenAI 兼容上游配置（Key 只存服务端、GET 不回显）、流式试用台、用量统计、Agent 提示词 | `⏸ AI 写作闭环` 仍暂不实施 |
| 12 | 面经库 / 面试复盘 | `#/kb` | `interview/*` | 面经条目、面试复盘 | 与练习模块打通 |
| 13 | AI 面试练习（N14） | `#/interview`、`#/interview/growth`、`#/interview/:sessionId` | `practice/*`（1046 行 service） | 练习会话、出题/追问/重试、6 维评分、自评、范例答案、弱点沉淀、成长曲线、导出面经 | **答题草稿已有 800ms 防抖 + blur + beforeunload + keepalive**（`InterviewSession.tsx` L38、L81–111）——重要参照 |
| 14 | 经历素材库（STAR） | `#/snippets` | `snippet/*` | 跨简历复用片段、一键插入为高亮卡 | 已落地（ROADMAP 仍列待补） |
| 15 | 作品集 / 官网导出 | `#/portfolio` | `portfolio/*`、`git-publisher.ts` | 模板、布局、Git 发布 | 已落地（ROADMAP 曾列「暂不实施」） |
| 16 | 桌面壳 | `desktop/` | `setup/*` | Electron 内嵌同一 NestJS 服务、数据目录隔离、打包/冒烟自检 | 与业务代码解耦 |

### 1.1 主要用户旅程

| 旅程 | 触发入口 | 关键步骤 | 涉及模块 | 现有体验缺口 |
|---|---|---|---|---|
| J1 首次使用 | 桌面端建号向导 / `#/login` | 建号 → 登录 → 总览（空态）→ 新建简历 | 1、2、4 | 总览数据加载失败被静默成「0 条」（候选 F） |
| J2 打磨母简历 | `#/resumes` → 缩略图 → `#/editor/:id` | 右栏改字段 → 800ms 自动保存 → 左栏预览刷新 → 换主题 / 体检 / 导出 PDF | 5、9 | **保存失败不可恢复、离开丢改动、并发乱序**（候选 A，推荐） |
| J3 版本回溯 | `#/resumes` 选中简历 → 版本列表 | 手动快照 / 自动留痕 → 一键恢复（恢复前自动备份） | 4 | 无明显缺口；恢复链路已有单测 |
| J4 JD 定制版 | `#/resumes` → JD 解析 → 派生 | 贴 JD → 解析关键词 → 生成派生版 → 关联岗位 | 4、3 | 无明显缺口 |
| J5 公司调研 | `#/companies` → 详情 | 六维录入 → 生成 Markdown 简报 → 关联内推/JD | 6、7 | 详情页多个 mutation 基于旧 payload 浅合并，快速连点可能互相覆盖（候选 C） |
| J6 投递闭环 | `#/applications` / `#/tracker` | 建岗位 → 关联简历 → 状态流转 → BOSS 聊天采集 → 跟进提醒 | 3、8、2 | 跨页跳转靠手动，信息分散 |
| J7 面试准备 | `#/interview` → 练习会话 | 出题 → 答草稿（防抖自动保存）→ 评分 → 弱点 → 成长曲线 → 导出面经 | 13、12 | 草稿保存失败被 `.catch(() => {})` 吞掉，UI 仍显示「草稿已自动保存」（候选 B） |
| J8 跨设备 | `#/sync` → 恢复码 → 另一设备加入 | 启用 → 立即同步 → 冲突快照 → `#/conflicts` 恢复 | 10 | 剩余项均为部署/手测，非功能缺口；**本轮禁区** |
| J9 附件归档 | `#/attachments` / 业务页深链 | 拖拽上传 → 归属标记 → 预览/下载 → 软删除 | 9 | 批量上传无逐项进度、失败无法只重试失败项（候选 E） |

---

## 2. 优化候选池（8 个，按 P0 / P1 / P2 排序）

> 「改动面」= 预计触及文件数量级；「风险」= 回归风险，尤其是否触碰 `drizzle/`、`src/server/sync/`、`tenant-db.ts` 等底座。

| 编号 | 优先级 | 所属现有功能 | 现状痛点（代码依据） | 用户价值 | 改动面 | 风险 | 本轮适合度 |
|---|---|---|---|---|---|---|---|
| **A** | **P0** | 简历编辑器 · 800ms 自动保存 | `Editor.tsx` L764–795：失败仅置 `status='error'` + `error` 文本，**无重试入口**；effect 依赖 `[draft,id]`，失败后 draft 不变即**永不再触发保存**，用户得再瞎改一个字碰运气。L774 `setError('')` 与 L927–983 导出/JSON/主题共用同一个 `error` 槽，失败原因被冲掉；多个 `saveM.mutate` 可并发在飞，服务端 `resumes.service.ts` L32–52 整份 payload 覆盖且无乐观锁，旧请求晚到会回滚新内容；全站 `beforeunload` 只见于 `InterviewSession.tsx` L98–111，**编辑器无离开保护**；L1036–1039 idle 显示「已同步」/ saved 显示「已保存」文案不一致 | 简历是核心资产；local-first 下「静默保存失败 / 关页丢失 / 版本倒退」= 真实数据丢失 | **4 个文件**：`Editor.tsx`、新增纯状态机模块、`styles.css`、新增 1 个 Vitest 测试 | 低（纯前端、API 契约/DB/同步全不动） | ✅ **最适合**：单功能、可纯函数单测、有同产品成熟范式可复用 |
| B | P0 | AI 面试练习 · 答题草稿 | `InterviewSession.tsx` L83 `savePracticeDraft(...).catch(() => {})`、L108 `.catch(() => {})` 吞掉失败，L289 UI 恒显示「草稿已自动保存 · N 字」，属**假成功** | 高：用户以为答案已存，实则丢失 | 2 个文件（`InterviewSession.tsx` + 测试） | 中（练习会话状态机复杂、依赖 AI 上游，回归面大于 A） | ❌ 不适合本轮：与 A 同源但跨模块，同轮做会变成「两处功能」；建议下一轮复用 A 的状态机统一治理 |
| C | P1 | 公司档案详情 · 六维编辑 | `CompanyDetailPage.tsx` L126–155：`metaM / linksM / patchM` 各自以 `...(company?.payload)` 浅合并后整份 PUT，L382/424/710/873/905 等多处快速连续提交会基于同一份旧 payload，**后写吃掉先写** | 中高：调研录入密集，丢字段不易察觉 | 3~5 个文件（1255 行页面 + 可能新增纯 reducer + 测试） | 中高（表单众多，验收矩阵大） | ❌ 不适合本轮：页面过大、回归成本高 |
| D | P1 | 简历库 · 列表 | `Library.tsx` L121–124、L239–251、L266–289：只有新建 / 排序 / 分页，**无搜索与 kind 筛选**；`page` 为简单 `slice`，删除末页记录后 `page` 越界会显示空白且无自动回退 | 中：简历/派生版变多后找不到目标 | 2 个文件（`Library.tsx` + 纯函数测试） | 低 | ⚠️ 可做但偏「补新能力」，价值低于核心资产安全；且不是「打磨」而是加功能 |
| E | P1 | 附件库 · 批量上传 | `Attachments.tsx` L141–169：多文件串行上传，全局单一 `busy`，无逐项进度/成功失败明细；失败只在结尾 `setError(failures.join('；'))`，**无法只重试失败的文件**；20MB 校验发生在循环内而非拖拽时 | 中：一次拖 10 个文件时体验差 | 2~3 个文件 | 低（但涉及 `blobs/` 上传链路，需回归附件 e2e） | ⚠️ 可做，改动可控；但用户价值与「数据安全」不在一个量级 |
| F | P1 | 总览仪表盘 · 错误态 | `Home.tsx` L25–36：三个 `useQuery` 均用 `data = []` 兜底且**无 error 渲染**，接口失败时页面显示「总投递 0 / 进行中 0」，用户误判为空数据 | 中高：误导性展示 | 1~2 个文件（`Home.tsx`；若要全站统一则 >10 文件） | 低 | ⚠️ 只改总览可行，但「全站一致性」才彻底，单页修复收益有限 |
| G | P2 | 文档 / 信息架构一致性 | `README.md` L69–95、`ROADMAP.md` L24–35/L95 与 `App.tsx` L80–101、`Layout.tsx` L7–31、`Editor.tsx` L1073–1102 大面积不符（详见 §0） | 中（对维护者高、对终端用户低） | 2 个文件（纯文档） | 极低 | ❌ 本轮不作主选：只改文档不是「打磨已有功能」，可作为 A 完成后的顺带修订 |
| H | P2 | 账号设置 · settings 编辑 | `Account.tsx` L35–38（settings 变更覆盖 JSON 文本框）、L74–82（整份 JSON 提交）、L138–155（主题卡只 `mutate({theme})`）：两种入口并存，先编辑 JSON 再点主题卡 / 反之，会互相覆盖未提交的编辑 | 中低：低频设置页 | 2 个文件 | 低（但 settings 参与跨设备主题同步，需小心 `App.tsx` L39–46） | ❌ 价值最小，且靠近同步 settings 语义，性价比低 |

**排序结论**：A > B > C > E ≈ F ≈ D > G > H。
**推荐 A** 为唯一本轮打磨目标；B 是最值得「下一轮复用同一状态机」的跟进项。

---

## 3. 推荐项：A · 简历编辑器自动保存链路健壮性与防丢失打磨

### 3.1 为什么是它（对照硬性约束）

| 硬约束 | 本项如何满足 |
|---|---|
| 必须是**已有功能**的打磨 | 「800ms 自动保存」是 README L74–77 明确写的核心卖点，`Editor.tsx` L768–795 已实现；本轮只修它的健壮性，不加新能力 |
| **单功能** | 只动「编辑器保存链路」一条纵线；不顺带改导出、主题、体检、撤销重做、版本历史 |
| 改动文件数 ≤ 10 | 预计 **4 个**：`src/web/pages/Editor.tsx`、新增 `src/web/pages/editor-autosave.ts`（无 DOM 依赖的纯状态机/串行队列）、`src/web/styles.css`（`.save-state` 增量样式，已有 L886–895 基础）、新增 `test/editor-autosave.test.ts`；`api.ts` / 后端 / 迁移**明确不改** |
| 本地可验证 | `npm test`（`vitest.config.mts` 为 node 环境，纯函数可直接单测，无需引入 jsdom / testing-library 等新依赖）、`npx tsc -p tsconfig.json --noEmit`、`npm run build`（tsc + vite build）；UI 行为可用 dev server 手工复现（见 §4.6 验收） |
| **不得触碰高危底座** | 不改 `drizzle/*`、不改 `src/server/sync/**`（HLC / 软删除 / change_log / 回灌窗口 / E2EE）、不改 `src/server/tenant/tenant-db.ts`、不新增表/字段/迁移、不改 `PUT /api/resumes/:id` 的请求/响应契约、不改 `TenantDb` 隔离语义；git diff 可机器核验 |
| 回归风险低 | 纯前端局部改造；后端 `resumes.service.ts` 的自动留痕节流（L8–10、L54–72，2 分钟窗口）保证重试不会刷屏版本；`versions` / `resumes` 既有 e2e 可直接当回归网 |

### 3.2 额外说服力：同产品内已有成熟范式，属于「交互一致性」欠账

`InterviewSession.tsx` L38、L81–111 已为**答题草稿**实现「800ms 防抖 + blur 保存 + `beforeunload` keepalive flush」，
以及 L289 的草稿状态文案；而承载用户最核心资产的**简历编辑器**反而没有离开保护，且保存失败不可恢复。
本轮把编辑器补齐到（并略优于）同一水位，是典型的一致性打磨，而非发明新交互，实现风险可控。

---

## 4. 增量 PRD（简单 PRD）

### 4.1 项目信息

- **Language**：中文（全程交付、UI 文案、注释均中文）
- **Programming Language / 技术栈**：沿用现有 React 19 + TypeScript + Vite 8 + React Router 7（HashRouter）+ TanStack Query 5 + Vitest 5；**不引入任何新依赖**
- **Project Name**：`editor_autosave_hardening`
- **原始需求复述**：审查整个项目架构与实现逻辑，挑选**一个已有功能**做打磨优化。
- **本轮范围**：只打磨 `#/editor/:id` 的自动保存链路（可感知 / 可恢复 / 不丢失 / 不倒退），不改任何其它功能与底座。

### 4.2 产品目标（3 个正交）

1. **可感知**：任意时刻用户都能准确判断「改动是否已落盘」——统一状态文案、最近保存时间、错误原因可见。
2. **可恢复**：保存失败不会把编辑内容困死，用户可一键重试；失败提示不被导出/JSON/主题等其它操作覆盖。
3. **不丢不退**：离开页面前尽力写回或明确拦截；并发/乱序保存不会让旧内容覆盖新内容。

### 4.3 用户故事

- As a 求职者，I want 编辑时状态条明确显示「保存中 / 已保存 / 保存失败」，so that 我知道刚写的项目经历是否真的存下来了。
- As a 求职者，I want 保存失败时看到原因并点「重试」把**当前内容**再存一次，so that 不必靠再改一个字来碰运气，也不必重打一遍。
- As a 求职者，I want 在有未保存改动时刷新/关闭标签/返回简历库能先尽力保存或明确提示，so that 几分钟的编辑不会凭空消失。
- As a 求职者，I want 连续快速输入后落库的是我最后输入的版本，so that 不会被某个慢请求把简历回滚到上一段文字。
- As a 维护者，I want 保存状态机是纯函数且被 `npm test` 覆盖，so that 后续改动有回归网、不靠手工点。

### 4.4 需求池

**P0 · 必做**

| ID | 需求 | 可观测结果 |
|---|---|---|
| R1 | **串行化保存**：同一简历同一时刻最多一个 `PUT /api/resumes/:id` 在飞；飞行期间产生的新改动排队/合并，不并发发请求 | 网络面板无重叠 PUT；连续输入后请求数受控 |
| R2 | **请求序号与 stale 响应丢弃**：只接受最新一次保存的结果更新状态与 `baselineRef`；旧响应不得改状态、不得刷预览、不得触发多余保存 | 单测可构造「旧请求晚到」并断言状态不被回退 |
| R3 | **失败可恢复**：失败进入 `error` 态并保留 draft；状态条出现「保存失败 · 重试」与错误原因；点「重试」立即以当前 draft 发一次保存（不受「draft 未变化」限制） | 模拟 500 后点重试，恢复服务即成功落库 |
| R4 | **错误分槽**：保存错误与导出错误 / JSON 校验错误 / 主题切换错误使用独立状态；保存 effect 不再无条件清空保存错误 | 保存失败期间导出，失败提示与重试按钮仍在 |
| R5 | **离开保护**：脏状态（editing / saving / error）注册 `beforeunload`；编辑器组件卸载时以 `keepalive` 尽力 flush 当前 payload；「← 简历库」在脏状态下走 `ConfirmModal` 二次确认 | 刷新有原生确认，或刷新后重开内容为最新输入 |
| R6 | **状态文案统一**：`idle`/`saved` 统一「已保存」并附「最近保存于 HH:mm:ss」；`editing`「有未保存改动」；`saving`「保存中…」；`error`「保存失败」；状态条 `aria-live="polite"` | 页面文案无「已同步」与「已保存」并存 |
| R7 | **纯状态机 + 单测**：抽出无 DOM / 无 React 依赖的保存状态机与串行队列，`test/editor-autosave.test.ts` ≥ 8 例 | `npm test` 全绿，新增用例覆盖乱序/重试/脏标记/收敛 |

**P1 · 可选（时间允许再做，不做也不影响 P0 验收）**

- R8 失败自动重试：指数退避最多 2 次，仍失败转手动重试；避免网络抖动打扰用户。
- R9 状态条展示「排队中的待保存改动数」，让长文本连续编辑更可预期。
- R10 `README.md` 顺带修订「当前功能」清单与路由表，消除 §0 的文档滞后（仅文档，不改代码）。

**P2 · 明确不做**（见 §4.7）

### 4.5 关键交互与 UI 说明（文字描述）

- **位置不变**：编辑器头部 `.editor-head .editor-actions` 中的 `.save-state` 徽标（`Editor.tsx` L1035–1040，样式 `styles.css` L886–895 已有 `saving/editing/error` 变体）。
- **状态条扩展为三段**：① 状态徽标（文案按 R6）；② 右侧小字「最近保存于 HH:mm:ss」（无保存记录时不显示）；③ 仅 `error` 态出现内联「重试」按钮（`mini` 风格，复用现有按钮类），点击立即重试并短暂显示「重试中…」。
- **错误详情**：保存失败原因显示在状态条下方独立的一行 `.alert`（专用槽位），与导出失败 / JSON 无效提示互不覆盖、互不清除。
- **离开确认**：脏状态下点「← 简历库」弹出 `ConfirmModal`（项目已有组件，`Editor.tsx` L5 已引入），文案「有未保存的改动，确定离开吗？」，按钮「继续编辑 / 立即保存并离开 / 直接离开」；「立即保存并离开」先触发一次同步保存再跳转。
- **不改变**：双栏布局、A4 预览与缩放、语义表单字段、原始 JSON 折叠区、撤销重做、体检、主题画廊、导出菜单、快捷键，以及任何视觉主题变量。
- **可访问性**：状态条 `aria-live="polite"`，重试按钮有清晰 `aria-label`；不改变键盘操作习惯。

### 4.6 验收标准（可测试 / 可观测）

1. **自动化**：`npm test` 全量通过（基线约 294 通过 / 3 跳过，由 QA 复核），新增 `test/editor-autosave.test.ts` ≥ 8 例全通过；用例至少覆盖：乱序响应被丢弃、失败后重试成功、保存错误不被导出错误覆盖、脏标记在成功保存后清除、连续输入只落最后一次、卸载 flush 只触发一次、串行队列不并发、空/重复内容不产生多余请求。
2. **类型与构建**：`npx tsc -p tsconfig.json --noEmit` 通过；`npm run build` 成功产出 `dist-server/` 与 `dist-web/`，无新增警告性错误。
3. **功能手工验收**（dev server，可注入 `PUT /api/resumes/:id` 500 或临时停 API 复现）：
   - 编辑字段 → 800ms 内出现「保存中…」→ 成功变「已保存」+ 时间戳 → A4 预览**恰好刷新一次**。
   - 制造 500 → 状态变「保存失败」+ 原因 + 「重试」；draft 内容逐字保留；导出一次 / 切换主题后，失败提示与重试按钮仍在。
   - 恢复服务 → 点「重试」→ 一次保存成功；`GET /api/resumes/:id` 的 `payload` 与编辑内容完全一致。
   - 脏状态下刷新/关闭标签：出现浏览器原生离开确认；走 keepalive 路径时，刷新后重开编辑器内容为最新输入。
   - 连续快速输入（间隔 < 800ms）后停止：无并发重叠 PUT，最终 `GET` 内容与最后一次输入一致，未出现「已保存」但服务端是旧版的情况。
   - 「← 简历库」在脏状态弹确认；选择「立即保存并离开」后，`GET` 校验内容已落库。
4. **不变量 / 回归**：`npm test` 中 `sync-*.e2e`、`migration`、`business-change-log`、`conflict-restore`、`versions`、`render`、`export` 等既有用例全部保持通过；`git diff --name-only` 中**不存在** `drizzle/`、`src/server/sync/`、`src/server/tenant/tenant-db.ts`、任何 `.sql` 迁移文件、`src/server/resumes/resumes.service.ts` 的改动。
5. **范围**：改动文件数 ≤ 10（预期 4~5），无新增 npm 依赖，无 API 契约变更。
6. **技术注意（交架构师决策）**：`fetch(..., { keepalive: true })` 的请求体有浏览器体量上限，简历 payload 偏大时应退化为「阻止关闭 + 提示用户手动保存」，不得静默丢弃；`beforeunload` 只在脏状态注册，保存成功后必须解绑，避免污染其它页面；SPA 内由侧栏 `NavLink` 触发的跳转在 `HashRouter + <Routes>`（非 data router）下无法用 `useBlocker` 统一拦截，本轮以「卸载 flush + 显式脏状态提示」兜底，不改造路由架构。

### 4.7 本轮明确不做什么

- ❌ 不新建 / 不重做 ROADMAP 中的待补能力（多格式导出、JD 派生、撤销重做、模板系统、暗色模式、缩略图等**均已存在**，不做二次加工）。
- ❌ 不改编辑器其它能力：表单字段、A4 预览渲染管线（`legacy/` vm 沙箱）、PDF、体检、主题、素材插入、版本历史 UI。
- ❌ 不改后端：不给 `PUT /api/resumes/:id` 加乐观锁 / 版本号 / ETag / 新端点，不动 `resumes.service.ts` 的自动留痕策略。
- ❌ **不碰云同步铁律与数据库迁移**：HLC、软删除墓碑、`change_log`、回灌窗口 `withSyncImport()`、`sync_state`、`conflict_snapshots`、`TenantDb` 隔离语义、E2EE 恢复码，以及 `drizzle/*.sql` 一律不动。
- ❌ 不改造路由架构（不引入 data router / `useBlocker` 全站拦截）、不引入新依赖、不把简历明文写入 localStorage。
- ❌ 不合并 B（面试练习草稿）到本轮；建议下一轮以同一状态机复用治理，避免双功能并行扩大回归面。
- ❌ 不以文档修订（候选 G）作为本轮交付主体；如需修订，仅作为 P1 顺带项。

---

## 附录 A · 可追溯依据索引（供架构师复核）

| 主题 | 文件与行号 | 结论 |
|---|---|---|
| 实际路由表 | `src/web/App.tsx` L80–101 | 22 条业务路由，含 README 未列的 applications / portfolio / snippets / interview / compare / growth |
| 侧栏信息架构 | `src/web/Layout.tsx` L7–31、L108 | 14 个菜单项，分组「工作区 / 智能工具」，深链页无独立入口 |
| 文档滞后 | `README.md` L69–95、L463–468；`ROADMAP.md` L24–35、L95 | 「待补」清单中的导出/体检/撤销/缩略图/主题切换均已落地 |
| 编辑器保存链路 | `src/web/pages/Editor.tsx` L701–711（状态定义）、L747–795（useQuery / useMutation / 800ms effect）、L927–983（导出共用 error）、L1024–1040（状态条）、L1111（alert）、L1182–1183（撤销重做） | 失败不可重试、错误共槽、并发无序号、无离开保护 |
| 保存接口契约 | `src/web/api.ts` L659–700（`api` / `put`，无超时与 abort）、`src/server/resumes/resumes.controller.ts` L55–58、`src/server/resumes/resumes.service.ts` L32–52、L54–72 | 整份 payload 覆盖、无乐观锁；自动版本 2 分钟节流，重试不会刷屏 |
| 同产品成熟范式 | `src/web/pages/InterviewSession.tsx` L38、L81–111、L289 | 800ms 防抖 + blur + beforeunload + keepalive flush 已存在于答题草稿 |
| 全站 beforeunload 现状 | Grep `beforeunload` 仅命中 `InterviewSession.tsx` L110–111 | 编辑器缺失离开保护 |
| UI 样式基座 | `src/web/styles.css` L886–895 | `.save-state` 已有 `saving/editing/error` 变体，增量改动小 |
| 主题系统（已完整） | `src/web/theme.ts` L21–79、`src/web/pages/Account.tsx` L138–155、`src/web/App.tsx` L39–46 | ROADMAP「缺切换入口」已过时 |
| 公司详情并发写 | `src/web/pages/CompanyDetailPage.tsx` L126–155、L382/424/710/873/905 | 多个 mutation 基于 `company?.payload` 浅合并，候选 C 依据 |
| 简历库列表 | `src/web/pages/Library.tsx` L21–42、L111–124、L239–251、L266–289 | 无搜索；分页越界无回退，候选 D 依据 |
| 附件批量上传 | `src/web/pages/Attachments.tsx` L141–169；`src/web/api.ts` L709–723 | 串行、无逐项进度、失败无法定向重试，候选 E 依据 |
| 总览静默错误 | `src/web/pages/Home.tsx` L25–36 | 三个 useQuery 无 error 渲染，候选 F 依据 |
| 账号设置双入口 | `src/web/pages/Account.tsx` L35–38、L74–82、L138–155 | JSON 与主题卡互相覆盖，候选 H 依据 |
| 服务端模块与底座 | `src/server/app.module.ts` L20–39；`src/server/tenant/tenant-db.ts`（1363 行）；`src/server/sync/*`；`drizzle/` | 本轮禁区边界 |
| 测试基建 | `vitest.config.mts` L3–11；`test/` 34 个文件；`package.json` L13–19 | node 环境纯函数单测可行；`npm test` / `npm run build` 为验收命令 |

---

> 交付给架构师的输入：**推荐 A**，请在代码审查中重点复核 `Editor.tsx` L747–795 的 effect 依赖与 `saveM.mutate` 并发行为、
> `beforeunload`/keepalive 在本项目 HashRouter 下的可行性，并把 P0 需求 R1–R7 拆成最小变更任务。
> 若架构师审查后认为 A 有更高优先级替代项，请回传主理人裁决，本报告的候选池可直接作为备选清单。
