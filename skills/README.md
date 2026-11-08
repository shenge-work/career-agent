---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'a90c99fd-edf0-4006-8910-adf81bb8800c'
  PropagateID: 'a90c99fd-edf0-4006-8910-adf81bb8800c'
  ReservedCode1: '5f044bf9-9621-4515-bfa8-abd176a2cf48'
  ReservedCode2: '5f044bf9-9621-4515-bfa8-abd176a2cf48'
---

# Skills 目录

本目录存放可供 TeleAgent 及其他 AI Agent 使用的技能（Skill）。每个技能是一个自包含的子目录，包含技能定义（SKILL.md）、参考文档、模板资产和辅助脚本。

## 可用技能

### portfolio-website-generator — 求职作品集网站生成器

从用户简历生成「新粗野主义 × 潮流杂志 × 人才档案系统」风格的单页求职作品集网站。

- **输入**：简历文件（PDF / JSON / 纯文本）或简历文字描述
- **输出**：纯静态 HTML/CSS/JS 网站 + AI 生成图片，双击 `index.html` 即可运行
- **风格**：新粗野主义扁平插画 + 米白底色 + 亮橙蓝强调色 + 档案卡/条形码/故障动画等签名元素
- **板块**：首屏 hero、关于我、求职意向、教育经历、实习经历、项目作品、专业技能、获奖证书、联系方式、简历下载页

#### 目录结构

```
portfolio-website-generator/
├── SKILL.md                      # 技能定义与工作流程（Agent 首要入口）
├── assets/
│   └── template/                 # 完整参考实现（虚构人物"江屿"的示例数据）
│       ├── index.html            # 主站页面（10 板块）
│       ├── resume.html           # 独立简历页（可打印为 PDF）
│       ├── css/style.css         # 全部样式（1390 行，含响应式 + 打印 + 无障碍）
│       ├── js/main.js            # 交互脚本（导航/滚动进场/数字滚动/技能条/模态框）
│       └── images/               # 图片占位目录（AI 按用户人设现场生成）
├── references/
│   ├── design-spec.md            # 设计令牌/字体体系/签名元素清单
│   ├── data-mapping.md           # 简历字段 -> 网站板块映射表 + 派生字段规则
│   └── image-prompts.md         # 8~10 张图的统一风格提示词 + 并行生成防错流程
└── scripts/
    └── make_favicon.py           # 从形象照生成站点图标（像素字母徽章）
```

#### 使用方式

其他 Agent 使用本技能时：

1. **阅读 `SKILL.md`** 了解完整工作流程（5 个步骤）
2. **阅读 `references/data-mapping.md`** 了解简历字段到网站板块的映射规则
3. **以 `assets/template/` 为起点**，复制模板后替换人物数据，禁止从零重写
4. **按 `references/image-prompts.md`** 生成图片（共用风格前缀，并行生成需逐张验证）
5. **按 `references/design-spec.md`** 调整样式时确保不破坏风格统一
6. **用 `scripts/make_favicon.py`** 生成站点图标
7. 完成后全文搜索旧人物关键词（`江屿|JIANG YU|临江理工|JY-2026`）确认零残留

#### 依赖

- 图片生成：AI 图像生成模型（如 Seedream）
- favicon 脚本：Python 3 + Pillow（`pip3 install pillow`）
- 验证：Playwright 无头浏览器（可选，用于控制台零报错和响应式验证）

### job-apply-automation — 简历自动投递

读取候选人简历，自动在招聘官网（快手/BOSS 直聘/拉勾等）筛选岗位、上传简历、逐字段填写申请表单，完成投递（最终提交需用户确认）。

- **输入**：简历文件（PDF/Word/Markdown 或资料库 drive 节点链接）+ 目标官网/岗位链接
- **输出**：在目标官网完成申请表单的自动填写，投递动作由用户确认后执行
- **核心价值**：把「解析简历 → 打开官网 → 上传简历 → 填表单 → 投递」固化为可复用 SOP
- **安全红线**：真实「投递」按钮必须用户确认后才点击；只排版不编造简历内容

#### 目录结构

```
job-apply-automation/
├── SKILL.md                              # 技能定义与 5 步工作流程
├── references/
│   ├── resume-field-mapping.md           # 简历字段 → 申请表单字段映射（含快手实测字段名）
│   └── browser-playbook.md               # 浏览器自动化实战要点与踩坑记录
└── scripts/
    └── （预留）简历解析辅助脚本
```

#### 使用方式

其他 Agent 使用本技能时：

1. **阅读 `SKILL.md`** 了解 5 步工作流程
2. **阅读 `references/resume-field-mapping.md`** 了解字段映射与系统自动解析规律
3. **阅读 `references/browser-playbook.md`** 掌握 DOM/滚动/日期选择等实战踩坑
4. 投递动作前**必须**用 AskUserQuestion 让用户确认

#### 依赖

- 浏览器自动化：WorkBuddy 内置浏览器或已装扩展的 Chrome
- 简历解析：workbuddy-pdf（PDF）、library 技能（资料库节点）

## 新增技能

如需在本项目中新增其他技能，按同样结构创建子目录：

```
skills/<skill-name>/
├── SKILL.md          # 技能定义（必需）
├── assets/           # 模板/资产（可选）
├── references/       # 参考文档（可选）
└── scripts/          # 辅助脚本（可选）
```

SKILL.md 应包含：技能描述、适用场景、工作流程、资产总览、注意事项。

> AI生成