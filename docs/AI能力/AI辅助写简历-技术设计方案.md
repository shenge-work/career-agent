> ⚠️ **v1 已退役文档 · 仅供历史参考**
> 本文描述的是 v1 时代（零后端单文件 / Tauri 桌面·安卓壳 / 飞书同步 / CI 三平台发版）的方案。
> v2 已于 2026-11-04 重构为「本地服务器 + 账号行级隔离 + NestJS/React/PGlite」并退役上述能力，项目更名为 **CareerAgent**（AI 转发层与按账号配置已在 v2 重建）。
> 当前架构与定位以 `docs/重设计构思-个人求职Agent工作台.md` 与 `docs/需求文档/00-产品定位与评审标尺.md` 为准。

# Resume Studio · 技术设计方案（AI 辅助写简历）

> ## ⏸ 状态：未来演进方向 · 当前暂不实施
>
> 截至 **2026-09-18**，本项目仍是 `resume-builder`（纯前端、**无 AI 能力**）。
> 本文所有内容 —— 改名 Resume Studio、新增 `js/ai/` 目录、`tools/ai-proxy.js` 等 —— **均尚未落地**，
> 不代表当前代码库的真实状态。当前可用功能请以 [README.md](../../README.md) 为准，
> 演进计划登记在 [ROADMAP.md](../../ROADMAP.md)「未来演进」一节。
>
> 保留本文的价值：选型调研（尤其是「主流厂商禁止浏览器直连」这条结论）与交互设计已经论证完毕，
> 将来真要动手时可直接照此执行，不必重新调研。

---

> 目标：在现有「简历编辑器」基础上叠加 AI 辅助写作能力，同时守住两条底线——
> **① 保持零依赖、零构建、单文件版可用的项目气质；② 视觉严格黑/白/灰。**
>
> 改造策略（已确认）：**小步快跑** —— 不转 ES Module、不拆分 `js/app.js`，
> AI 能力以新增目录 `js/ai/` 的方式平行接入，通过 `<script>` 顺序加载挂到全局命名空间 `ResumeAI`。

---

## 一、项目命名

| 项 | 值 |
|---|---|
| 产品名 | **Resume Studio**（中文：**简历工坊**） |
| 仓库名 | `resume-studio` |
| 定位一句话 | 左预览、右编辑、右侧 AI 陪写；数据全在本机，导出可选中文字的 PDF |
| 包名 | `package.json` 的 `name` 改为 `resume-studio`，其余不动 |

命名理由：直白、中英通用、一眼知道是干什么的，且不像 `resume-builder` 那样泛滥。
保留 `resume-builder` 的迁移说明写进 README，避免已 clone 的人困惑。

---

## 二、技术选型

### 2.1 一条决定架构的调研结论

**所有主流模型厂商都禁止浏览器直连**：

| 厂商 | 浏览器直连 | 依据 |
|---|---|---|
| DeepSeek | ❌ | 不允许任意 origin 的 CORS |
| 智谱 GLM | ❌ | 生产端点返回 `Access-Control-Allow-Origin: null`，且 `Access-Control-Allow-Headers` 不含 `Authorization` |
| OpenAI / Anthropic | ❌ | 设计上不给 completion 端点发 ACAO 头 |
| 硅基流动等聚合平台 | ❌（视配置） | 同上，默认不开放 |

> 也就是说，"纯前端 BYOK 直连"在国产模型上基本是死路，只有自建 one-api / new-api 类网关才可能直连。
> **结论：AI 请求必须经过一个受控的转发层。**

这反而是好事。项目已有 `tools/serve.js`（零依赖 Node HTTP 服务），扩展一个 SSE 转发路由即可，
`npm start` 的使用体验完全不变，还额外换来：Key 不进浏览器、prompt 集中管理、缓存与用量统计。

### 2.2 选型表

