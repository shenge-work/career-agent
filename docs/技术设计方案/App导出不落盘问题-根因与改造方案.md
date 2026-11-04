> ⚠️ **v1 已退役文档 · 仅供历史参考**
> 本文描述的是 v1 时代（零后端单文件 / Tauri 桌面·安卓壳 / 飞书同步 / CI 三平台发版）的方案。
> v2 已于 2026-11-04 重构为「本地服务器 + 账号行级隔离 + NestJS/React/PGlite」并退役上述能力，项目更名为 **CareerAgent**。
> 当前架构与定位以 `docs/重设计构思-个人求职Agent工作台.md` 与 `docs/需求文档/00-产品定位与评审标尺.md` 为准。

# 打包成 App 后「导出」不落盘 —— 根因、实测证据与改造方案

> **状态**：调研完成（证据已实证），**待实施**
> **阻塞**：`js/app.js` 正被「多份简历库」那条线改动中；需等其合并后再动前端
> **首次记录**：2026-09-19

---

## 1. 结论（TL;DR）

打包成桌面 App / 安卓 App 后，**点「导出 PDF / 长图 / 单文件 HTML / 数据 JSON」不会产生任何文件**。
更糟的是，点 PDF 导出会把**整个编辑器界面顶掉**（WebView 导航到了 blob URL）。

原因：导出全部走浏览器时代的 `Blob` + `<a download>` 套路，而 macOS 底层 WKWebView
**不支持 `blob:` URL 配 `download` 属性**（WebKit bug 216918，2020 年至今未修）。

**唯一可行解**：改用**原生保存命令** —— Rust 侧提供「弹系统保存对话框 + 写盘」的命令，
前端在检测到原生壳时改调它，浏览器路径保持不变。

---

## 2. 影响面

`js/app.js` 里真正落盘的只有 **3 个函数**（长图与单文件 HTML 走同一个通用下载入口）：

| # | 函数 | 行号（2026-09-19 时点） | 导出内容 | 现状 |
|---|---|---|---|---|
| 1 | `downloadPDFNow()` | ~949 | PDF 预览弹层里的「下载」 | ❌ 不落盘 + **顶掉界面** |
| 2 | `doExportDownload()` | ~985 | 长图 PNG / 单文件 HTML 的「下载」 | ❌ 不落盘 |
| 3 | `exportJSON()` | ~1429 | 数据 JSON | ❌ 不落盘 |

另有 2 处 `URL.createObjectURL()`（`exportLongImage()` ~1009、`exportSingleFileHTML()` ~1055）
只用于**弹层预览**（`<img src>` / `<iframe src>`），**预计不受影响**（blob: 的读取本身是支持的，
坏的是「靠 download 属性落盘」）。但预览路径**尚未实证**，列入验收项。

浏览器（`npm start` / 单文件 HTML 双击）**完全不受影响**，无需改动。

### 2.1 附带：桌面 App 里 PDF 导出的**三条路全是死的**

这一条单独拎出来，因为它比「不落盘」更彻底：

| 路径 | 代码位置 | 在桌面 App 里的实际行为 |
|---|---|---|
| ① 静默 PDF | `js/export-extra.js:415` `exportPdfSilent()` → `fetch('/api/pdf')` | ❌ App 里**没有 Node 服务**，`/api/pdf` 是 `tauri://localhost/api/pdf`，必然失败 |
| ② 兜底打印 | 同上，失败后 `global.print()` | ❌ **WKWebView 里 `window.print()` 是静默空操作**（见 §3.4 实测） |
| ③ PDF 预览下载 | `js/app.js:949` `downloadPDFNow()` | ❌ 不落盘，且把界面顶掉（见 §3.2） |

⇒ 桌面端**目前没有任何一条能拿到 PDF 的路**。修 ② 的成本很低（见 §5.1 的 `print_page`），
建议与 ③ 一并做掉。

---

## 3. 实测证据

### 3.1 方法

