# 浏览器自动化实战要点与踩坑记录

本文档沉淀本次快手投递实战中，用浏览器工具（`mcp__browser__*`）操作招聘表单的经验，供以后复用。

## 一、浏览器选择与接管

1. `browsers_list` 返回可用浏览器：`WorkBuddy Browser`（内置，type=desktop）和 `Google Chrome`（扩展，type=extension）。
2. 用户说「谷歌浏览器里有选好的岗位」→ 用 `user_open_tabs` 列出 Chrome 已开标签，找到投递页后用 `tabs_claim` 接管（claim 成功前不可操作）。
3. 快手投递页 URL 形如 `.../job-apply/{岗位ID}?token=...`，社招列表 URL 带 `keyword=...&workLocationCode=...&positionCategoryCode=...`。

## 二、DOM 操作铁律

1. **node_id 只在当前快照有效**：每次 `dom_cua_click` 或 `dom_cua_type` 后，DOM 会更新，node_id 失效（报 `stale`），必须重新 `dom_cua_get_visible_dom`。
2. **先 click 聚焦，再 type 输入**：`dom_cua_type` 是「向聚焦元素插入文字」，不指定目标元素。流程固定为 `dom_cua_click(node_id)` → `dom_cua_type(text)`。
3. **清空重填**：`cua_keypress` 发 `Control+a`（全选，注意不是 `ctrl+a`，是 `Control+a`）→ `Backspace` → `dom_cua_type`。`meta+a` 和 `ctrl+a` 都报 `unsupported key`。
4. **DOM 快照有元素上限**（约 200 元素 / 20000 字符）：长表单下方字段可能不在快照里，需要滚动后再取快照。

## 三、滚动（重要踩坑）

快手的表单是 **SPA 内部滚动容器**，滚动行为诡异：

- `cua_scroll`（scroll_y 参数）：时灵时不灵，偶尔 `provider invocation timed out`。
- `cua_execute` 的 `scroll` action（type=scroll）：增量滚动，**最可靠**，但偶尔也超时。
- `cua_keypress` 的 `PageDown`/`PageUp`/`Home`：能滚，但 `Home` 有时被 SPA 拦截回不到顶。
- `cua_scroll` 工具和 `cua_execute scroll` 是两个不同工具，参数结构不同，别混用。

**结论**：优先用 `cua_keypress` 的 `PageDown`/`PageUp` 分页滚动，配合 `tab_screenshot` 确认实际位置，再 `dom_cua_get_visible_dom` 取字段。

## 四、日期选择器（最难，尽量避开）

快手的日期是 readonly 的日期选择器，双月面板：

- 点击日期字段弹面板 → 点「选择年份」→ 点目标年份 → 点「选择月份」→ 点目标月份 → 坐标点击具体日期。
- 日期数字在 DOM 里合并成一个 div 文本（如 `node_id=21` 的 `2023年7月一二三四五六日2627282930...`），**不是独立可点击节点**，必须用坐标点击。
- **坐标点击极易失败**：`tab_screenshot` 的截图坐标与 `cua_click` 坐标体系可能有偏移，多次点不中，且点偏会关闭面板。
- 本次实测：反复尝试坐标点击日期，最终偶然成功填上了 `2023-07-01 ~ 2023-07-08`（虽不精确但可用）。

**策略**：
- 非必填日期若简历信息模糊，**留空**，在职责描述里说明（如「仅工作两周」）。
- 必须填日期时，用「年份→月份」按钮导航到目标年月后，再小心坐标点击，点完立即截图确认。
- 未来可考虑：找到日期 input 的底层 value 直接用 JS 赋值（需页面支持），或换用 DOM 事件触发。

## 五、验证与核对

1. 每填一个字段，`dom_cua_get_visible_dom` 看 value 是否更新。
2. 填完一个条目，`tab_screenshot` + ViewImage 核对（OCR 可能误读，以 DOM value 为准）。
3. **node_id 会因滚动错位**：滚动后同一字段的 node_id 会变，务必用当前快照的 node_id，别凭记忆用旧 node_id（本次曾因此把业绩填到错误条目）。

## 六、提交红线

- 「投递/提交」按钮是真实提交，填完后**必须让用户确认**再点，用 AskUserQuestion 让用户选「自查 / 投递 / 补作品再投」。
- 本次用户选择「先自查」，故保留填写状态，未点投递。