| 层面 | 选择 | 理由 |
|---|---|---|
| 运行时 | 浏览器 + 本地 Node 服务 | 沿用 `tools/serve.js`，零新增依赖 |
| 前端框架 | **无**（原生 JS，保持现状） | 已有 1289 行 IIFE 运行良好，引入框架得不偿失 |
| 模块方案 | **全局命名空间 `ResumeAI`**（IIFE 分文件） | 小步快跑；`file://` 与单文件版不受 ESM CORS 影响 |
| 类型 | **JSDoc 注解**，不上 TypeScript | 编辑器有补全与检查，零构建成本 |
| AI 协议 | **OpenAI Chat Completions 兼容协议** | 国产模型几乎全兼容，一层适配打天下 |
| 默认模型 | **DeepSeek**（`deepseek-v4-flash` 日常 / `deepseek-v4-pro` 攻坚） | 中文强、价格低、1M 上下文；`deepseek-chat` / `deepseek-reasoner` 为即将废弃别名，不使用 |
| 传输 | **SSE 流式**（`stream: true`），Node 端 `Readable.fromWeb().pipe()` 透传 | 体验必需；Node 22 原生 fetch 支持流 |
| 结构化输出 | 诊断/生成类用 `response_format: json_object`；润色类用纯文本 | 诊断结果要能被程序消费；润色要保留原文语感 |
| 测试 | **Node 内置 `node:test`**（Node 22 自带） | 零依赖；现有 `test/run.js` 的 vm 桩继续保留给 app.js |
| 依赖 | **0 个** | 项目红线 |

### 2.3 明确的「不做什么」

- ❌ 不引入 React / Vue / Vite / TypeScript / 打包器
- ❌ 不做账号体系、云同步（沿用 ROADMAP 中已否决的结论）
- ❌ 不做服务端渲染、不做数据库
- ❌ 不把 AI 配置写进 `data/resume.json`（简历数据保持纯粹，见 §6）

---

## 三、架构设计

### 3.1 分层

```
┌─ 浏览器 ─────────────────────────────────────────────┐
│  UI 层     js/ai/ui/{panel,selection,diffcard}.js     │
│                ↓                                      │
│  编排层    js/ai/{scope,sanitize,guard,diff,apply}.js  │
│                ↓                                      │
│  能力层    js/ai/{prompts,provider,presets}.js         │
└────────────────┬─────────────────────────────────────┘
                 │  POST /api/ai/chat  (SSE)
┌─ 本地 Node 服务 ─┴────────────────────────────────────┐
│  tools/ai-proxy.js   读 ai.config.json → 转发 → 透传流 │
│  tools/serve.js      静态托管 + POST /api/resume（原样）│
└────────────────┬─────────────────────────────────────┘
                 │  https://api.deepseek.com/chat/completions
```

### 3.2 五条贯穿始终的设计原则

这是整个 AI 功能的灵魂，比任何单个功能都重要：

1. **AI 永不直接落笔。** 所有输出先变成「建议」，以 Diff 形式呈现，用户逐条接受或拒绝。
   简历是高风险内容，一个编造的数字可能直接导致面试翻车。
2. **作用范围必须显式。** 面板顶部常驻「范围条」，明确显示 AI 正在读/改哪一段
   （如 `职业履历 › 某公司 › 项目A › 描述`）。用户随时可改，杜绝"AI 悄悄改了全文"。
3. **进撤销栈。** 每次「应用建议」都调用现有 `recordHistory()`，`Ctrl/Cmd+Z` 可整体回退。
4. **事实性护栏。** AI 输出若出现原文没有的数字/百分比/时间/公司名，自动高亮标记
   「疑似新增，请核对」，不阻止但不放过。
5. **可脱敏。** 提供开关：发送前把姓名/手机/邮箱/公司名替换为占位符，返回后自动还原。

### 3.3 服务端接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/ai/chat` | body `{messages, model, temperature, stream}`，SSE 透传上游 |
| `GET` | `/api/ai/status` | 返回 `{configured, provider, model, reachable}`，供 UI 显示连接状态 |
| `POST` | `/api/ai/test` | 用一条极短消息测连通性，返回延迟与错误详情 |