写了一个最小复现程序，用**与 App 相同的自定义协议** `tauri://localhost` 承载页面
（WKWebView 需自行 `setURLSchemeHandler`，实测 `WKWebView.handlesURLScheme("tauri")` 为 `false`），
页面里造一个二进制 PDF 负载 → 挂 `<a download="简历_测试.pdf">` → `click()`，
观察「目标目录是否出现文件」+「WebView 是否被导航走」。

程序：`/tmp/wkblob-test/main.swift`（临时验证物，不入库）

### 3.2 结果：四种组合**全部失败**

| 模式 | 方案 | 文件落盘 | 页面是否被顶掉 | 说明 |
|---|---|---|---|---|
| **A** | `blob:` + 无下载处理器 | ❌ 0 个 | ❌ 被导航走 | **= 当前仓库的真实状态** |
| **B** | `blob:` + 有下载处理器 | ❌ 0 个 | ❌ 被导航走 | 等价于给 Tauri 加 `on_download` |
| **C** | `data:` + 无下载处理器 | ❌ 0 个 | ✅ 活着 | 报 `Frame load interrupted` |
| **D** | `data:` + 有下载处理器 | ❌ 0 个 | ✅ 活着 | 同 C |

关键原始输出（模式 A）：

```
[导航] didFinish url=tauri://localhost/index.html
[导航] didFinish url=blob:tauri://localhost/2ff5c0a3-fead-4ce0-b460-0b249397a304
WebView 当前 url : blob:tauri://localhost/2ff5c0a3-...
页面 #r 状态     : <#r 不存在=页面已被替换>
落盘文件数       : 0  []
```

模式 B（**关键否定证据**）：注册了 `WKDownloadDelegate` 后，
`navigationAction:didBecome download` / `navigationResponse:didBecome download`
**从未被调用** —— 连日志都没打出来。说明 WebKit 压根没把它当下载处理。

> **附带收获**：`data:` URL（模式 C/D）虽然同样不落盘，但**页面不会被顶掉**。
> 所以「先别再顶掉界面」有一个零成本的缓解手段；但正式修法仍应走原生命令。

### 3.3 源码级证据链

| 环节 | 证据 |
|---|---|
| WebKit 限制 | WebKit bug **216918**：WKWebView 不支持 `blob:` URL + `download` 属性（`data:` 例外，但实测见上） |
| wry 侧 | `wry-0.55.1/src/wkwebview/mod.rs:572` —— `download_delegate` **只在传入了下载处理器时才创建** |
| Tauri 侧 | `tauri-2.11.5` 与 `tauri-runtime-wry` 中**完全没有** `on_download` / `DownloadEvent` / `download_started_handler` |
| 本项目 | `src-tauri/src/` 内无任何下载相关代码 |

⇒ 三层串起来：**没有处理器 → 不创建下载委托 → 当普通导航处理 → 页面被 blob 顶掉且不落盘。**

### 3.4 补充实测：`window.print()` 在 WKWebView 里是静默空操作

同样用最小复现程序（模式 P），在页面里直接调 `window.print()`，并检查窗口上有没有挂打印面板 sheet：

```
页面 #r 状态     : window.print() 已调用且未抛异常
打印面板探针     : attachedSheet=无 sheet；NSApp.modalWindow=无 modal 窗口
判定：❌ window.print() 不可用
```

**不抛异常、不报错、也不弹面板** —— 纯粹的静默失败。这正是「静默 PDF 失败后回退打印」
这条路在桌面 App 里也走不通的原因（见 §2.1）。

好消息：`tauri-2.11.5` 提供了原生打印 API，可以直接救回来（见 §5.1）。

| 位置 | API |
|---|---|
| `tauri-2.11.5/src/webview/mod.rs:1485` | `Webview::print()` |
| `tauri-2.11.5/src/webview/webview_window.rs:2306` | `WebviewWindow::print()` |
| `wry-0.55.1/src/wkwebview/mod.rs:858` | 底层实现（macOS 走 `printOperationWithPrintInfo:`）|

---

## 4. 为什么不选「给 Tauri 加 `on_download`」

实测模式 B 已经否掉了：即便把下载处理器接上，WebKit 对 `blob:` 也不走下载分支。
`on_download` 只对**真实网络请求**（`http(s)://` 响应带 `Content-Disposition`）有意义。
本场景的文件全在内存里，没有网络请求可拦。

