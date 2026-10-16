# Changelog

本项目所有重要变更记录于此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **发版规则（与 CI 联动，改动前请先读 `docs/构建与发版/发版说明.md`）**
>
> 1. 版本号以 `src-tauri/tauri.conf.json` 的 `version` 为**唯一权威**，`package.json` 必须与之一致
>    （发版流水线会校验，不一致直接失败）。
> 2. 发版时把下面 `## [Unreleased]` 整段改成 `## [x.y.z] - YYYY-MM-DD`，
>    并新开一个空的 `## [Unreleased]`。
> 3. GitHub Release 的**更新说明由流水线从本文件对应版本章节自动抽取**；
>    若找不到对应章节会退回 `[Unreleased]`，两者都没有则**发版失败** —— 即「必须有版本更新描述」。

---

## [Unreleased]

### 新增

- **N11 本地版本历史与回溯（`js/store/local-history.js`、`js/app.js`、`js/store/resume-library.js`、`js/store/adapter-local.js`、`js/views/history-view.js`）**：
  把「撤销栈（会话级内存、关应用即丢）」升级为「本地持久化、可跨会话、可回溯」的版本链——
  像飞书文档那样，每次编辑自动留痕、随时看「什么时候改了什么」、一键回滚，且**不依赖任何云端**
  （file:// 直开、未连飞书也完整可用）。
  - 自动留痕：`recordHistory(kind, label?)` 在 undo 快照入栈的同一刻，把同款 `{data,fonts,spacing}`
    快照追加到本地版本链（沿用 <700ms 输入合并防抖，不做逐字符记录）；导入 / 重置 / 从飞书恢复
    等关键动作在调用点显式传 label，历史列表能看出「这条版本是因什么动作产生的」。
  - 双来源历史面板（#/history）：先列**本地版本**（自动/手动徽标 + 时间 + 可选命名），再列**飞书云端版本**
    （云端徽标），互不覆盖；点选版本右侧**只读预览**真实渲染效果（复用 N5 `buildResumeHtml`
    受保护交换，不污染编辑态）；「恢复此版本」二次确认，恢复前**当前内容自动先存为新版本**
    （回滚本身可逆、不丢当前）；「保存为命名快照」给重要节点（投递 A 公司版 / 定稿 v2）打标记。
  - 存储引擎：版本链跟随主存储后端（native / http+ls / localstorage / memory），经
    `ResumeLibrary.loadDocRaw/saveDocRaw/removeDocRaw`（新增的不经索引底层通道）落
    `{id}_versions` 分文档，不碰 index.json；按简历 id 隔离，删除简历时一并清理。
  - 保留策略：最近 50 条全保留；更早按「每天首尾 2 条」降采样、最长 30 天（对齐 Google Docs）；
    单份版本历史超 5MB 从最旧降采样点丢弃（绝不动最近 50 条）。追加走内存缓存 + 400ms 防抖
    合并写盘，记历史失败静默降级、绝不打断编辑。
  - 数据源契约打通：`adapter-local` 实现 `listVersions` / `restoreVersion`，`capabilities.versions=true`，
    本地适配器首次具备版本能力（M4 预留位兑现）。
  - 测试：新增 17 条（保留策略纯函数 / 存储链路 / 端到端 recordHistory→版本链 / 隔离性 /
    合并窗口），单测 **1344 全绿**；变异测试验证降采样与合并逻辑断言真实有效（并补齐了
    「跨越 700ms 窗口不合并」的既有测试盲区）。

### 修复

- **图片版 PDF / 长图导出：跨页处把文字行拦腰截断（`js/render/resume-render.js`、`js/export/export-pdf.js`）**：
  截图分页按「内容区高度等分」切片，切点落在某一行文字中间时这一行被切成两半 ——
  上半行留在本页底部、下半行跑到下页顶部（即用户截图里的跨页残行）。另有一处叠加成因：
  捕获克隆把 `.reorder-btns`（↑↓）直接 `remove()` 掉，而它是 inline-flex 实体盒子、
  在 `.job` / `.project` 里各自还会撑出一整行空白（实测这份简历 8 个 ≈ 153px），
  于是克隆比实时预览矮一截，「按预览量出来的分页点」切到克隆上必然错位。
  - 修法一（分页点吸附）：新增 `collectInkBoxes()`（Range 逐行量文本行盒 + 图片等替换元素 +
    跨切点的框线）与纯函数 `snapBreaksToBoxes()`，把每个**自然**分页点上移到行间空白；
    预算 `pageSnapBudget()` 由下边距反推（10~36px），窗口内找不到空档就保留原切点
    （宁可切一行，也不把一页掏空成半页）。强制换页点与末页边界永不吸附。
    分页参考线与导出共用同一份结果，预览 / 分页线 / PDF 三者切口一致。
  - 修法二（克隆同构）：`makeCaptureClone()` 改为 `visibility:hidden` 而非 `remove()`，
    克隆与预览逐像素同构（实测 2880px == 2880px）；顺带堵住 `@media (hover:none)` / 窄屏
    两条 `opacity:1` 规则让 ↑↓ 被打进成品的隐患（触屏端）。HTML / 分享页导出仍按原样剥离按钮
    （那两处是独立页面，去掉交互件更干净）。
  - 导出侧再加一道兜底：某页吸附后万一越出纸张，整体等比缩小一点点，而不是让末行被物理页边裁掉。
  - 实测（无头 Chrome + CDP，抓真实 html2canvas 画布与真实 `drawImage` 切片参数）：
    原几何切点所在行有 786/819 与 411/432 个墨点（正切在字上），吸附后切口行及其上方 5 行
    全为 0 墨点；`liveBreaks` 与 `cloneBreaks` 一致（970/1944 vs 970/1943）；
    A/B 对照（把按钮改成 visible 时同区域 337 墨点）证明 ↑↓ 不会进成品。共 3 页，页数不变。
  - 新增 13 条断言（含变异测试：关掉吸附、忽略 hard 标记都必须变红）。

- **本地写服务「一次请求即崩」缺陷（`tools/serve.js`）**：`const u = new URL(req.url, ...)` 原本声明在
  `try` 块**内部**（块作用域），而 `/api/library/doc`、`/api/feishu/register/poll`、
  `/api/feishu/register/cancel` 三处在块**之外**读取它 → 一次普通 GET 请求即抛 `ReferenceError`，
  且异常发生在同步回调中 → **整个 Node 服务进程直接退出**。由于 `/api/library/doc` 处在前端启动
  必经路径上（`js/store/resume-library.js` 的 `loadDoc`），**打开「简历库」页面就能复现**。
  - 影响链比崩溃本身更严重：服务一死，前端 fetch 失败即**永久**降级到 localStorage（无恢复入口），
    而写盘异常又被 `try/catch` 吞掉（`app.js`），于是**用户以为已保存、磁盘上却什么都没有**，
    界面上完全看不出来 —— 属于静默数据丢失。
  - 修法：`u` 提到 `try` 之外声明；另加 `uncaughtException` / `unhandledRejection` 进程级兜底
    （记录完整堆栈 + 尽力给当前请求回 500，不杀进程）。兜底**不掩盖问题**：真出现未捕获异常时
    接口会返回 500 而非预期状态码，测试当场变红。
  - ⚠️ 该缺陷此前**逃过了全部 371 条断言** —— 所有关于 serve.js 的断言都只是把源码读成**字符串做正则匹配**，
    从不真正执行它。这类「只匹配文本、从不运行」的断言是本次暴露出的最大测试盲区，已补下方 HTTP 冒烟测试。
  - 实测：修复前 `curl '/api/library/doc?id=default'` → `http=000` + 进程 DEAD；修复后连续多次均 `200`，
    打开 `#/library` 页面服务不再退出，且服务日志无未捕获异常。

