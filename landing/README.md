# CareerAgent · 静态引流主页

CareerAgent 的官方落地页（Landing Page）。**纯静态**（HTML + CSS + JS），无构建步骤、无外部运行时依赖，可直接被 GitHub Pages 托管，也能部署到任意静态托管平台。

> 一句话定位：**让 AI 替你搞定求职杂活（投递、调研、改简历），你只专注自身专业能力提升与面试训练。**

---

## 目录结构

```
landing/
├── index.html      # 单页主页（所有内容）
├── css/
│   └── style.css   # 样式
├── js/
│   └── main.js     # 交互 + 下载埋点钩子 + 下载链接集中配置
├── assets/         # 预留：可放 og-cover.png 等静态资源（当前为空，可自行创建）
└── README.md       # 本说明
```

---

## 本地预览

任选其一：

**方式一：直接打开**
双击 `index.html` 即可在浏览器中打开（所有功能均不依赖网络）。

**方式二：本地静态服务器（推荐，避免个别浏览器 file:// 限制）**

```bash
# Python 3
cd landing
python -m http.server 8080
# 打开 http://localhost:8080

# 或使用 Node
npx serve .
```

---

## 托管到 GitHub Pages

本主页对应仓库 `shenge-work/career-agent`。

1. 把 `landing/` 目录下的所有文件推到仓库（可直接作为仓库根，或放到 `docs/` 目录）。
2. 在 GitHub 仓库 **Settings → Pages** 中：
   - **Source** 选择 `Deploy from a branch`
   - **Branch** 选择对应分支，目录选 `/ (root)` 或 `/docs`
3. 保存后，访问 `https://shenge-work.github.io/career-agent/` 即可。

---

## 发布前必改：替换下载链接占位

下载按钮当前指向：

```
https://github.com/shenge-work/career-agent/releases/latest
```

已配置为真实仓库 `shenge-work/career-agent`，可直接使用。需要精确到具体资源文件时，改两处（建议保持一致）：

| 位置 | 文件 | 说明 |
| --- | --- | --- |
| HTML 中下载按钮的 `href` | `index.html` | 共 4 个下载按钮（Hero 2 个 + 下载区 2 个） |
| JS 集中配置 `CONFIG.download` | `js/main.js` | **单一数据源**，页面加载时会自动覆盖 HTML 里的占位 href |

修改 `js/main.js` 顶部：

```js
var CONFIG = {
  repo: {
    owner: 'shenge-work',
    name: 'career-agent'
  },
  download: {
    windows: 'https://github.com/shenge-work/career-agent/releases/latest',
    macos: 'https://github.com/shenge-work/career-agent/releases/latest'
  }
};
```

发布正式安装包后，建议把地址精确到资源文件：

```js
windows: 'https://github.com/shenge-work/career-agent/releases/latest/download/CareerAgent-Setup.exe',
macos:   'https://github.com/shenge-work/career-agent/releases/latest/download/CareerAgent.dmg',
```

---

## 启用访问统计（Umami）

`index.html` 的 `<head>` 里已预留一段**被注释掉的** Umami 脚本。启用步骤：

1. 到 [umami.is](https://umami.is) 注册并添加一个站点，拿到 `data-website-id`。
2. 打开 `index.html`，找到「Umami 访问统计（预留）」注释块。
3. 取消下面这段 `<script>` 的注释：

```html
<script defer
  src="https://cloud.umami.is/script.js"
  data-website-id="YOUR_WEBSITE_ID"
  data-domains="shenge-work.github.io"></script>
```

4. 把 `data-website-id` 换成你的站点 ID，`data-domains` 换成你的站点域名（自托管 Umami 时把 `src` 也换成你的实例地址）。

### 下载埋点说明

每个下载按钮都已带好事件属性，Umami 会自动采集：

```html
data-umami-event="download"
data-umami-event-platform="windows"   <!-- 或 "macos" -->
```

- 在 Umami 后台可用 **事件 → download** 看总下载次数；
- 用 **platform** 维度可做 Windows / macOS 漏斗拆分。

> 即使暂不启用 Umami，这些属性也不影响页面，可放心保留。`js/main.js` 中另有一层 `window.umami.track` 兜底，仅在 Umami 已加载时生效。

---

## SEO 与社交分享

`index.html` 已内置 `title`、`description`、`keywords`、`canonical`、Open Graph 与 Twitter Card 标签，并已指向 `shenge-work.github.io/career-agent/`。

- `https://shenge-work.github.io/career-agent/`（canonical / og:url）
- `https://shenge-work.github.io/career-agent/assets/og-cover.png`（og:image / twitter:image）

建议准备一张 1200×630 的封面图放到 `assets/og-cover.png`。

---

## 技术说明

- **零外部依赖**：未引用任何 CDN 的 JS/CSS 框架，图标全部为内联 SVG，国内/离线均可正常访问。
- **响应式**：桌面双栏 / 移动端单栏，移动端下载按钮全宽。
- **字体**：使用系统字体栈（PingFang SC / Microsoft YaHei / Segoe UI 等），无需加载网络字体。

## License

依据 [MIT License](https://opensource.org/license/mit) 开源。