---

## 5. 方案：自建 `save_file` 命令 + 前端分流

### 5.1 Rust 侧

新增 `src-tauri/src/export.rs`，注册一个命令（签名示意，**具体 API 名以装上插件后的版本为准**）：

```rust
#[tauri::command]
async fn save_file(
    app: tauri::AppHandle,
    file_name: String,     // 建议文件名（含中文）
    bytes_b64: String,     // 文件内容，base64（前端已能算，见 native-bridge.js 的 bytesToBase64）
) -> Result<Option<String>, String> {
    // 1) base64 解码
    // 2) app.dialog().file().set_file_name(&file_name).save_file(...) 弹保存对话框
    // 3) 用户选定路径 → std::fs::write
    // 4) 返回 Some(路径)；用户取消 → Ok(None)（前端静默，不报错）
}
```

在 `src-tauri/src/lib.rs` 的 `generate_handler!` 里追加 `export::save_file`。

**依赖变更**：

```toml
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"     # 新增
```

`lib.rs` 里 `.plugin(tauri_plugin_dialog::init())`。

#### 5.1.1 顺手修掉「打印兜底」：再加一个 `print_page` 命令

因为 `window.print()` 在 WKWebView 里是空操作（§3.4），而 `tauri::Webview::print()` 可用：

```rust
#[tauri::command]
fn print_page(webview: tauri::Webview) -> Result<(), String> {
    webview.print().map_err(|e| e.to_string())
}
```

前端在静默 PDF 失败时，原生壳改调 `print_page`，浏览器仍走 `window.print()`：

```js
const fallback = function (msg) {
  notify(msg + '，已回退到打印对话框');
  const N = window.__RESUME_NATIVE__;
  if (N && N.printPage) { N.printPage(); return; }   // 原生壳
  try { if (global.print) global.print(); } catch (e) { }   // 浏览器
};
```

> **这条路之所以可行，关键在于「自建命令不受 ACL 拦」**（§5.2）——
> 我们把 `webview.print()` 包进自己的命令里，就绕开了核心 API 的权限要求，不必新建 capabilities。
> 若反过来试图从 JS 直接调核心的 `plugin:webview|print`，就必须处理 ACL。

### 5.2 ⚠️ ACL / capabilities —— 实施时最容易卡住的一步

**本项目目前没有 `src-tauri/capabilities/` 目录，也从不使用任何官方插件。**
这能工作是因为读到 tauri 2.11.5 源码 `src/webview/mod.rs:1820`：

```rust
// Check ACL on plugin commands, when the app defined its ACL manifest,
// or when the request comes from a non-local (remote) origin.
if (plugin_command.is_some() || has_app_acl_manifest || !is_local)
   && ... && invoke.acl.is_none()
{
    reject(format!("Command {} not allowed by ACL", request.cmd));
    return;
}
```

拆开看：

| 命令类型 | 本地 origin | 是否受 ACL 拦 |
|---|---|---|
| **自建命令**（无 `plugin:` 前缀） | 是 | ❌ 不拦 —— 所以现有 7 个飞书命令无需 capabilities |
| **自建命令** | 是，但 `build.rs` 声明了 app manifest | ✅ 拦（本项目 `build.rs` 只有 `tauri_build::build()`，**没有**声明） |
| **插件命令**（带 `plugin:` 前缀） | 是 | ✅ **必拦** —— 加 dialog 插件后没授权就是 `not allowed by ACL` |

⇒ **加 `tauri-plugin-dialog` 必须同时新建 `src-tauri/capabilities/default.json`**，
至少给 `dialog:allow-save`（或许还需 `core:default`）。而自建的 `save_file` 命令**不必**登记。
`capabilities/` 目录是自动加载的，无需在 `tauri.conf.json` 里引用。

### 5.3 前端侧（3 处落盘点）

桥（`js/store/native-bridge.js`）里加一个方法，风格与现有 6 个方法一致：