- **「保存失败」此前完全无法被感知（静默降级）**：`js/store/resume-library.js` 的
  `httpBackendWithFallback` 在写盘失败时会静默切到 localStorage、并**以「成功」返回**，
  上层连 `catch` 都进不去 —— 于是「改动其实没落盘」这件事在代码与界面上都不留任何痕迹。
  - 修法：新增降级通知回调（`onDegrade`），在降级发生的一刻把它暴露给 UI；
    同时补 `isDegraded()` / `retryDisk()`，让「已降级」可查询、可恢复。
  - 连带解决一个隐蔽的覆盖问题：降级之后每次保存都会「成功」（写进 localStorage），
    若不特殊判定，「已保存」提示会把降级告警盖掉、用户重新误以为已落盘 ——
    故 app.js 的成功路径会优先判断降级态，是则持续显示告警。

- **简历库卡片名称显示不全，且悬浮也看不到全名（`js/views/library-view.js` + `css/layout.css`）**：
  卡片是「92px 缩略图 + 正文」的横向布局，正文实际可用宽度只有 140px 上下，而 `.lib-card-title`
  却是 `white-space:nowrap` + 单行省略 —— 派生简历那种「陈培胜 · 定制「岗位名」」的名字
  只能露出 8~9 个字（带「定制版」徽标时更少）。原生 `title` 提示有约 1 秒延迟、样式不可控，
  实际hover几乎感知不到，等于没有兜底。
  - 修法：标题放宽到**两行**（`-webkit-line-clamp:2`，容量约翻倍）并给右侧 `padding-right`
    让出 ⋯ 菜单按钮的位置；派生身份徽标从标题内挪到缩略图左下角角标，
    正文宽度完整留给名称；`renderGrid` 后实测标题是否仍被截断，只有真截断的卡片才挂
    `is-clipped`，hover 时用自绘气泡（带指向箭头、跟随主题变量、`pointer-events:none`）
    显示完整名称 —— 名称放得下的卡片不会弹无用提示。
  - 顺带修正：卡片 hover 时抬升 `z-index`，避免气泡被下一行卡片压住（多列换行场景实测通过）。

- **JD 派生简历的自动命名会把「要求条目」当岗位名（`js/jd-derive.js` 的 `deriveTitle`）**：
  原实现只取 JD **第一行**前 16 字，遇到两种真实形态就产出不可读的名字 ——
  ① 整段粘成一行、首行是章节标签 + 编号条目：生成「定制「任职要求：1、3年以上AI产品经…」」；
  ② 首行是「岗位 + 薪资 + 城市 + 年限」长串：生成「定制「全栈开发工程师 20-35K·13薪（杭…」」。
  - 修法：改为**清洗 + 选取**两步 —— 先反复剥离章节标签（任职要求/岗位职责/招聘…）与编号（`1、`/`（1）`/`①`）、
    句首年限（`3年以上`）、句尾「经验/优先」，并按句末标点截到第一个小句；再优先取**整行就像岗位名**的行，
    否则在条目里按分隔符切段、挑「短、不以动词开头（负责/熟悉/精通…）、命中岗位词」的片段。
  - 过长时的切法也做了取舍：优先按「岗位 + 薪资 + （城市）」保留城市、丢掉年限与学历，其次才硬截断。
  - 效果：上面两种分别得到「AI产品经理」与「全栈开发工程师 20-35K·13薪（杭州）」；取不到线索时回退首行截断（老行为不变）。

- **导航精简：移除冗余的「编辑器」菜单、把「模板」入口收敛进编辑器（`js/router/layout.js` + `js/ui/menu-actions.js`）**：
  左侧 rail 的「编辑器」与「简历库点开具体简历即进入编辑器」功能重复，属多余入口；「模板」只应在编辑某份简历时使用，
  不应作为全局导航常驻（在简历库等外部环境无需选模板）。
  - 修法：rail 删除「编辑器」「模板」两项按钮，并移除 bindNav 里仅服务于 rail「编辑器」键的 `/editor` 深链特殊处理；
    在编辑器工具菜单的「视图」组新增「主题模板」入口（`ResumeRouter.navigate('/templates')`，桌面/手机两端同源渲染，
    不加 desc 以符合「说明行只出现在导出 / 权限与备份两组」的既有断言）。模板页作用于当前激活简历、自带「返回编辑器预览」，
    收敛后换模板路径：编辑简历 → 工具菜单 → 主题模板 → 选模板 → 返回编辑器预览。

### 新增

- **需求文档 N1/N4-F1/N5/N6/N3 落地（按 `docs/需求文档/00-需求总览.md` 的推荐顺序推进）**：
  一次性把「主题模板 / 暗色模式 / 缩略图 / 导出引导 / 分享与权限」五块做完并各自补上验收记录。
  - **N1 主题模板系统**（新增 `js/theme-templates.js`）：5 套内置主题，切换时物化进既有的
    `currentFonts`/`currentSpacing`/`data.pageMargins`，颜色维度内联到 `.resume` 的 `--paper-*`
    变量（默认 classic 不写内联 → 像素级一致，零回归）；`#/templates` 从空壳改为真正的主题画廊
    （5 卡片 + 7 色微调）；`headingVisible` 逐节标题显隐 + `custom` 自定义板块；
    JSON Resume 导出/导入带 `meta.theme` 往返（验收项 AC#6）。
  - **N4-F1 暗色模式**：代码此前已就位（`js/theme.js` + `index.html` 首屏防闪 + CSS 变量体系），
    本轮补上**缺失的自动化测试**（新增 `test/cases-theme.js`，隔离 vm + localStorage/matchMedia 桩）
    并实测渲染；F2 i18n / F3 PWA 按评审拆分延后。
  - **N5 缩略图仪表盘**：`ResumeRender.buildResumeHtml(payload)`（临时换全局再 `finally` 还原，
    **不改写渲染层**）驱动 `#/library` 卡片与左抽屉的真实迷你预览，缓存键 `id|updatedAt`
    → 编辑中每键重渲染零重建、仅在落盘后重建一次。
  - **N6 导出引导**：导出菜单每项补一行格式说明（文字是否可选中 / 依赖 / 适用场景）；
    静默 PDF 在 501（本机无 Chrome）时给出可行动提示（决策逻辑抽成纯函数
    `pdfSilentFailureMessage`，可变异测试）。
  - **N3 分享与权限控制**（新增 `js/store/library-share.js`）：`meta` 增 `isLocked`/`isPublic`/`shareToken`
    三个字段（`meta` 白名单从「`save`/`patchMeta` 各抄一份」收敛为单一 `META_PASSTHROUGH`，杜绝漂移）；
    锁定后编辑区只读（`.editor-pane > .panel` 整体 `inert` + 预览拖拽/↑↓ 重排守卫，抽屉与卡片显 🔒）；
    未开启分享时「导出分享页」**置灰**并提示去开启（门禁 `shareGate`；取不到状态一律放行，不锁死老路径）；
    分享标识写入导出页 `<meta name="resume-share-token">`，并在文案里**如实说明**「无托管后端、已发出的
    静态页无法远程吊销」；整库 JSON 备份/恢复（含标签/血缘/权限，导入为新增并重映射 `parentId`）；
    删除改为「二次确认 + 10 秒内可撤销」（`remove/undoRemove` 复用**原 id**，血缘与同步分键不断）。
  - 验收方式：`npm test`（单测 **933 → 1109**，全绿）+ 4 组**变异测试**全部被抓（分享门禁去掉 isPublic
    判断 / meta 白名单漏掉 isLocked / `undoRemove` 不恢复 / 分享页不写 token meta）；
    真实浏览器端到端（单文件版追加探针脚本）实测锁定态 6 个面板全部 `inert`、预览仍可滚动、
    🔒 与「分享中」徽标就位、删除后撤销条出现且能按原 id 找回。
  - 各需求文档状态更新为「待验收」并补 §九 实现记录与验收对照；`dist/` 与 `dist-desktop/` 已重建
    （单文件 1237 KB，外部引用 0；`verify:assets` 44 个引用全通过）。

