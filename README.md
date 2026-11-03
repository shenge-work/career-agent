# 简历编辑器（Resume Builder）

一个**数据可自持、可跨端使用**的简历排版工具：左侧实时预览，右侧纯文本编辑，拖拽调序，支持板块增删、撤销/重做，可做投递前体检，并导出「可选中文字」的 PDF / Word。

三种使用形态（同一份代码库）：

| 形态 | 打开方式 | 适合场景 |
|---|---|---|
| **浏览器版** | `npm start` → `http://127.0.0.1:8000` | 日常编辑；每次改动**分文件实时写回** `data/resumes/`（清单 + 每份简历一个文件） |
| **单文件版** | `npm run build` → `dist/简历编辑器-单文件.html`，双击即开 | 离线使用、分享给他人 |
| **桌面 / 安卓 App** | 见 [docs/构建与发版/桌面版构建说明.md](./docs/构建与发版/桌面版构建说明.md)、[docs/构建与发版/Android版构建说明.md](./docs/构建与发版/Android版构建说明.md) | 免装 Node；飞书凭证由原生层保管，不经浏览器 |

> 本项目最初是一份单文件 HTML，后拆分为多文件便于 Git 协作；单文件版由 `npm run build` 自动生成到 `dist/`（`git` 忽略，断网可用）。