```js
saveFile: function (defaultName, bytes) {
  if (!TAURI) return Promise.reject(new Error('非原生环境'));
  return invoke('save_file', { fileName: defaultName, bytesB64: bytesToBase64(bytes) });
}
```

三个落盘函数统一改成「先问原生、原生不在才走浏览器」：

```js
async function downloadBlob(blob, filename) {
  const N = window.__RESUME_NATIVE__;
  if (N && typeof N.saveFile === 'function') {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const saved = await N.saveFile(filename, bytes);
    if (saved) showAutosave('已保存到 ' + saved);   // 复用现有提示
    return;                                          // 原生路径到此结束
  }
  /* 浏览器路径：原样不动 */
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
```

**注意**：`downloadPDFNow()` 与 `doExportDownload()` 手里只有 **blob URL**（`currentPdfBlobUrl` /
`currentExportBlobUrl`），**没有 Blob 对象**。修法二选一：

- **推荐**：在 `exportPDF()` / `showExportModal()` 里把 Blob 也存一份（新增 `currentPdfBlob` /
  `currentExportBlob`），改动最小且没有解析开销。
- 备选：`await fetch(blobUrl).then(r => r.arrayBuffer())` 从 blob URL 反解字节。
  少存两个变量，但多一次拷贝，且**在自定义协议 origin 下是否总是可用未经验证**。

### 5.4 三端差异（**如实标注：桌面端已验证，移动端未验证**）

| 平台 | 保存对话框 | 写盘 | 状态 |
|---|---|---|---|
| macOS | 原生 NSSavePanel（dialog 插件内部处理） | `std::fs::write` 普通路径 | 方案成立，待实施验证 |
| Windows / Linux | 原生对话框 | 同上 | 同上 |
| **Android** | SAF（`ACTION_CREATE_DOCUMENT`） | ⚠️ **返回的是 `content://` URI，`std::fs::write` 写不了** | ⚠️ **不可照搬**，需另行设计 |

**建议分期**：一期只覆盖桌面三端；Android 的导出路径（SAF 写入 / 存到应用私有目录 + 分享 intent）
单独立项，**不要**在一期里顺手做，否则很容易做出「看着能跑、真机写不进去」的假成功。

---

## 6. 验收标准（AC）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC1 | 桌面 App 里点「导出 PDF → 下载」能弹出系统保存对话框 | 手动，三端 |
| AC2 | 选定路径后文件真的出现且能被 PDF 阅读器打开 | `ls` + 打开文件 |
| AC3 | **界面不会被顶掉**（点导出后编辑器仍可用） | 手动 |
| AC4 | 文件名含中文不乱码 | 手动 |
| AC5 | 取消对话框时不报错、不产生文件、界面无异常 | 手动 |
| AC6 | 长图 PNG / 单文件 HTML / 数据 JSON 三条都通 | 手动 |
| AC7 | 弹层**预览**（`<img>` / `<iframe>` 用 blob URL）仍正常显示 | 手动 —— **本方案未覆盖，需单独确认** |
| AC8 | **浏览器路径零回归**：`npm start` 下导出行为与改造前完全一致 | `npm test` + 手动 |
| AC9 | 自动化测试仍全绿 | `npm test`（当前基线 203/203） |
| AC10 | 桌面 App 里静默 PDF 失败后，**能弹出系统打印面板**（而不是静默无反应） | 手动，三端 |

---

## 7. 复现与回归

最小复现程序保留在 `/tmp/wkblob-test/`（**临时验证物，不入库**）：

```bash
cd /tmp/wkblob-test
swiftc -O -swift-version 5 main.swift -o wkblob-test
./wkblob-test A "简历_测试.pdf"    # 复现当前问题：不落盘 + 界面被顶掉
./wkblob-test B "简历_测试.pdf"    # 证明给 Tauri 加 on_download 无效
./wkblob-test C "简历_测试.pdf"    # 证明 data: 方案也不落盘
./wkblob-test D "简历_测试.pdf"    # data: + 下载处理器，同样不落盘
./wkblob-test P                    # 证明 window.print() 是静默空操作
```

若日后要长期保留，应移入仓库（如 `tools/wkwebview-export-test/`）并加一段 README 说明用途。