实现要点（零依赖）：

```js
// tools/ai-proxy.js 核心片段
const upstream = await fetch(`${cfg.baseURL}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
  body: JSON.stringify({ model, messages, temperature, stream: true })
});
res.writeHead(upstream.status, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive'
});
Readable.fromWeb(upstream.body).pipe(res);   // 不 buffer，保住 token 级流式体验
```

---

## 四、功能设计

### 4.1 能力清单

| # | 功能 | 优先级 | 输入 | 输出 | 说明 |
|---|---|---|---|---|---|
| 1 | **划词润色** | P0 | 选中的一句话/一段 | 1–3 个改写候选 | 杀手锏交互，选中即浮出工具栏 |
| 2 | **条目改写** | P0 | 单个项目/工作经历条目 | STAR 化 + 量化改写 | 简历最刚需的一件事 |
| 3 | **JD 匹配诊断** | P0 | 粘贴的岗位描述 | 匹配度评分 + 缺失关键词 + 逐条建议 | 决定是否值得投 |
| 4 | **全文体检** | P0 | 整份简历 | 篇幅/动词强度/量化缺失/重复词/ATS 友好度 | 清单式输出，可跳转到问题处 |
| 5 | 素材 → 结构化条目 | P1 | 一段流水账 | 规范 bullet 列表 | "我做了这些事" → 简历语言 |
| 6 | 中英互译 | P1 | 选中内容 | 目标语言版本 | 外企投递刚需 |
| 7 | 面向某公司定制 | P1 | 公司名 + JD + 当前简历 | 一版定制稿（Diff 形式） | 一次生成多个板块的建议 |
| 8 | AI 历史回溯 | P1 | — | 本次会话的建议列表 | 可重新查看/回滚已应用的建议 |
| 9 | 模拟面试官提问 | P2 | 简历 + JD | 10 个可能追问 | 写完简历顺手准备面试 |
| 10 | 多版本对比 | P2 | 两份 JSON | 差异视图 | 依赖 AI 历史积累 |

### 4.2 统一交互闭环（所有功能共用）

```
选中范围 → 选动作 → [可选] 补指令 → 流式生成 → Diff 审阅 → 逐条应用 → 进撤销栈
                                          ↑                    │
                                          └── 重新生成 ←────────┘
