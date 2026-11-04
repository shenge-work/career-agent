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

## 🏗️ 架构

```
浏览器 ── 127.0.0.1:5173 ──> Vite（React SPA）
                │  /api 代理
                v
        127.0.0.1:3000  NestJS + Fastify
                ├─ PGlite（进程内 PostgreSQL，数据 ./pgdata）
                ├─ legacy/ 渲染引擎资产（vm 沙箱加载，v1 遗产继续服役）
                └─ 按需 spawn：headless Chrome（PDF）/ boss-collect（采集）
```

- `src/server/` NestJS：auth（认证）/ tenant（行级隔离唯一入口）/ resumes / business /
  render（渲染孤岛与双 PDF）/ ai / collect / users / security（回环守卫）
- `src/web/` React：登录 / 简历库 / 编辑器 / 公司档案 / 投递 / AI / 账号与设置
- `legacy/` v1 渲染引擎资产（8 个 JS + style.css + html2canvas/jspdf + boss-collect），
  只读引用、只改 bug 不重构
- `drizzle/` 手写迁移 SQL（`_migrations` 记录已应用）
- `test/` Vitest 端到端（内存 PGlite，`app.inject()`）

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