- **App 导出落盘 + 原生打印（修复「打包成 App 后导出不落盘」）**：桌面/安卓 App 里点「导出 PDF/长图/单文件 HTML/数据 JSON/Word/TXT/MD」不产生任何文件、且点 PDF 会把界面顶掉 —— 根因是导出全走浏览器式 `Blob + <a download>`，而 macOS WKWebView 不支持 `blob:` 下载（WebKit bug 216918，完整证据见 `docs/技术设计方案/App导出不落盘问题-根因与改造方案.md`）。
  - **Rust 侧**（`src-tauri/src/export.rs` 新增）：`save_file`（弹系统保存对话框 + `std::fs::write` 写盘，`FilePath::Url` 即 Android `content://` 明确报错不假成功）+ `print_page`（`Webview::print()`，弥补 `window.print()` 在 WKWebView 静默空操作）。
  - **依赖/权限**：`Cargo.toml` 加 `tauri-plugin-dialog = "2"`；`lib.rs` 注册 `.plugin(tauri_plugin_dialog::init())` + 两命令；新建 `capabilities/default.json` 授权 `dialog:allow-save`（dialog 是插件命令必受 ACL 拦，自建命令不受拦）。
  - **前端分流**：`export-pdf.js` 新增统一 `downloadBlob(blob, filename)`（原生壳走 `__RESUME_NATIVE__.saveFile`，浏览器走 `<a download>`）；`downloadPDFNow`/`doExportDownload` 补存 `currentPdfBlob`/`currentExportBlob`；`exportJSON`/`exportJSONResume` 与 `export-extra.js` 的 `saveBytes`/`saveText`（Word/TXT/MD/静默 PDF）全部复用 `downloadBlob`；静默 PDF 失败回退改为优先走 `__RESUME_NATIVE__.printPage`。
  - **平台边界（如实标注）**：一期只覆盖桌面三端；Android 的 SAF 返回 `content://` URI 无法 `std::fs::write`，`save_file` 对此返回明确错误，单独立项（存私有目录 + 分享 intent）。
  - 浏览器路径（`npm start` / 单文件 HTML）零回归。
  - 原生保存成功提示走应用内通知中心 `ResumeNotifier.notify`（此前误写 `RB.notify` 会静默无反馈）。
  - 测试 `test/cases-native-export.js`（16 条）+ 四组变异测试全抓到（删 saveFile 桥 / bytes 不 base64 / 去 printPage 回退 / 退回 RB.notify）。

- **性能：每键渲染不再同步重画分页线（`#9`）**：`renderPreview` 每键调用 `drawPageGuides`（DOM 查询 + `getBoundingClientRect` + 建碎片），改为 `scheduleDrawPageGuides` 经 `requestAnimationFrame` 合并到单帧，避免逐键同步重画。`saveState` 写盘本就有 800ms 防抖（`pushRepoDebounced`），本项补上渲染侧合并。
  - 新增 `test/cases-perf.js` 断言「连续 3 次 renderPreview 只调度 1 次 rAF」；变异删合并守卫 → 断言变红（证伪有效）。断言计数 903 → **905**。

- **性能：每键全量内容哈希延迟到防抖结束（评估文档 §4.4 第 1 层性能债）**：`saveState()` 此前每敲一键都同步调 `contentHash()`（`JSON.stringify` 全量 + 逐字符 djb2，O(整份简历)/键，未受防抖覆盖）。现将哈希计算 + 指纹比对整体移入 `pushRepoDebounced` 的 800ms 防抖回调，每键只做 `currentPayload()`（浅组装，O(1)）+ 重置定时器 —— 连续敲 N 键从 N 次 O(简历) 哈希降为 1 次，语义等价（「内容未变跳过写盘」仍成立，判定仅延迟到防抖结束）。
  - **顺带修复跨简历污染隐患**：切换简历/新建/复制/派生/清空时，pending 的防抖回调仍闭包着旧份的 payload（`data/fonts/spacing` 引用），若不清掉会在 `activeResumeId` 切到新份后触发、把旧份数据写进新份。新增 `cancelPendingSave()`，在 `switchResume`（`await save` 之前）与 `applyPayloadWithoutSave`（载入新份前）两处调用。
  - 新增 `test/cases-save-debounce.js`（10 条）：防抖合并、取消 pending、接线断言；两组变异测试全抓到（回归每键同步哈希 / 删 `cancelPendingSave`）。断言计数 921 → **931**。

- **性能：预览缩放 reflow 合并到单帧（评估文档 §4.4 第 3 层性能债）**：`applyPreviewScale` 每次读 `getComputedStyle` + `clientWidth` + `offsetWidth/offsetHeight`（强制 reflow），而 `MutationObserver`（每键 renderPreview 重建 `.resume` 节点）+ `ResizeObserver` + `resize`/`orientationchange` 都直接触发它 → 每键一次完整 reflow。改为 `schedulePreviewScale` 经 `requestAnimationFrame` 合并到单帧（与分页线 #9 同款），同一帧内多次触发只执行一次；rAF 缺失时回退同步执行。至此评估文档 §4.4 三层性能债（全量哈希 / 分页线 reflow / 缩放 reflow）全部收敛。
  - 新增 `test/cases-perf.js` 断言「连续 4 次 schedulePreviewScale 只调度 1 次 rAF」；变异删 `_scaleRaf` 守卫 → 断言变红（证伪有效）。断言计数 931 → **933**。

- **dmg 打包辅助脚本（`tools/build-dmg.js`，`npm run desktop:dmg`）**：`npm run desktop:build` 在两类环境下会在最后一步 dmg 打包失败——① 沙箱把 `grep` 换成 toybox，其 `grep --color=never` 仍输出 ANSI 颜色码导致 create-dmg 的 `find_mount_dir` 正则崩坏；② headless/CI 无 Finder 自动化权限导致 osascript 报 -10004。`.app` 与 release 二进制此时已正常产出，只差 dmg 一步。新脚本复用已产出的 `.app`，把 `bundle_dmg.sh` 内 `grep` 替换为 `/usr/bin/grep` + 追加 `--skip-jenkins`，产出功能完整、仅无自定义背景/图标定位的 dmg（约 2.7 MB，校验 VALID）。

- **`ResumeExport` 命名空间合并（`#10`）**：`export-pdf.js` 与 `export-extra.js` 的挂载都改为 `Object.assign(global.ResumeExport = global.ResumeExport || {}, { ... })`，顺序无关、互不覆盖（修掉评估文档 §4.3 的「后加载者整包覆盖前者、丢 8 个函数」隐患）。

- **简历血缘（Resume Matcher master→tailored 模型，`js/store/resume-library.js`）**：多简历库补上「母简历 ↔ JD 派生版」的显式血缘。
  - meta 新增 `parentId`（母简历 id）/ `kind`（`master` | `derived`，缺省 `master`）/ `jobId`（关联 JD）/ `jdText`（JD 原文），
    全部可选、向后兼容；`create`/`save`/`patchMeta` 三处白名单透传。
  - 新增 `derive({parentId,title,payload?,jobId?,jdText?})` 显式派生入口（复制母简历 + 落血缘）与
    `children(parentId)` 反向查询（列出某母简历的全部派生版）。
  - `resumeDeriveFromJd`（A4 的「生成定制版」）改走 `derive`，派生时记 `parentId`/`kind:'derived'`/`jobId`/`jdText`，
    使 JD 不再只存 localStorage（换设备/清缓存即丢），而是随简历库持久化、可回溯到母简历与对应岗位。
  - 抽屉列表对派生版显示「定制版」小徽标（`.resume-item-kind`），一眼可辨。
  - 测试 `test/cases-library.js`（18 条）+ 五轮变异测试全抓到（丢 parentId / kind 缺省错 / save 漏 jobId / children 不过滤 / 缺 parentId 不抛错）。