```

**范围（Scope）四级**，由 `js/ai/scope.js` 解析为结构化上下文：

| 级别 | 来源 | 上下文切片内容 |
|---|---|---|
| `selection` | 预览区/编辑区划选的文字 | 该片段 + 所属条目的其余字段（让 AI 知道语境） |
| `item` | 条目上的「AI」按钮 | 整个 job/project 对象 |
| `section` | 板块标题上的按钮 | 该板块全部条目 |
| `whole` | 面板顶部切换 | 全份简历（可开脱敏） |

### 4.3 Prompt 工程约定

- 所有 prompt 集中在 `js/ai/prompts.js`，**一个场景一个导出函数**，签名统一：
  `buildMessages(scope, userInput, stylePrefs) → [{role, content}]`
- 系统提示固定三块：**角色** / **硬约束** / **输出格式**
- 硬约束（每次必带，不可覆盖）：

  > 1. 不得编造任何原文中不存在的事实、数字、时间、公司名、技术栈。
  > 2. 需要量化但原文无数据时，用 `[待补充：xx]` 占位，不要自己填数字。
  > 3. 保持用户的第一人称/无主语原文风格，不要改成第三人称。
  > 4. 输出只含改写结果，不要解释、不要前后缀客套话。

- 输出格式：润色类返回 Markdown 分隔的多个候选；诊断类返回严格 JSON Schema。
- prompt 改动纳入测试：对 `buildMessages` 做**快照测试**，防止手滑改坏。

### 4.4 事实性护栏（`js/ai/guard.js`）

对「建议文本 vs 原文」做对比，提取并比对四类实体：
- 数字与百分比（`\d+(\.\d+)?%?`、`\d+倍`、`\d+w`）— 原文无 → 标记
- 时间（`20\d{2}[.\-/年]`）— 原文无 → 标记
- 公司/组织名 — 与 `data` 中已知公司名比对，未知 → 标记
- 技术栈词 — 与「核心技能」板块比对，未知 → 标记（弱提示）

命中项在 Diff 卡片里以**虚线边框 + 灰底**标注「疑似新增，请核对」，不阻断应用。

### 4.5 成本与性能

- **缓存**：`js/ai/apply.js` 之外单独一层，按 `hash(scopeKey + action + model)` 存 localStorage，
  相同输入直接复用（润色经常反复重生成）。
- **用量统计**：服务端累计 token 与估算费用，写入 `data/ai-usage.json`（gitignore），面板底部灰字显示。
- **默认档位**：日常用 `deepseek-v4-flash`，「深度诊断」才切 `deepseek-v4-pro`，可手动覆盖。
- **超时与中断**：前端 `AbortController`，面板上「停止生成」；服务端同步 abort 上游。

---

## 五、UI 设计（严格黑/白/灰）

### 5.1 整体布局：默认两栏 + 右侧滑出

A4 预览需要固定宽度，三栏常开会太挤。因此：

```
┌──────────────────────────────────────────────────────────────┐
│ 工具栏  … | [ AI 助手 ⌘K ] | 打印 | 导出数据 | PDF 预览 …     │
├───────────────────────┬────────────────┬─────────────────────┤
│                       │                │  ← 360px，可折叠    │
│                       │                │ ┌─────────────────┐ │
│    简历实时预览        │   内容编辑面板   │ │ DeepSeek ▾   ⚙ │ │
│    （A4，自适应缩放）  │   （现有）       │ ├─────────────────┤ │
│                       │                │ │ 范围 · 项目A·描述│ │
│                       │                │ ├─────────────────┤ │
│                       │                │ │ 润色 量化 STAR  │ │
│                       │                │ │ 精简 翻译 诊断  │ │
│                       │                │ ├─────────────────┤ │
│                       │                │ │ 补充说明（可选）│ │
│                       │                │ ├─────────────────┤ │
│                       │                │ │ ▍流式输出区      │ │
│                       │                │ ├─────────────────┤ │
│                       │                │ │ Diff 卡片 ×N    │ │
│                       │                │ ├─────────────────┤ │
│                       │                │ │ 应用全部 · 丢弃  │ │
│                       │                │ └─────────────────┘ │
└───────────────────────┴────────────────┴─────────────────────┘
```

- 点「AI 助手」或按 `⌘K` 滑出，预览区自适应缩小（有 `min-width`，不足时整体缩放而非挤压）
- 面板宽度可拖拽，记忆到 localStorage
- 单文件版（`file://`）下 AI 面板顶部显示灰条提示：「AI 需要本地服务，运行 `npm start` 后可用」

### 5.2 黑白灰的层次手段（不能用颜色，靠这五样）

| 手段 | 用法 |
|---|---|
| **明度阶梯** | `#fff` 面 / `#f5f5f5` 次级底 / `#ebebeb` 输入框底 / `#d9d9d9` 描边 / `#999` 次要文字 / `#666` 正文 / `#1a1a1a` 强调 |
| **边框粗细** | 0.5px 常规分隔；1px 卡片描边；**2px 仅用于选中态与强调** |
| **字重** | 只用 400 / 500 两档（与项目现有排版一致） |
| **留白** | 区与区之间 24px，卡内元素 12px，靠间距分组而非分割线 |
| **动效** | 思考中用灰阶骨架条 + `▍` 光标闪烁（**代替彩色 spinner**） |

### 5.3 Diff 卡片规范