[![CI](https://github.com/shenge-work/resume-builder/actions/workflows/ci.yml/badge.svg)](https://github.com/shenge-work/resume-builder/actions/workflows/ci.yml)
[![Build Desktop](https://github.com/shenge-work/resume-builder/actions/workflows/build-desktop.yml/badge.svg)](https://github.com/shenge-work/resume-builder/actions/workflows/build-desktop.yml)
[![Build Android](https://github.com/shenge-work/resume-builder/actions/workflows/build-android.yml/badge.svg)](https://github.com/shenge-work/resume-builder/actions/workflows/build-android.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## ✨ 功能

**编辑**

| 功能 | 说明 |
|---|---|
| 实时预览 | 右侧改字，左侧立即刷新 |
| 拖拽排序 | 直接拖动板块 / 公司 / 项目 / 条目调整顺序 |
| 板块增删 | 一键新增「个人优势 / 职业履历 / 核心技能 / 项目经历」，可删除（至少保留 1 个） |
| 撤销 / 重做 | 文字、字号/间距、增删/移动、拖拽、重置、导入均可撤销（100 步）；`Ctrl/Cmd+Z`、`Ctrl+Y` |
| 字号 / 间距 | 按元素类别（姓名、章节标题、正文…）配置字号；全局默认间距 + **每行**独立微调（仅叠加，不影响其他行） |
| 公司 Logo / 引用线 | 每家公司可配 Logo 与尺寸；公司概述、项目描述可单独开关左侧引用线 |
| 强制换页 / 分页参考线 | 指定公司从新一页开始；按 A4 比例显示分页位置，与导出结果一致 |

**导出与投递**

| 功能 | 说明 |
|---|---|
| 投递体检 | 规则化检查**页数 / 内容完整性 / 量化结果 / ATS 友好度 / 敏感信息**，分「必须处理 · 建议修改 · 可以更好」三级，点击条目可定位到对应板块 |
| PDF（静默） | 经本地服务调用本机浏览器 headless 打印，产出**文字可选中**的矢量 PDF，**不弹**打印对话框（需 `npm start`；失败自动回退到系统打印） |
| Word / 纯文本 / Markdown | `.docx`（真 OOXML，含真加粗，HR 与 ATS 通用）、`.txt`（投递表单粘贴用）、`.md`（放 GitHub / 在线简历） |
| 图片版 PDF / 长图 / 单文件 HTML | html2canvas 截图拼合，版式与屏幕 100% 一致（代价：文字不可选、体积较大） |

**数据**

| 功能 | 说明 |
|---|---|
| 数据导入 / 导出 | 全量内容导出为 JSON 备份，换设备 / 浏览器后导入恢复 |
| 上传 PDF / JSON 简历 | 左抽屉「上传」按钮：JSON 直接入库为一份新简历；PDF 经本地服务用 pdf.js 提取文本，识别姓名/联系方式，并尽力结构化工作经历/教育/技能（低置信度标注待确认），正文仍全保留进「导入原文」板块供校对整理（需 `npm start`） |
| 自动保存 | 统一「分文件」模型：一份简历 = 一个文档（`resumes/<id>.json`），编辑经 `stableHash` 内容指纹比对后写盘（内容未变不写）；桌面端落系统用户数据目录，浏览器开发模式落 `data/resumes/` |
| 飞书同步（可选） | 手动「上报到飞书」/「从飞书恢复」，借飞书文档与云盘文件的版本历史留存每次更改；应用凭证只存本机，**绝不进浏览器** |
| 飞书绑定（可选） | 两种方式：**① 扫码授权**——手机飞书扫码后以**用户身份**（user_access_token）读写自己的云盘/文档；**② 扫码注册个人应用**——手机飞书扫码由飞书自动创建「个人应用」并保存 App ID / App Secret（无需在开放平台手动抄写），自动探测绑定云盘文件夹。两种凭证都只存本机、绝不进浏览器 |
| 数据门面 | 统一存储抽象（`js/store/`）：本地 / 飞书 / 未来数据源实现同一套「分文件」接口（list / read / write / versions / restore），业务代码不感知具体后端 |

**界面**

| 功能 | 说明 |
|---|---|
| 响应式 | 手机 / 平板 / 桌面自适应：移动端底部 Tab、A4 等比缩放、安全区与软键盘适配、返回键优先级 |
| 日间 / 夜间主题 | 严格黑白灰三色体系，一键切换 |
| 面板折叠 | 字号 / 间距 / 投递体检 / 内容编辑可展开收起 |
| 保存状态 | 预览区顶部常驻一行状态（编辑中 / 保存中 / ✓ 已保存 HH:MM / 失败·可重试）；**磁盘写入失败退回浏览器存储时会明确告警**，不会假装已保存 |
| 数据体检 | 设置页「数据」分组显示**简历存在哪 / 有几份 / 最后一次写盘时间**（经本地服务上报磁盘事实）；降级态明确标注，拿不到时标注「未知」而不编造路径 |

---

## 🚀 快速开始

**方式一：用构建好的单文件版（推荐快速使用）**

运行 `npm run build` 后，`dist/` 下会生成 `简历编辑器-单文件.html`，**无需服务器、双击即开、断网可用**，适合直接下载使用或分享。

**方式二：本地写服务预览（多文件版，推荐——支持「编辑实时写回」）**

```bash
cd resume-builder
npm start                 # = node tools/serve.js，默认端口 8000（可用 PORT 覆盖）
# 浏览器访问 http://localhost:8000
```

> 若你的终端报 `npm: command not found`（WorkBuddy 管理的 Node 运行时未挂到交互式 shell 的 PATH），npm 其实已安装，只是没暴露。两种等价替代：
> - 直接用完整路径的 node 跑（**推荐，无需 npm install**，serve.js 只用内置模块）：
>   `~/.workbuddy/binaries/node/versions/22.22.2/bin/node tools/serve.js`
> - 或先临时把 Node 加入当前会话 PATH，再用 `npm start`：
>   `export PATH="$HOME/.workbuddy/binaries/node/versions/22.22.2/bin:$PATH"`

> 用本项目自带的服务（`npm start`）而不是 `python3 -m http.server`，原因是：浏览器**无法向磁盘写文件**，只有经这个服务打开，编辑器里的每次修改才会**分文件写回 `data/resumes/`**（刷新不丢、可直接 git 管理）。
> 若改用 `python3 -m http.server` 或直接双击 `index.html`（`file://`），浏览器读不到/写不回 `data/resumes/`，编辑仅存内存（工具栏会提示「未连接本地写服务」）。

**方式三：自行构建单文件版**

```bash
npm run build
# 产物：dist/简历编辑器-单文件.html  （离线可用、双击即开；git 忽略）
```

**方式四：桌面 / 安卓 App（可选）**

```bash
npm run desktop:assets   # 前端产物复制并净化到 dist-desktop/（自动剥离注入属性、隔离隐私目录）
npm run desktop:build    # 产出本机平台安装包：macOS .app/.dmg、Windows .msi/.exe、Linux .deb/.AppImage
npm run mobile:android:build   # 产出 APK / AAB（需 JDK 17 + Android SDK/NDK）
```

依赖：Rust 工具链 + Node；安卓另需 JDK 17 与 Android SDK/NDK。

> **不想装 Rust / SDK？直接用 CI 出包。** push 到 GitHub 后，`Build Desktop` 与 `Build Android`
> 会在三平台矩阵上产出安装包，到 Actions 页对应 run 的 **Artifacts** 下载即可。
> 细节与排错见 [docs/构建与发版/桌面版构建说明.md](./docs/构建与发版/桌面版构建说明.md)、[docs/构建与发版/Android版构建说明.md](./docs/构建与发版/Android版构建说明.md)。

---

## 📦 下载安装包（各平台）

**普通使用者不必自己构建** —— 到 [**Releases**](../../releases) 页下载对应平台的安装包即可：

| 平台 | 下载什么 |
|---|---|
| Windows | `Resume-Studio-<版本>-windows-x64-setup.exe`（个人安装）或 `…-windows-x64.msi`（批量部署） |
| macOS | `Resume-Studio-<版本>-macos-arm64.dmg`（Apple 芯片；**Intel Mac 暂未提供**） |
| Linux | `Resume-Studio-<版本>-linux-x86_64.AppImage`（免安装）或 `…-linux-amd64.deb` |
| Android | `Resume-Studio-<版本>-android.apk`（直接安装到手机） |
| 任意浏览器 | `Resume-Studio-<版本>-standalone.html`（离线单文件，双击即用，无需安装） |

每个 Release 都附带**该版本的更新说明**与 `SHA256SUMS.txt`（下载完整性用
`sha256sum -c SHA256SUMS.txt` 校验）。

> ⚠️ **首次打开可能被系统拦下**：当前尚未接入代码签名与公证，macOS 需**右键 → 打开**，
> Windows 可能弹 SmartScreen「未知发布者」，Android 需允许「安装未知来源的应用」。
> 详见对应 Release 的说明。

发版流程（维护者）：见 [docs/构建与发版/发版说明.md](./docs/构建与发版/发版说明.md) —— 改版本号 + 写 CHANGELOG +
推 `v*` 标签，流水线自动构建三平台 + 安卓包并创建 Release。

---

## 📁 目录结构

```
resume-builder/
├── index.html                # 页面骨架（多文件版入口；内联事件统一走 ResumeXxx 命名空间）
├── css/
│   └── style.css            # 全部样式（响应式断点 + @media print 打印样式）
├── js/
│   ├── data.js              # 默认/种子数据（构建时内联进单文件版）
│   ├── app.js              # 业务逻辑，封装为 IIFE，仅暴露 window.ResumeEditor
│   ├── theme.js             # 日间 / 夜间主题（黑白灰）
│   ├── audit.js             # 投递体检（纯规则、只读，暴露 window.ResumeAudit）
│   ├── jd-match.js          # JD 匹配分析（纯规则、只读，暴露 window.ResumeJd）
│   ├── jd-derive.js         # JD 派生版本：缺失/弱覆盖关键词 → 定制版（暴露 window.ResumeJdDerive）
│   └── ui/
│       ├── menu-actions.js  # 统一入口清单：桌面工具菜单 + 手机 sync-pane 同源渲染（window.ResumeMenu）
│       ├── save-status.js   # 保存状态条（保存三态 + 存储降级告警）
│       ├── notifier.js      # 消息通知中心
│       └── pane-mobile.js   # 面板 / 移动端 UI
│   ├── export-extra.js      # Word / 纯文本 / Markdown / 静默 PDF（暴露 window.ResumeExport）
│   ├── io/
│   │   └── jsonresume-adapter.js # JSON Resume 标准双向适配（暴露 window.ResumeJSONResume；双环境模块）
│   └── store/
│       ├── resume-store.js  # 数据门面：Local / Browser / Feishu 三种实现
│       ├── snippet-library.js # 经历素材库：STAR 片段复用（暴露 window.ResumeSnippets）
│       └── native-bridge.js # 原生桥：仅在 Tauri 壳内注入 window.__RESUME_NATIVE__
├── src-tauri/               # 桌面 / 移动原生壳（Rust）：7 个命令 + 凭证保管（app_secret 只在原生进程）
├── vendor/                  # 第三方库（本地存放，离线可用）
│   ├── html2canvas.min.js   #   把简历渲染成图片（图片型 PDF 兼容导出用）
│   └── jspdf.umd.min.js     #   把图片拼成 PDF
├── tools/
│   ├── serve.js            # 本地写服务（零依赖）：静态托管 + /api/resume 写回 + /api/pdf 静默打印
│   ├── build-single.js      # 打包脚本：多文件 → 单文件 HTML（输出到 dist/）
│   ├── build-desktop-frontend.js # 前端 → dist-desktop/（白名单复制 + 净化注入属性）
│   ├── verify-frontend-assets.js # 资源完整性门禁：引用缺失 / 漏打包 / 隐私目录泄漏
│   ├── gen-icons.js         # 生成安装包图标（RGBA PNG / icns / ico）
│   ├── clean-html-injections.js # 剥离外部编辑器注入的 data-page-node-id
│   ├── migrate-legacy.js    # 旧版单文件简历 HTML → 可导入 JSON（输出到 dist/）
│   ├── save-data.js        # 把浏览器导出的 JSON 落盘为 data/resume.json（备用回写方式）
│   ├── render-resume.js     # JSON → 独立 A4 简历 HTML（用项目真实渲染管线，输出到 dist/）
│   └── export-company-research.js # 公司情报 → 可入库 Markdown 快照（脱敏 / --check / --private）
├── test/                    # 纯 Node、零依赖测试
│   ├── run.js               #   运行器（DOM/浏览器桩，vm 加载 data + store + app + audit + export-extra）
│   ├── cases.js             #   核心逻辑用例
│   ├── cases-audit.js       #   投递体检用例（CommonJS，经 ctx.assert 上报）
│   ├── cases-serve-http.js  #   ★ 本地写服务的 HTTP 冒烟（真起子进程打真实请求，唯一会执行 serve.js 的一组）
│   ├── cases-save-status.js #   保存状态条 + 存储降级通知（含隔离沙箱里的真实降级行为验证）
│   ├── cases-jd.js          #   JD 匹配分析（术语抽取 / 词边界 / 分桶 / 只读性 / 隐私边界 / 接线）
│   ├── cases-undo.js        #   撤销栈按简历隔离 + 输入框放行原生撤销（跨份污染 / 单份回归 / isEditableTarget 契约）
│   ├── cases-pdfparse.js    #   PDF 结构化解析（姓名/联系方式/经历/教育/技能字段抽取，纯函数）
│   ├── cases-jsonresume.js  #   JSON Resume 双向适配（fromJsonResume / toJsonResume，纯函数）
│   ├── cases-jd-derive.js   #   JD 派生版本（buildDerivedPayload / fillGroupFor 等纯函数）
│   ├── cases-snippets.js    #   经历素材库（normalizeTags / matchSnippets 等纯函数）
│   └── cases-export.js      #   多格式导出用例（自带独立 zip 解析器，逐字节校验 OOXML）
├── docs/
│   ├── 需求文档/               # 需求清单（D/N 编号，00-需求总览 为入口）
│   ├── 技术设计方案/           # 路由/存储/跨平台/导出等模块的技术设计与架构方案
│   ├── AI能力/                 # AI 辅助写简历设计方案 + AI 助手配置与使用
│   ├── 构建与发版/             # 桌面/安卓构建说明 + 发版流程
│   ├── 产品与竞品分析/         # 产品评估、竞品对照、开源项目借鉴落地方案
│   ├── 验收与记录/             # 跨平台改造验收标准与验收记录
│   └── Bug库/                  # Bug 记录（模板 + 分类）
├── .github/workflows/
│   ├── ci.yml               # push/PR：测试 + 构建 + 资源完整性门禁
│   ├── build-desktop.yml    # 三平台矩阵出包（dmg / msi+nsis / deb+AppImage），亦可被 release 复用
│   ├── build-android.yml    # APK + AAB，亦可被 release 复用
│   └── release.yml          # 推 v* 标签或手动触发：出三平台+安卓包并创建 GitHub Release
├── template.json            # ★ 公开示范数据（占位演示，随仓库分发）
├── data/                   # ★ 个人简历数据（已被 .gitignore 隔离，不进公开仓库）
│   ├── resume.json         #   旧版单份数据源（web 模式首次启动自动迁移进简历库）
│   └── resumes/            #   统一分文件模型（web 模式）：index.json 清单 + <id>.json 每份简历
├── dist/                    # 构建产物（.gitignore 忽略；含单文件版、安装包与迁移产物）
├── README.md / CHANGELOG.md / ROADMAP.md / CONTRIBUTING.md / LICENSE
└── package.json
```

**加载顺序**：`data.js` → `store/resume-store.js` → `store/native-bridge.js` → `app.js` → `export-extra.js` → `audit.js` → `jd-match.js`。
`app.js` 依赖前三个；`export-extra.js` / `audit.js` / `jd-match.js` 依赖 `app.js` 暴露的 `ResumeEditor.getData()`，必须排在最后。
（`npm run verify:assets` 会校验这个顺序与引用完整性。）

---

## 💾 数据存储位置

项目已统一为「**分文件**」存储模型：**一份简历 = 一个文档（docId = resumeId）**，本地保存与飞书同步保存同构，业务代码只面向「文档」读写，不关心具体后端。

### 1. 本地简历数据（自动保存）

| 使用形态 | 位置 |
|---|---|
| 桌面安装包（macOS） | `~/Library/Application Support/com.resumestudio.desktop/resumes/` |
| 桌面安装包（Windows） | `%APPDATA%\com.resumestudio.desktop\resumes\` |
| 桌面安装包（Linux） | `~/.local/share/com.resumestudio.desktop/resumes/` |
| 浏览器开发（npm start） | `data/resumes/`（被 `.gitignore` 隔离） |

> **为什么不在安装包目录**：安装目录通常只读，且升级 / 卸载会被清空；系统用户数据目录（Tauri `app_data_dir`）才是跨平台约定，卸载 App 后数据也默认保留。

目录结构（与飞书云端按 `file_token_<id>` 分键同构）：

```
resumes/
├── index.json   # 简历清单 + 激活态 + 内容指纹（lastHash / 同步进度）
└── <id>.json    # 每份简历一个文件：{data, fonts, spacing, v, savedAt}
```

- **文件名 = 简历 id**（稳定锚点）：重命名 / 打标签只改 `index.json` 里的 `title` / `tags`，正文文件不动；避开标题特殊字符、重名冲突、路径长度问题。
- 自动保存规则：编辑 → `stableHash` 内容指纹比对（与飞书自动同步同一套规则）→ 800ms 防抖 → **内容未变则跳过写盘**；指纹持久化在 `index.json`，重启后仍生效。
- 已移除浏览器持久化（IndexedDB / localStorage 不再存简历数据），localStorage 仅保留 UI 偏好（面板折叠、主题等）。

### 2. 系统配置与同步状态（与简历数据分文件）

| 文件 | 内容 |
|---|---|
| `sync.config.json` | 飞书应用凭证 / 文件夹配置（gitignored，**绝不上库、不进浏览器**） |
| `sync.state.json` | 飞书同步状态：`file_token_<id>` / `document_id_<id>`（按简历 id + 认证身份分键） |

- 桌面安装包：存 Tauri `app_config_dir()`；浏览器开发模式：由 serve.js 读写项目根目录同名文件（静态服务一律 403 拒绝下发）。
- 简历数据与系统配置**分文件、分目录**存储，本地与飞书侧一致。

### 3. 初始化数据源（web 模式，按优先级）

1. **简历库 `data/resumes/`** —— 已入库的多份简历（优先）；
2. 旧单份 **`data/resume.json`** —— 首次启动自动迁移为第一份简历；
3. 否则 **`template.json`** —— 公开示范数据；4. 都没有 → 回退 `js/data.js` 极简空骨架。

### 4. 可移植数据 —— 导出的 JSON 文件

- 「导出数据」按钮下载的 JSON，格式即 `{data, fonts, spacing, v}`，与简历文件一致。
- 这是**唯一能跨设备 / 跨来源迁移**的载体：换环境后点「导入数据」即成为新简历。
- 备用回写：`node tools/save-data.js <导出JSON>` 可落盘到 `data/resume.json`（旧单份路径，自动进入迁移链路）。

## 📥 从旧版单文件简历迁移数据

如果你有一份**旧版**简历编辑器生成的单文件 HTML（简历内容内嵌在 `let data = {...}` 中），可用两个零依赖脚本把内容无损迁移进来：

```bash
node tools/migrate-legacy.js <旧版HTML路径>          # 提取内嵌数据 → dist/示例_简历数据_迁移版.json
node tools/render-resume.js                          # 用项目真实渲染管线 → dist/示例_简历_迁移版.html
```

- 生成的 JSON 与编辑器「导入数据」按钮完全兼容，可在 `index.html` 中一键导入继续编辑（含字体 / 间距配置）。
- 生成的 HTML 是独立 A4 简历（文字可选中），浏览器打开后 `Ctrl/Cmd+P` 即可「另存为 PDF」。
- 产物默认落在 `dist/`（git 忽略）；`migrate-legacy.js` 第 2 个参数、`render-resume.js` 第 2~3 个参数可自定义路径。

---

## 🖨️ 关于导出

| 方式 | 入口 | 特点 |
|---|---|---|
| **PDF（静默）** | 「PDF（文字可选中 · 静默）」 | 经本地服务调本机 Chrome/Edge 的 headless 打印，**不弹对话框**直出矢量文字 PDF；需用 `npm start` 打开，失败自动回退到系统打印 |
| Word（`.docx`） | 「导出 Word（.docx）」 | 真 Office Open XML（`[Content_Types].xml` 等必需部件齐全），粗体是**真加粗**非伪样式，HR 与 ATS 通用 |
| 纯文本 / Markdown | 「导出纯文本 / 导出 Markdown」 | `.txt` 用于投递表单粘贴；`.md` 用于 GitHub / 博客 / 在线简历 |
| 单文件 HTML | 「导出单文件 HTML」 | 仅含简历本身的独立 HTML，双击即开，文字可选中，可打印成 PDF |
| **分享页** | 「导出分享页」 | 只读静态页 + 斜置「仅查看」半透明水印，`noindex` 防搜索引擎收录，可发给他人或放 GitHub Pages / Vercel |
| **原生打印** | 「打印 / 另存为 PDF」 | 浏览器打印管线，矢量文字 PDF：文字可选中、可搜索；会弹出系统打印对话框 |
| 图片型（兼容） | 「PDF 预览 / 下载（图片版）」 | html2canvas 截图拼合，**版式 100% 与屏幕一致**，但文字不可选、体积较大 |

> **「静默 PDF」为什么需要本地服务**：浏览器既无法直写磁盘，也无法在不弹打印对话框的前提下调用打印管线。
> 因此由 `tools/serve.js` 的 `POST /api/pdf` 复刻页面打印样式、用本机浏览器 headless 渲染，再把 PDF 流回前端下载。
> 这是本项目唯一依赖本地服务的导出方式，其余导出均在纯前端完成。

---

## 🧪 测试与构建

```bash
npm test               # 纯 Node、零依赖：921 条断言
npm run build          # 重建单文件版 → dist/简历编辑器-单文件.html
npm run verify:assets  # 资源完整性门禁：引用缺失 / 漏打包 / 模块未接线 / 隐私目录泄漏
npm run clean:html     # 剥离 index.html 中被外部编辑器注入的 data-page-node-id（提交前跑）
```

`npm test` 覆盖五类：核心逻辑与入口接线、打印样式、IIFE 封装边界，以及四个只读分析 / 导出模块 + 两类交互契约
——**投递体检**（`test/cases-audit.js`：三份假数据 × 全部检查项 + 接口契约 + 只读性）、
**JD 匹配分析**（`test/cases-jd.js`：术语抽取 / 英文词边界 / 短语合并 / 三档分桶 / 只读性与
「JD 不进简历数据」的隐私边界 / 渲染 / 五处接线）、
**入口收敛**（`test/cases-menu.js`：桌面工具菜单与手机 sync-pane 同源渲染、无跨端重复定义、
桌面补飞书/页面导航、手机补打印/撤销等、以及对 `test/run.js` 旧 HTML 文本断言改为渲染结果断言）、
**撤销栈按简历隔离**（`test/cases-undo.js`：跨份污染 / 单份回归 / `isEditableTarget` 字段契约）与
**多格式导出**（`test/cases-export.js`：自带一个独立于被测实现的 zip 解析器，逐字节校验本地头 / 中央目录 /
CRC / 标志位，并把 `document.xml` 引用的每个段落样式回溯到 `styles.xml` 的定义）。

> **`test/cases-serve-http.js` 是唯一会真正执行 `tools/serve.js` 的一组用例**：起一个随机端口的子进程，
> 打真实 HTTP 请求（索引读写 / 文档写入读回删除 / 非法 id / 凭证 403 / 错误分类），
> 并逐条断言**请求之后服务仍然存活**。之所以必须有这一层 —— 其余关于 serve.js 的断言都只是
> 把源码读成**字符串做正则匹配**、从不运行它，于是「一次普通 GET 请求就杀掉整个服务进程」的缺陷
> 曾逃过当时的全部 371 条断言。该文件在测试前备份、结束后还原 `data/resumes/`，不会污染真实数据。

> 导出模块的断言用**变异测试**反向验证过有效性：往 `js/export-extra.js` 注入 15 处真实缺陷
> （少转义 `&`、引用不存在的样式、纸张改 Letter、丢部件、压缩标记写成 deflate 等），
> 14 处被断言抓住，唯一漏网的是语义中性的等价变异。这轮验证当场揪出两个测试盲区，均已修复。

CI（`.github/workflows/ci.yml`）在每次 push / PR 自动运行前两项与资源门禁。

> **为什么需要 `verify:assets`**：本项目**没有打包器**，新增一个 js 模块要同时做**四件事** ——
> ① 在 `index.html` 里加 `<script>`；② 在 `tools/build-single.js` 的白名单里登记；
> ③ 在 `test/run.js` 里按同顺序加载进 vm 沙箱（否则测试根本测不到它）；
> ④ 重跑 `npm run build` + `npm run desktop:assets` 重建两份产物。
> 漏掉前三件都不会报错，只会**静默缺功能**（模块跑不起来 / 单文件版里没有它 / 断言全绿却没测到）；
> 漏掉第四件则 CI 的资源门禁会红。该脚本把这类问题变成 CI 失败。

---

## 🗺️ 版本与规划

- **下载各平台安装包**：[Releases](../../releases)（每个版本都带更新说明与校验和）。
- 各版本变更记录：见 [CHANGELOG.md](./CHANGELOG.md)。
- 发版流程（维护者）：见 [docs/构建与发版/发版说明.md](./docs/构建与发版/发版说明.md)。
- 后续优化方向：见 [ROADMAP.md](./ROADMAP.md)。
- 跨平台改造的**逐任务验收标准与验收记录**：见 [docs/验收与记录/跨平台改造-验收标准与验收记录.md](./docs/验收与记录/跨平台改造-验收标准与验收记录.md)。
- **v2 本地服务器化重构（账号 / 数据库 / 渲染孤岛 / PDF / AI / 采集）的完整归档**：见 [docs/v2重构归档/README.md](./docs/v2重构归档/README.md)。该目录记录选型决策、架构与接口、逐阶段验收、运维与后续路线；新代码在 `v2/`，本 README 描述的是仍独立运行的 v1 形态。

> ⏸ **关于「AI 辅助写简历」**：仓库内 [docs/AI能力/AI辅助写简历-技术设计方案.md](./docs/AI能力/AI辅助写简历-技术设计方案.md) 存有一份完整的技术设计方案
> （选型调研、功能设计、UI 设计、目录结构），但**那只是未来演进方向，当前尚未实施** ——
> 本工具目前不含 AI 能力，请以本文描述的功能为准。

---

## 🤝 贡献

欢迎 Issue 与 PR，详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 📄 许可

[MIT](./LICENSE)。

---

## ⚠️ 隐私提醒

- `template.json`（仓库根目录）是**公开示范数据**，随仓库分发、用于无简历数据时的演示；`js/data.js` 只保留极简空骨架。
- **真实简历内容**存放在 `data/resumes/`（web 模式）或系统用户数据目录（桌面安装包），已被 `.gitignore` **整体忽略**，不会进入公开仓库。
- 飞书应用凭证存放在 `sync.config.json`（gitignored），由本地服务 / 原生层读取，**绝不下发到浏览器**；桌面与安卓版中它只存在于 Rust 进程内存与系统文件。
- 安装包构建时只把 `index.html` / `css` / `js` / `vendor` / `template.json` 复制进 `dist-desktop/`，**不含 `data/`**；可用 `strings <二进制> | grep <姓名>` 复核。
- **公司调研资料**：事实源 `data/companies/companies.json` 与 `data/tracker/seed.json` 随 `data/` 整体不入库；可入库的脱敏快照与调研结论沉淀在 [`docs/公司调研/`](./docs/公司调研/README.md)，由 `npm run research:export` 生成、`npm run research:check` 校验新鲜度。`--private` 完整版含未脱敏姓名，仅落在 `data/`，勿对外分享。
- 提交前建议自查：`npm run clean:html` 后再 `git add`，并用 `git grep` 扫描真实姓名 / 公司名等 PII。