- **分享页导出（A6，只读 + 水印，`js/export/export-pdf.js`）**：补上「简历做完发不出去」的短板。
  在「导出单文件 HTML」同源管线上新增「导出分享页」——产出带**斜置「仅查看」半透明水印**的只读静态页，
  内容与主简历一致、不含任何编辑控件、可本地打开或丢静态托管（GitHub Pages / Vercel）发给他人。
  - 纯函数：`buildSharePageHtml`（拼只读文档，标题/水印均 HTML 转义防注入）/
    `buildWatermark`（水印 CSS + DOM，`pointer-events:none` 不挡文本选中、`@media print` 打印时隐藏）。
  - 内置 `noindex,nofollow` 元标签，防静态托管后被搜索引擎收录隐私。
  - 入口：菜单「导出」组新增「导出分享页」→ `ResumeEditor.exportSharePage()`。
  - 连带修复：`js/export-extra.js` 曾整包覆盖 `global.ResumeExport`（`= {...}`），
    导致 export-pdf.js 挂上去的导出函数在测试/运行时丢失 —— 改为 `Object.assign(global.ResumeExport || {}, {...})` 合并。
  - 测试 `test/cases-export.js`（14 条）+ 四轮变异测试全抓到（去水印节点/标题不转义/去 noindex/水印拦截鼠标）。

- **JD 派生版本（A4，借鉴 Resume Matcher，`js/jd-derive.js`）**：在「JD 匹配分析」之上，
  一键生成**针对该 JD 的定制版简历**——复制主简历（不覆盖），把「缺失 / 弱覆盖」关键词整理成
  「JD 定制待补」技能分组插入副本，供用户逐条改写为真实经历（STAR 占位模板，绝不凭空编造）。
  - 纯函数：`buildDerivedPayload`（深拷贝插入，不改入参）/ `fillGroupFor`（缺失/弱覆盖分开标注+去重）/
    `suggestSentence`（STAR 占位）/ `deriveTitle`（标题带 JD 来源，可回溯）。
  - 入口：JD 面板「生成定制版」按钮 → `ResumeEditor.resumeDeriveFromJd()`。
  - 测试 `test/cases-jd-derive.js`（17 条）+ 四轮变异测试全抓到（浅拷贝改入参/去标记/不去重/后缀错）。

- **经历素材库（A5，STAR 片段复用，`js/store/snippet-library.js`）**：把一段段 STAR 经历作为
  可复用片段存起来（localStorage，独立于简历数据、不随飞书同步），投不同岗位时按需勾选组装。
  - 纯函数：`normalizeTags`（去重去空）/ `matchSnippets`（按 JD 缺失关键词命中数降序推荐）/
    `makeSnippet`；门面 `ResumeSnippets` 的 list/add/remove/get/count。
  - 与 A4 天然衔接：派生简历时可用 `matchSnippets` 按缺失关键词推荐素材片段。
  - 测试 `test/cases-snippets.js`（13 条）+ 四轮变异测试全抓到（不去重/不排序/大小写敏感/标题不 trim）。

- **PDF 结构化解析（A3，借鉴 OpenResume，`tools/pdf-parse.js`）**：在原有「识别姓名+联系方式+原文全保留」之上，
  新增**字段级抽取**——工作经历（公司/岗位/时间）、教育背景（学校/学位）、技能关键词，落到 `career`/`skills`
  结构化板块，供用户在编辑器里「一键套用/逐项确认」，而非手工重打。
  - 新增纯函数：`extractCareer` / `extractEducation` / `extractSkills` / `extractDateRange` / `classifySectionLine`。
  - **诚实原则不变**：缺公司/岗位的经历标 `__lowConfidence`（编辑器显示「（未识别，请补）」），
    识别不出结构的正文仍全保留进「导入原文」兜底，**绝不臆造、绝不丢内容**。
  - 测试 `test/cases-pdfparse.js` 新增 22 条；**四轮变异测试全部证伪有效**（长度阈值放宽 / 去低置信度标注 /
    去 career 落地 / 技能不去重 → 断言均变红）。

- **JSON Resume 双向适配（A2，互操作，`js/io/jsonresume-adapter.js`）**：`fromJsonResume` / `toJsonResume`
  把本项目简历模型与 JSON Resume 标准（jsonresume.org/schema）互转，用户可自由迁入/迁出。
  - 双环境模块（IIFE + CommonJS）：浏览器挂 `window.ResumeJSONResume`，Node 测试直接 `require`。
  - 字段映射尽力而为：work→career、education→教育、skills→矩阵式技能、projects→项目经历、
    basics→姓名/头衔/联系方式；无法映射的板块（highlights/growth）**并入 summary 兜底，绝不丢内容**。
  - 入口：菜单「导出」组新增「导出 JSON Resume」；`ResumeEditor.importJSONResume` 识别 jsonresume
    结构自动转换后导入（识别不出回退普通 JSON 导入）。
  - 测试 `test/cases-jsonresume.js`（26 条）+ 菜单一致性断言 1 条；**四轮变异测试全抓到**
    （company 错映射 / keywords 不加粗 / 丢 highlights.cards / 空输入不抛错）。
  - 真浏览器 e2e：单文件版 `ResumeJSONResume` / `exportJSONResume` / `importJSONResume` 均可用，
    往返转换 `basics.name`/`work.name`/`skills.keywords` 一致。

- **预览内 ↑↓ 排序（#8 触屏替代拖拽，`js/render/resume-render.js`）**：HTML5 DnD 在移动端不可用，
  给预览内所有可拖拽元素（板块 / 优势条目 / 经历 job / job 内 project / 技能分组 / 项目板块条目）
  加 `↑↓` 按钮，点按即同层级重排一位，复用已有的 `moveSection/moveItem/moveJob/moveProj/reInsert`。
  - 触屏与键盘可用：桌面 hover 显形、移动端（`@media (hover:none)` / `max-width:640px`）常显、打印隐藏；
    `↑↓` 按钮不触发拖拽（`dragstart` 对 `[data-reorder]` 直接 `preventDefault`）。
  - 补齐缺口：原先 `projects` 板块条目既不能拖也不能 ↑↓，现在一并加上 `draggable` + `data-drag` + `↑↓`。
  - 导出 PDF 两处 clone 路径均剥离 `.reorder-btns`，按钮不会进 PDF。
  - 测试：`test/cases-reorder.js`（50 条）覆盖六类上/下移、首尾越界返回 false、非法输入，
    并做变异测试（翻转首位边界判据 → 9 条断言变红）；真浏览器 e2e 确认点击「板块↑」真实 DOM 重排。
  - 测试总数 734 → **784**。

- **本地写服务的 HTTP 冒烟测试（`test/cases-serve-http.js`）**：真起 `serve.js` 子进程（随机端口）、
  打**真实 HTTP 请求**，这是整个 `test/run.js` 里唯一真正执行 serve.js 的一组用例。
  - 覆盖：索引读写、文档写入 → 读回 → 删除的完整往返（含 `savedAt` 时间戳）、
    非法 id（路径穿越 / 空 / 超长 / 含空格）一律 400、凭证文件（`sync.config.json` 等）403、
    非法载荷 400 而非 500，并**逐条断言请求后服务仍存活**、日志无未捕获异常。
  - 副作用控制：开始前备份既有 `index.json`，结束后还原；目录原本不存在时只清理本测试创建的文件，
    绝不触碰用户简历数据。
  - 测试总数 371 → **407**；并做**变异测试**验证有效性：把 `u` 改回 `try` 块内声明后，
    12 条断言立即变红（含「不得为 0/500」「该请求后服务仍存活」），还原后全绿。