```
┌─────────────────────────────────────────────┐
│ 原文                                         │
│ 负责平台后端开发，提升了系统性能。              │  ← line-through + #999 + 灰底
├─────────────────────────────────────────────┤
│ 建议 1                              [应用]   │  ← 黑色 2px 左边框 + 白底
│ 主导平台后端重构，通过引入异步队列与缓存分层，  │
│ 将核心接口 P99 延迟从 800ms 降至 [待补充]ms。  │
│ ┌ 疑似新增数字，请核对 ─────────────────┐    │  ← 虚线边框 + 灰底
│ └──────────────────────────────────────┘    │
├─────────────────────────────────────────────┤
│ 建议 2                              [应用]   │
│ …                                            │
└─────────────────────────────────────────────┘
        [ 全部应用 ]   [ 重新生成 ]   [ 丢弃 ]
```

- 未变更文字保持默认样式，只对比差异片段（段/句级 diff，自实现 LCS，零依赖）
- 每张卡片右下角三个文字按钮，不用图标按钮（中文更易读）
- 「全部应用」= 一次 `recordHistory()` + 批量写入，可一次撤销

### 5.4 划词浮动工具栏

在预览区或编辑区选中文字后，浮出于选区上方：

```
     ┌──────────────────────────────────────┐
     │ 润色 │ 量化 │ 精简 │ STAR │ 翻译 │ ⋯ │
     └──────────────────────────────────────┘
              ▲ 选中的文字
```

- 白底、1px 灰边、4px 圆角、无阴影；按钮为纯文字，hover 时底色变 `#f5f5f5`
- 点击后：范围自动锁定为该片段，右侧 AI 面板展开并开始生成
- 若 AI 面板处于收起状态，自动展开

### 5.5 首次使用引导

未配置 Key 时，AI 面板显示空态卡片（灰底，无图标）：

```
AI 尚未接入

运行 npm start 打开本工具，并在项目根目录创建
ai.config.json（可从 ai.config.example.json 复制），
填入你的 DeepSeek API Key 后刷新页面。

你的 Key 只保存在本机，不会随仓库上传；
简历内容也只发往你配置的模型厂商。
```

### 5.6 快捷键

| 键 | 作用 |
|---|---|
| `⌘K` / `Ctrl+K` | 开关 AI 面板 |
| `⌘⇧K` / `Ctrl+Shift+K` | 对当前范围重新生成 |
| `Esc` | 停止生成 / 关闭浮动工具栏 |
| `⌘Enter` | 应用当前全部建议 |

---

## 六、数据模型

### 6.1 简历数据：不变

`{data, fonts, spacing, v}` 结构完全不动，AI 只在**字段值层面**读写，
不往 `data` 里塞任何 AI 元数据 —— 保证导出的 JSON 与旧版本完全兼容。

### 6.2 AI 配置：独立于简历，两处存放

**服务端 `ai.config.json`**（项目根，`.gitignore` 新增，含 Key）：

```json
{
  "provider": "deepseek",
  "baseURL": "https://api.deepseek.com",
  "apiKey": "sk-xxxx",
  "models": { "fast": "deepseek-v4-flash", "strong": "deepseek-v4-pro" },
  "temperature": 0.4,
  "timeoutMs": 60000
}
```

**浏览器 localStorage `resume_studio_ai_v1`**（UI 偏好，无 Key）：

```json
{ "panelOpen": true, "panelWidth": 360, "sanitize": false,
  "lastAction": "polish", "model": "fast" }
```

### 6.3 建议对象（运行时，内存 + localStorage 短历史）

```js
{
  id: 'sug_xxx',
  scopeKey: 's5/job0/proj2/desc',      // 定位到具体字段
  action: 'polish',
  original: '负责平台后端开发…',
  candidates: ['主导平台后端重构…', '…'],
  warnings: [{ type: 'number', text: '800ms', at: 34 }],
  model: 'deepseek-v4-flash',
  createdAt: 1756...
}
```

