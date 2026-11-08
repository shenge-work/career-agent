---
name: job-apply-automation
description: 根据候选人简历，自动完成招聘官网（BOSS 直聘/快手/拉勾等）的岗位投递全流程：解析简历结构化字段 → 打开指定官网筛选匹配岗位 → 上传简历 → 自动填写申请表单 → 投递（需用户确认）。Use when the user asks to 自动投递 / 一键投递 / 帮我投递简历 / auto-apply / 自动填表单投递, or provides a resume + a job-board URL and wants the application form filled automatically.
name_cn: 简历自动投递
description_cn: 读取候选人简历，自动在招聘官网筛选岗位、上传简历、逐字段填写申请表单，完成投递（最终提交需用户确认）。
---

# 简历自动投递（job-apply-automation）

把一份候选人简历自动投递到招聘官网的指定岗位。核心价值：把「解析简历 → 打开官网 → 上传简历 → 填表单 → 投递」这条重复劳动固化为可复用 SOP，让用户以后只需提供简历 + 官网链接即可一键投递。

## 前置条件

- 一份可解析的简历（PDF/Word/Markdown，或资料库 drive 节点链接）
- 目标官网（快手 zhaopin.kuaishou.cn / BOSS 直聘 / 拉勾 / 猎聘等）的登录态已就绪（用 WorkBuddy 内置浏览器或已装扩展的 Chrome）
- 明确的目标岗位（用户选中，或需要按 JD 关键词筛选）

## 资产总览

- `references/resume-field-mapping.md` — 简历字段 → 通用申请表单字段的映射规范（含快手实测字段名）
- `references/browser-playbook.md` — 浏览器自动化实战要点与踩坑记录（滚动/日期选择/DOM 快照/坐标点击）
- `scripts/parse_resume.py` — （可选）简历文本结构化辅助脚本

## 工作流程

### Step 1 · 解析简历为结构化字段

1. 拿到简历文件。若用户给的是资料库 `/space/d/{id}` 链接，先用 library 技能 `node-info` 确认 `kind=drive`，再 `get_download_link.py` 下载 PDF。
2. 用 workbuddy-pdf 提取全文（`-f md`），整理出结构化字段：

```
基本信息：姓名 / 电话 / 邮箱 / 意向地点
工作经历：[{公司, 职位, 开始日期, 结束日期, 职责描述, 工作业绩}]  (倒序)
项目经历：[{名称, 角色, 开始日期, 结束日期, 描述, 职责}]
教育经历：{学校, 学历, 专业, 开始日期, 结束日期}
自我评价：一句话/一段话
作品：GitHub / 作品集链接
```

3. 关键：**先完整梳理字段，再动手填**。把字段映射写进本地工作底稿（如 `/tmp/<job>-form-data.md`），边填边对照，避免遗漏或填错条目。

### Step 2 · 打开官网并确认岗位

1. 用浏览器工具 `browsers_list` 获取可用浏览器；用户提到「谷歌浏览器里已选好岗位」时，优先用 `user_open_tabs` 找已打开的投递页，`tabs_claim` 接管。
2. 确认岗位信息（岗位名/岗位 ID），避免投错。

### Step 3 · 上传简历 + 摸清表单

1. 若附件简历未上传，用「上传简历」按钮上传 PDF。
2. 上传后系统通常会自动解析一部分字段（公司名/职位/日期可能解析出，但**职责/业绩/项目名称/角色/职责通常留空**，且可能有 OCR 错别字）。
3. 用 `dom_cua_get_visible_dom` + `tab_screenshot` 逐区块摸清表单字段。**DOM 快照的 node_id 只在当前快照有效，每次输入后要重新 `get_visible_dom`**。

### Step 4 · 逐字段填写（核心）

遵循 `references/browser-playbook.md` 的操作要点：

1. **填写空字段**（职责/业绩/项目名称/角色/职责）：先 `dom_cua_click` 聚焦 → `dom_cua_type` 输入文字。
2. **修正 OCR 错误**（公司名/职位）：`dom_cua_click` 聚焦 → `cua_keypress` 发 `Control+a` 全选 → `Backspace` 清空 → `dom_cua_type` 输入正确值。
3. **每填一个字段后重新读取 DOM 验证**，确认 value 已更新，再填下一个。
4. 日期字段是 readonly 选择器，操作繁琐且坐标点击易失败——**非必填日期若简历信息模糊，可留空并在职责里说明**（本次丰速「仅工作两周」即留空）。
5. 极短经历（如两周）的工作业绩留空更诚实，不要编造量化数据。

### Step 5 · 投递确认（铁律）

**最终「投递」按钮是真实提交，必须让用户明确确认后再点击**，绝不擅自提交。填完后向用户汇报填写汇总，用 AskUserQuestion 让用户选择「自查 / 点击投递 / 补作品再投」。

## 安全红线

- 未经用户明确授权，不点击「投递/提交」等真实提交按钮。
- 不编造简历内容：只排版填充，缺失业绩留空，缺失板块删除。
- 不暴露 Cookie/令牌/密码；不绕过网站访问限制。
- 遵守网站反爬与确认要求。

## 可扩展方向（后续）

- 多官网适配：各招聘站表单字段差异大，按官网维护字段映射（见 `references/resume-field-mapping.md` 的扩展位）。
- 岗位匹配：结合 JD 关键词做简历派生（项目内已有 JD 匹配派生能力）。
- 接入 Agent 基座：把本 SOP 挂到 agent 工作流，实现后台全流程自动化（详见落地方案文档）。