- **常驻「保存状态条」（`js/ui/save-status.js` + `#saveBar`）**：把「改动是否真的落盘」
  变成预览区顶部一行常驻状态，解决前述反馈的三重不可见 ——
  ① `#autosave` 位于工具菜单面板头，而该面板默认 `width:0`，桌面看不到；
  ② 移动端 `.side-panel` 被 `display:none`、sync-pane 又无对应元素，手机上全丢；
  ③ 失败态压根没有表达（见上方「静默降级」）。
  - 六态：`idle`（整条隐藏）· `info`（启动说明）· `editing` · `saving` · `saved`（带 HH:MM）·
    `failed` / `degraded`（两态均带「重试」按钮）。配色严格留在 `--ui-*` 灰阶变量内，
    失败与降级用字重 + 下边框区分，不引入彩色；`@media print` 下一律隐藏，不污染简历。
  - 重试按钮不是装饰：先清掉降级锁，再**绕过内容指纹比对**强制写一次盘
    （否则内容未变会被 `saveState` 直接跳过，重试沦为空动作）；磁盘仍不可用会再次降级并再次告警。
  - 「编辑中 → 保存中」由 800ms 防抖窗口承担，用户不再对着静默干等。
  - 无障碍：`role="status"` + `aria-live="polite"`，读屏同样能收到保存结果。
  - 测试 407 → **467**（`test/cases-save-status.js`）：状态机六态文案互异、降级通知确实发出、
    重试语义、以及 index.html / build-single 白名单 / app.js 三态 / CSS / store API 五处接线。
    降级用例在**完全隔离的 vm 沙箱**中运行 —— 降级会改写模块级的后端状态，
    在共享上下文里做会污染其它用例（实测曾把 library 的往返读取用例带红）。
  - **变异测试**两轮：① 删掉降级通知 → 「降级恰好通知一次（实际 0 次）」等 2 条变红；
    ② 把 `markDegraded` 伪装成 `set('saved')` → 4 条变红。还原后 467 全绿。

- **设置页「数据体检」**：回答此前界面上完全无解的四个问题 ——
  **简历存在哪 / 有几份 / 最后一次写盘什么时候 / 旧单份数据还在不在**。
  修复前「简历库从未真正落盘」没有任何界面痕迹，用户打开简历库看到「还没有简历」，
  只会以为是自己做错了什么。
  - 新增 `GET /api/library/info`：由本地服务如实上报磁盘事实（目录绝对路径、目录与索引是否存在、
    简历份数、最近写盘时间、旧单份 `resume.json` 是否仍在）。
  - 设置页「数据」分组顶部渲染，进入即查，带「重新检测」按钮；处于降级态时明确标注
    「改动只存在本浏览器」，不会显示成「本地文件」误导用户。
  - 拿不到磁盘事实（`file://` / 桌面壳 / 未启服务 / 无 fetch）时标注「未知」并说明原因，
    **不编造路径**。
  - 测试 467 → **485**（接口行为 + 设置页接线）。
  - ⚠️ 隐私提示：界面会显示本机**绝对路径**（便于直接去 Finder 打开），
    截图分享设置页前请先留意这一点。

- **JD 匹配分析（`js/jd-match.js` + 右侧「JD 匹配分析」面板）**：粘贴目标岗位的 JD，
  把「任职要求」拆成关键词，与当前简历比对后分成**已覆盖 / 弱覆盖 / 缺失**三档并给出覆盖分。
  这是本工具此前最大的价值缺口：已有体检只回答「这份简历好不好」，**完全不看目标岗位**，
  而「一岗一版」恰恰是简历真正起作用的方式。
  - 三档语义：`已覆盖`（出现 ≥2 处）· `弱覆盖`（只出现 1 次 —— 写了但不够突出，
    是最容易被忽略的一档）· `缺失`（JD 有、简历没有，投递前最该补的）。
    覆盖分 =（已覆盖 + 0.5×弱覆盖）/ 总数，弱覆盖只算半分。
  - 弱覆盖与缺失项都标出**命中板块**（如 `Spring Boot@专业技能`），可直接知道去哪补。
  - 「者优先 / 加分」小句识别为**加分项**，沉到每档末尾 —— 不是必须项，不该占用注意力。
  - 匹配细节（这几处错了就会给出**假阳性**，实测都踩过）：
    · 英文短语整体合并（`Spring Boot` 不拆成 `Spring` + `Boot`，否则只写 Spring 也算两个都覆盖）；
    · 英文按词边界 + **右前瞻**匹配（`Java` 不命中 `JavaScript`，`Java,Java` 仍计 2 次）；
    · 中文按子串计次（`高并发` 里的 `并发` 算命中）；
    · 剥掉「熟悉 / 精通」等引导词与「经验 / 协作 / 部署」等动词尾巴（`算法协作` → `算法`）；
    · 排除学历 / 年限 / 年龄等硬性门槛，以及「任职要求 / 岗位职责」这类**结构性词**；
    · 编号列表（`3. 与产品…`）的编号不会粘进关键词，中英混血词（`Prompt 工程实践`）交给英文侧不重复计数。
  - **只读**：经 `ResumeEditor.getData()` 取数，不改数据、不触发保存、不进撤销栈（与体检同一约定）。
  - **隐私**：JD 原文只存浏览器偏好（`localStorage` 的 `resume_jd_text_v1`），
    **绝不写进简历数据、不随飞书同步上传** —— 这两条都有断言钉住。
  - 入口：右侧编辑区折叠面板（点标题展开即分析）、工具菜单「JD 匹配分析」按钮、
    手机「同步 / 工具 → 投递准备」。视觉复用体检面板的灰阶词汇（`--ui-*`），
    三档只靠边框线型 + 灰度 + 字重区分，黑白打印仍可分辨。
  - 测试 485 → **591**（`test/cases-jd.js`）：术语抽取、词边界、分桶与覆盖分自洽、
    只读性、隐私边界、渲染三档、以及 index.html / CSS / 构建白名单 / 模块 API 五处接线。
  - **变异测试五轮全部证伪有效**：① 去掉英文右前瞻 → 3 条红；② 退回单词切分 → 5 条红；
    ③ 把 JD 写进简历数据 → 2 条红；④ `SEG_SPLIT` 去掉 `.` → 2 条红；
    ⑤ `usefulZh` 改回「先剥词再删空格」→ 2 条红。还原后 591 全绿。

- **入口收敛：桌面工具菜单与手机「同步 / 工具」页合并为同一份声明式清单**：此前的两块 UI
  各自手写 `<button onclick=…>`，互相漏项且状态文案不同步 —— 桌面缺飞书同步与页面导航，
  手机缺「打印 / 另存为 PDF」「撤销 / 重做」「文件名」「分页线」「收起面板」。
  - 新增 `js/ui/menu-actions.js`（`window.ResumeMenu`）：一份 `MENU` 数组，每项含
    `label` / `title` / `run` / `d`（桌面分组）/ `m`（手机分组）/ 可选 `id`（跨端同 id 复用，
    如 `undoBtn` / `undoBtnMobile`）。`htmlFor('desktop'|'mobile')` 从同一份清单渲染两端，
    分组标题也由 `d` / `m` 决定，彻底消除「两份清单各写各的」。
  - 桌面「快速操作」栏标题改为「工具」，与手机一致；桌面补齐**飞书同步**（上报 / 拉取 / 历史 /
    消息通知）与**页面导航**（简历库 / 投递追踪 / 设置），手机补齐**打印 / 另存为 PDF、撤销、
    重做、文件名、分页线、收起面板**。
  - 状态文案按 id 同步两端：`updateUndoButtons` / `updateFileNameInput` / `updateGuideButton`
    / `exportPdfSilent` 的按钮占位均按 `…Btn` + `…BtnMobile` 双 id 更新，不再只管一端。
    `themeBtnLabel` / `themeBtnLabelMobile` 也随之同步。
  - 桌面专属项（`收起编辑面板`，手机无右侧编辑面板布局）用 `m: null` 标记，**只在桌面渲染**；
    断言钉住手机端不会出现 `paneToggleBtn`。
  - 测试 591 → **720**（`test/cases-menu.js`）：同一功能只在清单里定义一次（无跨端同 label 重复）、
    两端清单同源（`d`/`m` 分组序列一致）、桌面有而手机该有的项（打印 / 撤销 / 文件名 / 分页线）都已补、
    `m:null` 项手机不渲染、以及 index.html / CSS / 构建白名单 / 模块 API 四处接线。
    同时把 `test/run.js` 里一批「只匹配静态 HTML 文本」的旧断言改成对**渲染结果**断言，
    避免按钮搬家后这些旧断言变成假绿。
  - **变异测试四轮全部证伪有效**：① 手机端撤掉打印入口（`m:null`）→ 2 条红；
    ② 清单里重复定义「撤销」→ 1 条红；③ index.html 又手写一个导出按钮（退回两份清单）→ 1 条红；
    ④ 把 `收起编辑面板` 误放进手机端 → 补强断言后 1 条红。还原后 720 全绿。