`scopeKey` 用 `/` 分隔的路径定位到具体字段，应用时由 `js/ai/apply.js` 解析并精确写回。

---

## 七、目录结构

```
resume-studio/
├── index.html                  # 改：追加 ai 相关 <script> 与 AI 面板容器
├── css/
│   ├── style.css               # 现有（不动）
│   └── ai.css                  # 新增：AI 面板 / Diff 卡片 / 划词工具栏
├── js/
│   ├── data.js                 # 现有（不动）
│   ├── app.js                  # 现有：仅新增 2 处钩子（见下）
│   └── ai/                     # 新增：全部 AI 能力
│       ├── presets.js          #   厂商预设表（baseURL / 模型名 / 单价 / 能力标记）
│       ├── provider.js         #   统一调用层 + SSE 解析 + 中断 + 重试
│       ├── prompts.js          #   所有 prompt 模板（集中管理，便于迭代与快照测试）
│       ├── scope.js            #   作用范围解析：selection / item / section / whole
│       ├── sanitize.js         #   脱敏与还原（姓名/手机/邮箱/公司名）
│       ├── guard.js            #   事实性护栏：数字 / 时间 / 公司 / 技术栈比对
│       ├── diff.js             #   段句级 diff（自实现 LCS，零依赖）
│       ├── apply.js            #   应用建议 → 写回 data → 接入 history
│       └── ui/
│           ├── panel.js        #     右侧 AI 面板（模式切换 / 流式区 / 操作条）
│           ├── selection.js    #     划词浮动工具栏
│           └── diffcard.js     #     Diff 卡片渲染与应用交互
├── tools/
│   ├── serve.js                # 改：注入 /api/ai/* 路由分发（其余原样）
│   ├── ai-proxy.js             # 新增：SSE 转发 + 配置读取 + 用量统计
│   ├── build-single.js         # 改：追加 js/ai/*.js 与 css/ai.css 的拼接
│   ├── migrate-legacy.js       # 现有（不动）
│   ├── render-resume.js        # 现有（不动）
│   └── save-data.js            # 现有（不动）
├── test/
│   ├── run.js                  # 改：加载列表追加 ai 文件
│   ├── cases.js                # 现有（不动）
│   └── ai.cases.js             # 新增：AI 纯逻辑用例
├── ai.config.example.json      # 新增：配置样板（入库）
├── ai.config.json              # 新增：真实配置（gitignore，含 Key）
├── data/                       # 现有（gitignore）
│   ├── resume.json
│   └── ai-usage.json           # 新增：累计用量（gitignore）
├── docs/
│   ├── AI辅助写简历-技术设计方案.md               # 本文档
│   └── AI.md                   # 用户向：AI 配置与使用说明
└── 其余（README / CHANGELOG / ROADMAP / CONTRIBUTING / LICENSE）相应更新
```

### 对现有文件的三处最小侵入

1. **`index.html`**：在 `app.js` 之后按序引入 9 个 ai 脚本；追加 AI 面板容器与划词工具栏容器；
   工具栏加「AI 助手」按钮。
2. **`js/app.js`**：只加两个钩子 ——
   - `window.ResumeEditor.getScopeFromEvent(e)` —— 让 AI 侧能拿到当前选区对应的 `scopeKey`
   - `window.ResumeEditor.applyFieldChange(scopeKey, newValue)` —— 内部复用现有 `recordHistory()` 与渲染
   - *不改动任何现有函数体。*
3. **`tools/serve.js`**：顶部加三行路由分发到 `ai-proxy.js`，其余原样。

---

## 八、测试策略

延续「纯 Node、零依赖」传统：

