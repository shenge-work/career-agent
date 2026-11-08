# 简历字段 → 申请表单字段映射规范

本文档定义「简历结构化字段」到「招聘官网申请表单字段」的通用映射，并记录快手（zhaopin.kuaishou.cn）实测字段名。

## 一、通用简历结构化字段

解析简历后应得到如下结构（作为填写源数据）：

```yaml
basic:
  name: 姓名
  phone: 电话
  email: 邮箱
  location: 意向城市
workExperiences:            # 倒序（最近在前）
  - company: 公司名
    position: 职位
    startDate: YYYY-MM
    endDate: YYYY-MM
    responsibility: 职责描述
    achievement: 工作业绩
projects:
  - name: 项目名称
    role: 项目角色
    startDate: YYYY-MM
    endDate: YYYY-MM
    description: 项目描述
    responsibility: 项目职责
educations:
  - school: 学校
    degree: 学历
    major: 专业
    startDate: YYYY-MM
    endDate: YYYY-MM
selfEvaluation: 自我评价
works:
  - 作品链接（GitHub / 作品集）
```

## 二、快手表单实测字段名（name 属性）

快手投递页（`zhaopin.kuaishou.cn/recruit/e/#/official/social/job-apply/{id}`）表单 DOM 字段：

| 区块 | 字段 name 属性 | 类型 | 说明 |
|---|---|---|---|
| 基础信息 | `name` | text | 姓名（必填） |
| 基础信息 | `phone` | text | 电话（必填，+86 区号单独下拉） |
| 基础信息 | `email` | text | 邮箱 |
| 意向地点 | （标签式 combobox） | 选择 | 城市标签，可删除 |
| 工作经历 | `companyName` | text | 公司名 |
| 工作经历 | `positionName` | text | 职位 |
| 工作经历 | （开始/结束日期） | readonly | 日期选择器，双月面板 |
| 工作经历 | `responsibilityDescription` | textarea | 工作职责 |
| 工作经历 | `workAchievement` | textarea | 工作业绩 |
| 项目经历 | `projectName` | text | 项目名称 |
| 项目经历 | `projectDuty` | text | 项目角色 |
| 项目经历 | （开始/结束日期） | readonly | 日期选择器 |
| 项目经历 | `projectDescription` | textarea | 项目描述 |
| 项目经历 | `projectResponsibility` | textarea | 项目职责 |
| 教育经历 | 学校 | combobox | 搜索选择，找不到可手动添加 |
| 教育经历 | 学历 | combobox | 下拉 |
| 教育经历 | 专业 | combobox | 下拉 |
| 教育经历 | （开始/结束日期） | readonly | 日期选择器 |
| 自我评价 | `description` | textarea | 描述 |
| 作品 | （动态添加） | - | 作品链接，可 + 添加 |

## 三、系统自动解析的已知行为（快手实测）

上传简历 PDF 后，系统会自动解析并预填一部分字段，但存在以下规律：

- **通常能解析对**：姓名、电话、邮箱、公司名（基本准确）、学历、专业、教育起止日期
- **通常留空**：所有「工作职责」「工作业绩」「项目名称」「项目角色」「项目职责」字段
- **可能有 OCR 错误**：
  - 职位字段大小写不规范（如 `ai全栈开发工程师` → 应为 `AI全栈开发工程师`）
  - 职位字段混入公司描述（如 `网红营销saas(红杉投资)ai全栈开发工程师·创始团队成员` → 应精简为 `AI全栈开发工程师·创始团队成员`）
  - 极短经历（如两周）的起止日期可能解析不出来

**结论**：职责/业绩/项目名称/角色/职责必须手动补填，职位字段需逐条核对格式。

## 四、填写内容生成原则

1. **只排版不编造**：职责/业绩严格来自简历原文，用简历里的量化数据（如「月均 50 万+触达」「搜索精准度提升 30%」）。
2. **职责与业绩分开**：`responsibilityDescription` 写「负责什么」，`workAchievement` 写「做出了什么成果（带量化）」。
3. **极短经历诚实处理**：两周经历业绩留空，职责写明「短期参与…」即可。
4. **项目经历三项都要填**：名称（含公司+项目名）、角色（技术定位）、职责（核心贡献一句话）。

## 五、扩展位（其他官网）

- BOSS 直聘、拉勾、猎聘等表单字段与快手不同，需要为每个官网单独维护字段映射表。
- 建议在 `references/` 下按官网拆分（如 `kuaishou-fields.md`、`boss-fields.md`），SKILL.md 里按官网路由。