- **撤销栈按简历隔离（修复跨份污染）+ 输入框放行原生撤销 + 撤销后落盘**：评估文档 §6.1 列的三处问题。
  - **跨份污染**：旧实现是全局单栈 `{undo,redo}`，切换简历不清栈，导致「在 A 简历按 Ctrl+Z 把 B 简历内容改回去」。
    现改为每个简历 id 各持一份栈（存于 `STACKS`），`hist.undo/hist.redo` 只是「当前激活简历栈」的引用，`recordHistory`/`undo`/`redo`
    经 `bindHist(activeResumeId)` 重指；单份模式 `activeResumeId` 为 `null`，用 `__default__` 兜底；`bindHist` 仅在「真正切换简历」时重置合并窗口，同一份内连续输入合并不受影响。
  - **吃掉输入框原生撤销**：旧 `keydown` 全局 `preventDefault` → 在文本框里想撤一个词会回滚整份简历。
    现新增 `isEditableTarget(el)`（INPUT / TEXTAREA / contenteditable 视为可编辑），**字段内按 Ctrl/Cmd+Z 直接放行浏览器原生撤销**，不再拦截；非字段目标（body 等）仍走应用级整段撤销。
  - **撤销后不落盘**：`undo`/`redo` 在恢复快照后新增 `if(bootDone){ markDirty(activeResumeId); saveState(); }`，撤销结果经统一防抖写盘链路落盘。
  - 测试 720 → **734**（`test/cases-undo.js`）：跨份隔离（切到 r2 后撤销不会回滚 r1、切回 r1 能逐步撤销自己的历史）、单份内撤销/重做回归、以及 `isEditableTarget` 契约（INPUT/TEXTAREA/contenteditable 可编辑、BUTTON/DIV/null 不可编辑）。
    另补 `ResumeEditor.setActiveResumeId` / `isEditableTarget` 两个公共 API 暴露（供平行模块与测试使用）。
  - **变异测试三轮全部证伪有效**：① `bindHist` 永远绑到默认栈（忽略 id，退回共享全局栈）→ 跨份隔离两条断言红 + 合并窗口两条红；
    ② 删掉 `undo()` 内的 `bindHist` → 跨份隔离两条断言红；③ `isEditableTarget` 永远返回 `false` → INPUT/TEXTAREA/contenteditable 三条契约断言红。还原后 734 全绿。
  - 真浏览器端到端（单文件版 + headless Chrome）：在姓名输入框聚焦态按 Ctrl+Z → `fieldSafe=1`（整份简历未回滚，交浏览器原生撤销）；在 body 聚焦态按 Ctrl+Z → `bodyReverts=1`（应用级撤销仍生效）。确认修复真实生效。

- **专业技能板块改版为「矩阵式技能表」**：左列分组名，右列「关键词行 + 补充说明行」——
  关键词行用 `·` 分隔列出**完整专业名词**（`**xxx**` 渲染成浅灰底加粗高亮），说明行承载
  掌握程度与成果。好处：HR / AI 检索能定位到术语（术语一个不丢），人扫一眼又能读出强弱。
  - 数据模型新增 `keywords` / `detail` 两个非破坏性字段：分组**没填**这两项时自动回落旧版
    `<ul>` 列表，历史数据零改动。
  - 渲染 `kwText()`：先按 `·` 切段 → 每段包一层 `inline-block`（换行时整段挪走，绝不把术语
    从中间截断，`word-break:keep-all` + `overflow-wrap:anywhere` 兜底）→ `**加粗**` 支持
    跨分隔符整段高亮（`**JVM 调优 · 并发编程**` 曾是字面量星号 bug）。
  - 三条下游链路同步跟进：**TXT / DOCX 导出**保留加粗与术语（ATS 抓取不丢）、
    **投递体检**按新字段统计内容量（漏了会误判成空板块）、**作品集页**改用分组块渲染。
  - 间距面板新增 `技能矩阵行 / 技能关键词行 / 技能说明行` 三项，逐行可微调；矩阵行默认 0，
    避免与旧 `skillGroup` 默认值叠加出大片空白。
  - 配色仍严格走灰阶：高亮底 / 文字色取自 `--paper-kw-bg` / `--paper-kw-text`，
    深色纸张与打印版各自有定义，打印同样可见。
  - 内容按简历既有经历重写为 6 组（`AI / Agent`、`Agent 基建`、`Java 后端`、`数据与中间件`、
    `语言 / 前端`、`工具 / 基建`），逐词核对依据，不引入简历之外的经历。
  - 测试增至 **371 条**（新增技能矩阵断言 18 条：9 条渲染 + 3 条编辑器接线 + 变异测试验证；
    其中「专业名词整段换行」一条经**变异测试**证伪有效——去掉 `inline-block` 包裹后必红，
    「编辑器渲染出关键词行输入框」同样在删除该字段后必红）。

- **统一「分文件」存储模型（P0 存储改造）**：一份简历 = 一个文档（docId = resumeId），
  本地保存与飞书同步保存同构。
  - **移除浏览器持久化**：IndexedDB（`resume_builder` / `resume_library`）与 localStorage
    不再承载简历数据（打包安装包后无浏览器环境）；localStorage 仅保留 UI 偏好。
  - **本地分文件落盘**：桌面安装包 → `app_data_dir()/resumes/index.json + <id>.json`
    （新增 Rust 命令 `resume_index_load/save`、`resume_doc_load/save/remove`，见 `src-tauri/src/storage.rs`）；
    浏览器开发模式 → `data/resumes/`（serve.js 新增 `/api/library/*`，与桌面端同构）。
  - **文件名 = 简历 id（稳定锚点）**：重命名 / 打标签只改 `index.json` 的 `title` / `tags`，
    正文文件不动；与飞书 `file_token_<id>` 分键天然一致。
  - **本地自动保存哈希比对**：编辑 → `stableHash` 内容指纹比对（与飞书自动同步同一套规则）→
    800ms 防抖 → 内容未变跳过写盘；指纹持久化在 `index.json`，重启后仍生效。
  - **系统配置与简历数据分文件**：`sync.config.json` / `sync.state.json`（系统配置 + 同步状态）
    与 `resumes/`（简历数据）彻底分离；飞书自动同步进度（lastPushedHash / lastRemoteFp /
    skipNextPull / lastPushNotifyAt）从 localStorage 迁到索引项，随简历走、落盘持久化。
  - **统一存储抽象**：ResumeLibrary 后端可注入（native / http / memory 三态自动检测），
    local 适配器从 IndexedDB 换成本地文件系统；未来新数据源实现同一接口即可。
  - 旧单份 `data/resume.json`（web 模式）首次启动自动迁移为第一份简历，老数据不丢。
  - 测试增至 **353 条**（新增：saveState 不再写 localStorage、rename 不影响正文文件、
    lastHash 指纹透传 / patchMeta 等）。

- **上传 PDF / JSON 简历到简历库**：左抽屉新增「上传」按钮（`.pdf` / `.json`）。
  JSON 直接导入为一份新简历；PDF 经本地服务用 vendored pdf.js（`vendor/pdf.min.js`，Apache 2.0，
  仅服务端使用、不进前端产物）提取文本，尽力识别姓名 / 邮箱 / 手机号 / 学历线索，
  正文整篇保留进「导入原文（请校对整理）」板块供继续编辑 —— 解析只做「识别 + 保留原文」，不臆造结构。
- **飞书扫码授权（OAuth 授权码模式）**：「飞书同步 → 同步配置」新增「扫码授权」——
  后端预配置应用身份，前端无需填写 App ID，一键打开飞书授权页，手机扫码授权后服务端以授权码换取
  user_access_token（含 `drive:drive` / `docx:document` scope），凭证存本机
  gitignored 的 `sync.oauth.json`，绝不进浏览器；支持过期自动用 refresh_token 刷新、
  一键解除授权。