| 层 | 方式 | 覆盖 |
|---|---|---|
| 纯逻辑 | `node:test` 直接 import `js/ai/*.js` | `diff` / `apply` / `guard` / `sanitize` / `scope` |
| Prompt | 快照测试 | `buildMessages()` 输出结构不漂移 |
| Provider | 注入 mock `fetch`，喂预制 SSE 流 | 流式解析、中断、错误码映射 |
| 现有回归 | `test/run.js` 的 vm 桩继续跑 | 确保 AI 接入没碰坏原有 38 条断言 |
| 构建 | `npm run build` 后校验产物含 ai 代码 | 单文件版完整性 |

**不测**真实网络调用（CI 无 Key）。连通性由 `/api/ai/test` 在用户本机验证。

---

## 九、隐私与安全

| 风险 | 处置 |
|---|---|
| API Key 外泄 | Key 只存 `ai.config.json`，`.gitignore` 隔离；**永不进入浏览器、永不进仓库** |
| 简历内容外传 | 请求只带当前 scope 切片，不带全文（全文类操作可开脱敏） |
| 脱敏 | `sanitize.js` 把姓名/手机/邮箱/公司名替换为 `[NAME]` 等占位符，返回后按映射表还原 |
| 服务暴露 | `serve.js` 只监听 `127.0.0.1`（**本次一并加固**，现状是监听所有网卡） |
| 路径穿越 | 现有防护保留；`/api/ai/*` 不读用户路径，无新增面 |
| 依赖风险 | 零依赖，无供应链风险 |

> 附带发现（**与 AI 无关，当前代码就存在的问题**）：现有 `tools/serve.js` 的 `server.listen(PORT)` 未指定 host，
> 会监听 `0.0.0.0`，同网段他人可访问并读取 `data/resume.json`。
> 建议改为 `server.listen(PORT, '127.0.0.1')` —— 一行改动、不影响任何既有用法，
> **不必等 AI 改造，随时可独立修**，已单列进 [ROADMAP.md](../../ROADMAP.md) 高优先级。

---

## 十、规划路线（⏸ 暂不实施，仅作排期参考）

> 下表是**将来**真要动手时的建议拆分，工期为粗略预估，当前不排期。
> 唯一例外是第九节提到的 `serve.js` 监听地址加固 —— 那是当前代码就存在的安全问题，
> 建议独立于本方案、随时可做（三行改动），已在 [ROADMAP.md](../../ROADMAP.md) 单列。

| 阶段 | 工期 | 内容 | 产出 |
|---|---|---|---|
| **1 基建** | ~1 天 | `ai-proxy.js` + `ai.config.json` + `/api/ai/status|test` + build/test 适配 + serve 监听加固 | 能测通 DeepSeek |
| **2 核心闭环** | ~2 天 | `panel` + `scope` + `prompts` + `provider` + `diff` + `apply` | 跑通「选中 → 润色 → Diff → 应用 → 撤销」 |
| **3 场景扩展** | ~2 天 | JD 诊断、素材生成、全文体检、划词工具栏、中英互译 | P0 + 部分 P1 全部可用 |
| **4 打磨** | ~1 天 | 脱敏、护栏、缓存、用量、快捷键、空态引导、文档 | 可日常使用 |

每一阶段结束都保持 `npm test` 与 `npm run build` 通过，随时可停。

---

## 十一、待定问题

1. **单文件版的 AI 怎么办？** 三个选项：
   - (a) 单文件版直接禁用 AI，提示用 `npm start`（最省事，推荐）
   - (b) 允许在单文件版里填 baseURL + Key 直连，仅对支持 CORS 的自建网关有效
   - (c) 打包一个极小的本地服务随单文件版分发
   → 建议 **(a) 先做，(b) 作为高级选项留在设置里**。

2. **Temperature 默认 0.4 是否合适？** 简历改写要稳，但太低会千篇一律。
   建议润色 0.4、诊断 0.2、生成 0.6，先在阶段 2 实测后定。

3. **诊断结果要不要落盘？** 目前设计是内存 + localStorage 短历史。
   若要跨会话保留，需新建 `data/ai-history.json`（gitignore）。