- **飞书「扫码注册个人应用」（Device Flow，拿到 App ID / App Secret）**：新增「方式二 · 扫码注册个人应用」——
  借鉴 channel-hub 的 `LarkPersonalQrcodeService`，复刻飞书官方 SDK 的 RegisterApp 设备流（RFC 8628）。
  点「扫码注册个人应用」→ 后端向 `accounts.feishu.cn/oauth/v1/app/registration` 发起 `begin` 拿到设备码与二维码 URL
  → 浏览器用 vendored `qrcode-generator.js` 渲染二维码 → 手机飞书扫码确认 → 飞书后台自动创建一个 PersonalAgent（个人应用）
  并以 `poll` 轮询（尊重飞书返回的 `interval` 节流、`slow_down` / 过期 / 域名切换均处理）；
  成功即拿到 `client_id` / `client_secret`，后端自动写入 `sync.config.json` 并探测绑定云盘文件夹，**无需在开放平台手动抄写凭证**。
  至此「应用身份」也由扫码获取，与「用户身份」扫码授权形成两种方式并存。
- 测试从 311 条增至 **329 条**（新增飞书设备流注册用例 11 条：addons 编码往返 + poll 各状态映射；配置弹窗 UI / 路由冒烟断言若干）。当前以 `npm test` 实测为准。
- **同步链路优先使用扫码身份**：「上报到飞书 / 从飞书恢复」现在优先以**扫码授权的用户身份**
  读写你自己的云盘/文档（未扫码时自动回退应用身份）；上报结果会标注所用身份。
  两套身份的云盘文件/文档 token 在本地 state 中分键隔离，互不串写。

### 变更

- **简历卡片操作收进「⋯」菜单**：重命名 / 复制 / 删除不再平铺在卡片上（鼠标扫过卡片时极易误点，
  尤其「删除」），改为点卡片右上角的「⋯」弹出菜单。菜单挂在 `body` 上的固定层
  （抽屉列表是 `overflow:auto`，绝对定位子元素会被裁切），自动避开视口越界；
  点空白 / Esc / 滚动 / 改窗口大小都会关闭；触屏设备（无 hover）「⋯」常显。
  点「⋯」不会顺带打开或切换该份简历（点击与回车均 `stopPropagation`）。
- **移除右缘重复的「简历」把手**：`railResumeTab` 与抽屉自身的折叠按钮 / 左缘展开把手功能重复，
  已删除；抽屉仍保留自身两个收展入口，手机上仍可从「同步 → 我的简历」打开。
- 测试从 267 条增至 **295 条**（新增 PDF 解析纯函数 16 条 + 扫码授权 URL 6 条 + 认证分键 3 条等）。
- 测试从 295 条增至 **308 条**（本次新增：卡片操作菜单 7 条 + 右缘把手移除 2 条；其余为同批扫码授权预配置用例）。
- **右缘标签改为与编辑面板同款推展、且多选一**：「工具菜单」不再是垂直居中的浮动小卡片，
  改为 `.app` 的 flex 兄弟列（通栏到底、宽 460，平板 380），展开时把预览推窄、纸张自动重新居中缩放，
  位置与编辑面板完全一致；面板之间、面板与编辑面板之间互斥（展开任一方即收起另一方）。
  涉及 `index.html`、`css/style.css`、`js/app.js`。
- 测试从 308 条增至 **311 条**（新增：面板↔编辑面板互斥 2 条 + 推展布局结构 3 条）。
- **飞书扫码授权：应用身份改为后端预配置**，前端无需填写 App ID / App Secret，直接点「扫码授权」即可；管理员仍可通过「方式二 · 自动探测并绑定」首次配置应用身份。调整 `tools/feishu-oauth.js`、`tools/serve.js`、`js/app.js`、`index.html`、`test/cases-oauth.js`。

---

## [1.1.0] - 2026-09-19

**首个跨平台（桌面 + Android）发布。** 在 1.0.0 的浏览器版之上，引入 Tauri 2 原生壳：
同一份前端产物现在能打包成 Windows / macOS / Linux 安装包与 Android APK / AAB，
并新增 GitHub Release 自动发版流水线（三平台 + 安卓一键出包并附带本文件作为更新说明）。

### 新增

- **跨平台（桌面 / 安卓）**：引入 Tauri 2 原生壳（`src-tauri/`），同一份前端产物可打包为
  Windows `.msi`/`.exe`、macOS `.app`/`.dmg`、Linux `.deb`/`.AppImage`，以及 Android `APK`/`AAB`。
  通过 `withGlobalTauri` 保持**零前端依赖、无打包器**的既有风格。
- **自动发版流水线（`.github/workflows/release.yml`）**：推 `v*` 标签或手动一键触发，
  自动构建三平台桌面包与 Android 包，聚合成一个 GitHub Release，附 `SHA256SUMS.txt` 校验文件；
  版本号与更新说明分别取自 `tauri.conf.json` 与 CHANGELOG，无需手工编辑 Release 页面。
- **原生层只做脏活**：飞书 HTTP 传输、凭证保管（`app_secret` 只存在于 Rust 进程）、token 缓存、
  multipart 上传、二进制流下载下沉到 Rust；业务编排仍留在 JS（`js/store/native-bridge.js` 复刻 `tools/feishu-sync.js` 的语义）。
- **数据门面（`js/store/resume-store.js`）**：把原先散落的 `fetch('/api/*')` 收敛为
  Local / Browser / Feishu 三种可替换实现，业务代码不再感知存储方式。
- **投递体检（`js/audit.js`）**：纯规则、只读的数据检查 —— 页数、内容完整性（含「一个板块都没有」「缺少一句话头衔」）、
  量化结果、ATS 友好度、时间倒序、敏感信息（身份证号等），分「必须处理 / 建议修改 / 可以更好」三级，点击条目可定位到对应板块。
- **多格式导出（`js/export-extra.js`）**：Word（`.docx`，真 OOXML、真加粗）、纯文本（`.txt`）、
  Markdown（`.md`），以及**静默 PDF**（经本地服务调用本机浏览器 headless 打印，产出文字可选的矢量 PDF，不弹打印对话框）。
- **响应式布局**：移动优先断点、移动端底部 Tab、A4 等比缩放（`transform: scale`，避免 `zoom` 引发的重排）、
  安全区与软键盘适配（`--vvh` / `--kb`）、返回键优先级语义（弹层 > 视图 > 真后退）。
- **主题（`js/theme.js`）**：日间 / 夜间切换，仍严格限定黑白灰。
- **飞书同步**：手动「上报到飞书」/「从飞书恢复」，数据双写飞书文档与云盘文件，借其版本历史留存每次更改。
- **CI 出包**：`.github/workflows/build-desktop.yml`（三平台矩阵）、`build-android.yml`（APK + AAB）。

### 修复

- **投递体检对「成果点」稳定误报（产品缺陷）**：项目成果点（`results`，如「QPS 提升 40%」）本就是 8–12 字短句，
  却被套用「描述过短（< 15 字）」的下限，导致**任何写得正常的简历都会被报「N 条描述过于单薄」**。
  现让 `results` 只参与「缺量化」与「超长」检查。
- **`tools/render-resume.js` 静默失效**：vm 沙箱未提供 `clearTimeout`，而 `app.js` 的数据写回防抖依赖它，
  缺失后脚本直接抛错（表现为「渲染失败」，但根因不在渲染）。已补齐定时器，并在产物落盘后显式退出。
- **单文件版「剩余外部引用」长期误报**：统计正则把 jsPDF 内部的拼接字符串算成了残留引用，于是恒定显示 1 个。
  现只统计真实引用，并打印出具体路径。
- **打印 / 静默导出的页边距不跟随设置（真实缺陷）**：`css/style.css` 里 `@page{size:A4;margin:14mm}` 是硬编码值，
  于是「页面边距」面板无论怎么调，`Ctrl/Cmd+P` 打印与静默导出的 PDF 边距都恒定 14mm —— **用户的设置形同虚设**。
  现由 `js/app.js` 动态维护 `@media print{@page{...}}`（随 `renderPreview()` 同步），`tools/render-resume.js` 注入同源规则；
  实测同一份简历 14mm → 4 页、30/25mm → 5 页，纸张仍为 A4。顺带修掉边界：`pageMargins` 里的 `null`
  不再被 `Number(null) === 0` 悄悄变成「0mm 边距」。
- **页边距回归防护**：新增 4 条断言钉住「动态 `@page` 接线 + 空值回退 + 默认值兜底」——
  这类失效在界面上完全看不出来，只能在测试里拦（断言总数 117 → **125**）。
- **导出模块的测试盲区（由变异测试发现）**：`js/export-extra.js` 此前只有临时脚本验证过、
  没有进入回归测试。补齐 `test/cases-export.js`（14 用例 / 78 断言）时用变异测试反向校验断言有效性，
  当场抓出两个真实盲区并修掉：① 原先只校验 zip **中央目录**的压缩标记，把**本地文件头**写成 deflate(8)
  时全部断言仍通过 —— 但流式解压器只读本地头，会解出损坏文件（现两处都校验，含 UTF-8 文件名标志 `0x0800`）；
  ② 「技能整句用『；』连接」的用例只有一条长句，`join` 的分隔符根本不可观测，该规则永远测不出来（已补第二条）。
  断言总数 125 → **203**。
- **Android 构建四连坑（均在 CI 实测定位并修复）**：
  ① `android-actions/setup-android@v3` 的默认包列表含已被 Google 下线的 `tools` → 20 秒即失败，升 `@v4`；
  ② `package.json` 缺 `"tauri": "tauri"` script，而 `tauri android init` 会把
  `npm run -- tauri android android-studio-script` **烘焙进生成的 Gradle 工程** → `:app:rustBuildArm64Debug`
  必失败；
  ③ release 签名补丁里写了 `java.util.Properties` 全限定名，被 Gradle Kotlin DSL 的 `java` 扩展
  **遮蔽** → `Unresolved reference: util`；正确修法是改用顶层 `import` + **简单名**，
  而不是「去补 import」；
  ④ 顺着 ③ 的错误修法无条件插了一整块 import，而模板**第一行本来就是** `import java.util.Properties`
  → 重复 import → `Conflicting import, imported name 'Properties' is ambiguous`。
  现在补丁改为**逐条「先查再插」**，并按官方文档把 `signingConfigs` 插进 `android{}` 内
  （`buildTypes` 之前）而非末尾追加第二个 `android{}`。详见 `docs/构建与发版/Android版构建说明.md` 第 5.4 / 8 节。

### 变更

- **`tools/serve.js` 仅监听回环地址**：`listen(PORT, '127.0.0.1')`，同网段他人无法再读取本地简历数据。
- **`index.html` viewport 补 `viewport-fit=cover`**：此前 `env(safe-area-inset-*)` 恒为 0，安全区适配实际是死代码。
- **`@media print` 补隐藏清单**：`.mobile-tabbar` / `.sync-pane` 此前未隐藏，手机打印会把底部 Tab 打进 PDF。
- **测试运行器修复**：`test/run.js` 原先硬编码只读 `test/cases.js`，导致 `test/cases-audit.js`（294 行）
  **从未被执行过**；且沙箱缺 `clearTimeout` 会让套件提前终止。两者均已修复，断言总数 49 → **117**。
- **CI 环境加固**：所有用到的 action 升到当前最新稳定
  （`actions/checkout@v7`、`actions/setup-node@v7`、`actions/setup-java@v6`、`actions/upload-artifact@v7`、
  `android-actions/setup-android@v4`），消除 Node 20 弃用警告。

### 安全

- 新增前端资源完整性门禁（`npm run verify:assets`）与注入属性清理（`npm run clean:html`），并接入 CI。
- **Android 上传密钥库绝不入库**：仓库根 `.gitignore` 与 `android-signing/.gitignore` 双层忽略；
  密钥库只以 base64 存于 GitHub Secrets，CI 时解码到 `$RUNNER_TEMP` 并随 runner 销毁。
- **新增 APK 签名证书自动断言**：签名配置失败是静默的（Gradle 不报错、只悄悄出 debug 包），
  现由 CI 读取产物证书 SHA-256 与期望值硬比对，不符即让构建失败。

后续规划见 [ROADMAP.md](./ROADMAP.md)。

---

## [1.0.0] - 2026-08-31

首个可公开发布版本。相对最初的个人单文件原型，补齐了「通用性 / 数据可移植性 / 工程化」三块，
使项目从「个人可用小工具」达到「可分享、可协作的开源项目」成熟度。

### 新增
- **数据可移植性**：新增「导出数据 / 导入数据」按钮，全量内容可导出为 JSON 文件备份、换设备/换浏览器后导入恢复（`exportJSON` / `importJSON` / `applyImported`，导入含基础校验与旧格式规范化）。
- **板块增删**：编辑器底部「添加板块」卡片，支持新增「个人优势 / 职业履历 / 核心技能 / 项目经历」；每个板块头部支持「删除板块」（至少保留 1 个，仅剩 1 个时拦截）。
- **撤销 / 重做**：全量状态快照栈（上限 100 步）。文字输入、字号/间距微调、增删/移动板块与条目、拖拽重排、重置、导入全部可撤销；连续打字/调参 700ms 内合并为一步；工具栏按钮 + `Ctrl/Cmd+Z`、`Ctrl/Cmd+Shift+Z`、`Ctrl+Y` 快捷键。
- **原生打印导出（推荐）**：新增「打印 / 另存为 PDF」按钮，走浏览器原生打印管线，产出矢量文字 PDF（文字可选中、体积小）；完善了 `@media print`（A4 纸张、隐藏全部 UI、条目分页保护、精确打印底色）。
- **工程化**：新增 `test/`（纯 Node、零依赖、38 条断言）、`package.json`（`npm test` / `npm run build`）、`.github/workflows/ci.yml`（push/PR 自动跑测试与构建）、`js/app.js` 整体封装为 IIFE 并暴露 `window.ResumeEditor` 命名空间。

### 修复
- **`projects` 板块静默 bug**：编辑/输入/点击/迁移都支持 `sec.type==='projects'`，但预览渲染 `renderResumeInner` 此前无该分支——数据里一旦出现 projects 板块，编辑器能改、预览却空白。已补全预览分支与 `blankItem('projects')` 默认结构。
- **历史栈合并缺陷**：首版仅合并 `edit` 输入，`setting`（字号/间距）每键独立入栈导致历史爆炸；已统一为 `edit/setting` 合并、`action` 不合并。

### 变更
- **去硬编码身份**：`SAVE_KEY` 由 `resume_chenpeisheng_v1` 改为通用 `resume_builder_data_v1`，并保留旧 key 迁移逻辑（首次启动自动迁移，旧内容不丢）；PDF 文件名与页面标题改为基于 `data.name` 动态生成。
- **构建产物自动同步**：`tools/build-single.js` 改为一次命令同时写 `dist/` 与根目录单文件版（同一 Buffer + md5 一致性校验），消除此前手动 `cp` 易不同步的隐患。
- **删除死代码**：移除从未调用的 `spacingClass`、`renderSpacingInputs`、`labelWithSpacing`。

### 已知限制（非阻塞）
- 旧版「图片型 PDF」（`exportPDF()`）保留为兼容项：文字不可选、体积较大，适合对版式像素级一致有要求的场景。
- `js/data.js` 的 `data` / `currentFonts` / `currentSpacing` 仍为全局变量（数据模块，IIFE 闭包可读写），为有意保留的低风险残留。

### 安全
- 仓库含示例个人简历数据（`js/data.js`），公开仓库前请替换为占位内容或确认无隐私风险。
