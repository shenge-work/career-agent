# N12 · RAG 与 Agent：个人求职领域的智能体工作台

> 编号 / 优先级 / 借鉴来源 / 状态 / 评审结论
> - **编号**：N12（接续 N11-本地版本历史与回溯）
> - **优先级**：P0（定位主线）
> - **借鉴来源**：Resume Matcher（JD→简历→求职信→面试准备闭环）+ Reactive Resume（AI Agent 工作区）+ LangChain/LlamaIndex 的 RAG 范式
> - **状态**：设计完成 · **待评审**
> - **评审结论**：待评审

---

## 〇、一句话结论

CareerAgent 从「简历工具 + 投递记录」升级为「个人求职 Agent 工作台」，核心是在已就绪的
**AI 转发底座**（`ai.service.ts`）之上，建一层**场景化 Agent 编排**，并引入**本地 RAG 检索层**
（关键词 + 全文检索，零外部依赖），打通三条主线：

1. **JD 自动解析 → 简历关键词匹配 → 自动生成投递话术**（Agent 决策 + 生成链）
2. **投递进度追踪、面试复盘自动整理、面经知识库**（RAG 的知识沉淀侧）
3. **个人求职领域的 RAG + Agent 实践**（私有数据 + 检索增强 + 智能体编排）

---

## 一、背景与现状盘点

### 1.1 现有资产（已就绪，可复用，勿重造）

| 资产 | 位置 | 说明 |
|---|---|---|
| **AI 转发底座** | `src/server/ai/ai.service.ts` | OpenAI-compatible 转发 + SSE 透传 + 按账号配 Key + 用量统计 + SSRF 防护（`validateBaseUrl`），已完整可用 |
| **AI 配置层** | `ai-config.ts` | `buildChatPayload`（白名单转发）/ `normalizeConfig` / `publicConfig`（Key 永不回传） |
| **JD 纯规则引擎** | `src/server/business/jd.service.ts` | `extractTerms` / `analyze` / `buildDerivedPayload` / `deriveTitle`，零依赖、离线、确定性 |
| **岗位聚合根** | `schema.ts` 的 `applications` + `application_events` | 一次求职的完整旅程，状态流水已落地 |
| **AI 配置/用量表** | `ai_configs` / `ai_usage` | 按账号隔离，用量可统计 |

### 1.2 核心缺口（本需求要补的）

1. **AI 层只有"裸转发"，没有"场景化动作"**——`/api/ai/chat` 是透传，前端要自己拼 prompt。
   新定位要求的是"在编辑器/JD/投递/面试各处挂'让 Agent 帮我…'"，服务端负责注入场景上下文。
2. **JD 解析是纯规则，不是大模型**——`extractTerms` 做关键词匹配够用且可解释，但缺
   "JD 结构化抽取（岗位/职责/要求/加分项）"和"语义理解"，话术生成完全没有。
3. **没有投递话术/求职信的存储载体**——`applications.payload` 是 jsonb 兜底，但没有结构化的
   话术/求职信字段与生成链路。
4. **没有面试复盘与面经知识库**——既无数据表，也无检索能力。`BusinessService` 里**没有**
   `analyzeInterview`（此前构思文档误记为"留桩"，以代码为准：该方法不存在）。
5. **没有 RAG 检索层**——面经/复盘的检索复用无从谈起。

---

## 二、用户价值（痛点 → 收益）

| 痛点 | 收益 |
|---|---|
| 每投一个岗位，要手动读 JD、手动改简历、手动写打招呼话术，重复劳动 | JD 一贴即解析，自动匹配简历差距，一键生成针对性话术 |
| 面试完就忘了，同样的坑下次还踩 | 复盘自动结构化整理，沉淀成可检索的面经 |
| 面过的公司、问过的问题散落各处 | 面经知识库按公司/岗位/问题维度检索复用 |
| 投了一堆，不知道进展到哪、该干什么 | 投递进度 + 状态流水 + 跟进提醒，一个视图看清 |
| AI 是个"要去找它聊天"的独立页 | AI 收敛为贯穿各处的场景化动作，在需要时被唤起 |

---

## 三、需求描述（功能点 + 交互细节）

### 3.1 JD 自动解析（规则 + 大模型混合）

**输入**：用户粘贴 JD 文本（或从已有 `company_jds` / `applications.payload.jdText` 选择）。

**流程**：
1. **规则层（确定性、离线、零成本）**：复用 `jd.service.ts` 的 `extractTerms` 抽取关键词，
   `analyze` 做简历匹配（已覆盖/弱覆盖/缺失三档）。这一层**永远先跑**，作为可解释的基线。
2. **大模型层（语义增强、可选）**：调用 `ai.service` 做 JD **结构化抽取**，输出 JSON：
   ```json
   {
     "position": "高级前端工程师",
     "company": "某公司",
     "summary": "一句话职责概括",
     "requirements": ["精通 React", "3 年以上经验", "有大型项目经验"],
     "preferred": ["熟悉 TypeScript", "有开源经验"],
     "keywords": ["React", "TypeScript", "性能优化"]
   }
   ```
   - 大模型抽取结果**只做补充**，不替代规则层的匹配结论；两者并存展示。
   - 若 AI 未配置，规则层仍可独立工作（降级路径，见 3.4）。

**交互**：岗位页 / 编辑器 JD 对照面板，粘贴 JD → 点「解析」→ 展示结构化字段 + 匹配三档。

### 3.2 简历关键词匹配（规则层，已实现，接前端）

- `analyze(payload, jdText)` 已返回 `stats`（total/covered/weak/missing/score）+ `groups`。
- 本需求补的：**编辑器「JD 对照面板」**——实时标注每个关键词"已覆盖/弱覆盖/缺失"，并高亮
  缺失项在简历里该补的位置（复用 `buildDerivedPayload` 的"待补提示"机制）。

### 3.3 自动生成投递话术（大模型，新增）

**输入**：JD（结构化字段 + 关键词）+ 简历（匹配分析结果）+ 目标公司。

**输出**：投递打招呼话术 / 求职信（Cover Letter），按场景分两类：
- **打招呼话术**（短，用于 BOSS/猎聘等 IM 场景）——2~3 句，点出匹配点 + 差异化。
- **求职信**（长，用于邮件/官网投递）——正式结构，含段落。

**存储**：落在 `applications.payload.pitch`（结构化：`{ greeting, coverLetter, generatedAt, model }`），
与岗位绑定，可查看/复制/重新生成。

**生成约束（重要）**：
- 话术必须**基于真实简历内容**，不得凭空编造经历（`buildDerivedPayload` 的"待补提示"同理）。
- system prompt 注入当前简历片段 + JD 结构化结果，明确"只引用简历里存在的经历"。

### 3.4 AI 未配置时的降级路径

- JD 解析 → 规则层仍可用（关键词 + 匹配）。
- 话术生成 → 用规则模板兜底（`suggestSentence` 式模板拼装），提示"配置 AI 后可生成更精准话术"。
- 面试复盘 / 面经检索 → 检索仍可用（关键词/全文），但"自动整理"降级为"仅原样存储"。

### 3.5 投递进度追踪（已部分落地，补闭环）

- `applications.status`（interested→applied→interviewing→offered/rejected/withdrawn）+ `application_events`
  状态流水已落地。
- 本需求补的：
  - **跟进提醒**：`follow_up_after_days` 字段已就绪，补前端录入 + 仪表盘"该跟进了"提示（基于
    `applied_at + follow_up_after_days` 计算到期）。
  - **面试阶段细分**：`stage` 字段承载"一面/二面/终面/HR 面"等非结构化细分。

### 3.6 面试复盘自动整理（大模型，新增）

**输入**：用户粘贴面试过程记录（自由文本，可含"问：…答：…"或流水账）。

**输出**（大模型结构化整理）：
```json
{
  "questions": [{ "q": "...", "a": "...", "myAnswer": "我当时的回答", "rating": "好/一般/差" }],
  "highlights": ["亮点"],
  "improvements": ["改进点"],
  "nextSteps": ["下一步准备"],
  "summary": "一段话总结"
}
```

**存储**：新增 `interview_notes` 表（见 4.1），挂在 `application_id` 维度。

### 3.7 面经知识库（RAG 检索，新增）

- **沉淀**：面试复盘整理后，可一键"沉淀为面经"，存入 `interview_notes`（或独立 `interview_kb` 表）。
- **检索**：按公司/岗位/问题关键词做**本地关键词 + 全文检索**召回，注入大模型上下文回答问题
  （如"这家公司一面常问什么？""这个岗位面试重点是什么？"）。
- **隐私自持**：面经只存本机 `pgdata`，检索全程本地，不上云。

---

## 四、数据结构（schema 变更）

### 4.1 新增表

```typescript
/** 面试复盘 / 面经条目：挂在 application 维度，支持检索复用。 */
export const interviewNotes = pgTable(
  'interview_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    applicationId: text('application_id'), // 可为空：独立面经不挂岗位
    company: text('company'),
    position: text('position'),
    round: text('round'), // 一面/二面/终面/HR 面
    /** 原始自由文本（用户粘贴），复盘整理前的原始记录。 */
    raw: text('raw'),
    /** 大模型结构化整理结果（JSON）。 */
    summary: jsonb('summary').$type<Record<string, unknown>>(),
    /** 是否已沉淀为面经（进入检索池）。 */
    isKnowledge: boolean('is_knowledge').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('interview_notes_user_idx').on(t.userId),
    index('interview_notes_user_app_idx').on(t.userId, t.applicationId),
    index('interview_notes_user_kb_idx').on(t.userId, t.isKnowledge),
  ]
);
```

### 4.2 `applications.payload` 扩展字段（不新增列，用 jsonb 承载）

```jsonc
{
  "jdText": "...",            // JD 原文快照
  "jdParsed": { ... },        // 大模型结构化抽取结果（3.1）
  "matchResult": { ... },     // 规则层匹配分析结果（3.2）
  "pitch": {                  // 投递话术/求职信（3.3）
    "greeting": "...",
    "coverLetter": "...",
    "generatedAt": 1699000000000,
    "model": "gpt-4o-mini"
  }
}
```

### 4.3 迁移文件

`drizzle/0006_interview_notes.sql` —— 建 `interview_notes` 表（PGlite 单进程铁律：迁移前停 dev）。

---

## 五、RAG 架构设计（核心）

### 5.1 分层

```
┌─────────────────────────────────────────────────────────┐
│  前端（场景化 Agent 动作入口）                            │
│  编辑器 JD 对照面板 · 岗位页话术 · 面试复盘 · 面经检索      │
└────────────────────────┬────────────────────────────────┘
                         │  /api/agent/*  /api/interview/*  /api/kb/*
┌────────────────────────▼────────────────────────────────┐
│  Agent 编排层（新增，本需求核心）                         │
│  - 场景上下文组装（简历片段 + JD + 岗位状态 → system）     │
│  - 动作分发（parseJd / genPitch / reviewInterview / kbAsk）│
│  - 降级路径（AI 未配置 → 规则模板）                        │
└────────────┬──────────────────────┬─────────────────────┘
             │                      │
┌────────────▼───────────┐  ┌───────▼──────────────────────┐
│  规则引擎（确定性）      │  │  RAG 检索层（本地）           │
│  jd.service.ts         │  │  - 关键词匹配（复用 extractTerms）│
│  extractTerms/analyze   │  │  - pg 全文检索（to_tsvector）   │
└────────────────────────┘  │  - 召回 → 注入大模型上下文      │
                            └───────┬──────────────────────┘
                                    │
┌───────────────────────────────────▼──────────────────────┐
│  AI 转发底座（已就绪，勿动）                              │
│  ai.service.ts：buildChatPayload / openChat / resolveConfig │
└──────────────────────────────────────────────────────────┘
```

### 5.2 关键设计决策

1. **RAG 检索层选「本地关键词 + 全文检索」，不引向量库**（本轮决策）：
   - 理由：面经/复盘量级小（单人百级），关键词 + pg 全文检索够用且**零外部依赖、隐私自持**，
     符合"数据自持"护城河。
   - **预留升级口**：`interview_notes.summary` 用 jsonb 存结构化结果，未来若引入 embedding，
     只需加一列 `embedding vector(n)`，检索层抽象接口不变（`retrieve(query) → 命中片段`）。
2. **规则层与大模型层解耦**：规则层永远先跑（确定性、可解释、离线），大模型做语义增强。
   两者不互相阻塞，AI 未配置时规则层仍可用。
3. **Agent 动作 = 场景化，非无限对话**：每个动作有明确的输入/输出契约，system prompt 由服务端
   按场景组装，前端不直接拼 prompt（防 prompt 注入 + 保证质量）。
4. **所有 Agent 动作走既有 AI 转发**：`openChat` 的 SSE 透传复用，不新开通路；用量统计、
   Key 隔离、SSRF 防护自动继承。

### 5.3 Agent 动作清单（v1 落地范围）

| 动作 | 端点（拟） | 输入 | 输出 | 是否用大模型 |
|---|---|---|---|---|
| JD 结构化解析 | `POST /api/agent/parse-jd` | JD 文本 | 结构化字段 JSON | 是（降级：规则） |
| 生成投递话术 | `POST /api/agent/gen-pitch` | applicationId | 话术 + 求职信 | 是（降级：模板） |
| 面试复盘整理 | `POST /api/agent/review-interview` | 复盘原始文本 | 结构化复盘 JSON | 是 |
| 面经问答 | `POST /api/agent/kb-ask` | 问题 | 回答（带引用来源） | 是（检索增强） |

---

## 六、工程护栏（项目铁律）

1. **每张新表带 `user_id`**，查询走 `TenantDb.forUser(userId)`，跨用户资源返 404（铁律）。
2. **apiKey 永不回传**：Agent 动作复用 `ai.service.resolveConfig`，GET 只回脱敏。
3. **SSRF 防护继承**：所有大模型调用走 `ai.service.callUpstream`，不另开 fetch。
4. **话术/复盘不得编造经历**：system prompt 明确"只引用简历中真实存在的经历"，生成结果标注
   `basedOn: resume`。
5. **迁移走 drizzle 手写 SQL**：`0006_interview_notes.sql`，迁移前停 dev（PGlite 单进程）。
6. **测试先行**：`npm test` 为权威，Agent 动作需覆盖——行级隔离、降级路径（AI 未配置）、
   外键越权（跨 user 的 applicationId 返 404）、prompt 注入防护。
7. **SSE 透传铁律**：`api.ts` 仅 `init.body` 存在才声明 `Content-Type`（Fastify 400 坑）。

---

## 七、非目标（明确不做）

1. **不做向量库 / embedding 检索**（本轮）——关键词 + 全文检索已够用，向量化留作升级口。
2. **不做通用聊天式 Agent**——Agent 是场景化动作，不是无限对话（沿用定位红线）。
3. **不做自动"一键海投"**——话术生成是为"人确认后投递"服务，投递动作由人完成。
4. **不做公开云 RAG 服务**——检索全程本地，面经不出本机 `pgdata`。
5. **不做多智能体协作 / 工具调用框架**——单 Agent 编排够用，不引 LangChain 等重型依赖
   （保持零外部依赖、可审计）。

---

## 八、评审结论

**护城河四问**：
1. 是否守住"数据自持"？—— ✅ 面经/复盘存本机，检索全程本地，不上云。
2. 是否守住"自由 CSS 排版"？—— ✅ 本需求不碰排版，话术/复盘是新增能力，不影响现有引擎。
3. 是否守住"版本历史"？—— ✅ 面试复盘/话术落库可追溯，`applications` 状态流水已就绪。
4. 是否新增不可逆的外部依赖？—— ✅ 不引向量库、不引重型 Agent 框架，只复用已就绪的 AI 转发。

**价值 / 成本 / 依赖**：
- 价值：把"工具"推向"Agent 工作台"，是定位主线的落点。
- 成本：中等——4 个 Agent 动作 + 1 张表 + 1 个检索层，复用既有 AI 底座，无需重造。
- 依赖：AI 配置（`ai_configs`）已就绪；`applications` 聚合根已落地。

**结论**：✅ **通过，建议分期落地**（见下）。

### 分期落地建议

| 阶段 | 事项 | 交付物 |
|---|---|---|
| **S1（本轮）** | Agent 编排层骨架 + JD 结构化解析 + 投递话术生成 | `agent.service.ts` + `agent.controller.ts` + 3.1/3.3 |
| **S2** | 面试复盘整理 + 面经知识库（含检索） | `interview_notes` 表 + 检索层 + 3.6/3.7 |
| **S3** | 编辑器 JD 对照面板 + 岗位页话术入口 + 仪表盘跟进提醒 | 前端接入 3.2/3.5 |

---

## 附：与现有文档的关系

- 本文承接 [重设计构思](./重设计构思-个人求职Agent工作台.md) 的 §2.6（AI 场景化）、§3.4（面试闭环）、
  §3.5（求职信）、§3.7（复盘洞察），把这些"构思"落成可认领的需求文档。
- 修正构思文档一处误记：`BusinessService` 里**没有** `analyzeInterview` 方法（此前误写"已留桩"），
  面试复盘整理是**全新开发**，非"接桩"。
- 复用 [D3-JD驱动派生版本](./D3-JD驱动派生版本与存储血缘.md) 的匹配引擎（`jd.service.ts`），
  本需求在其上叠加"大模型结构化抽取"而非替换。
- 与 [N2-AI润色闭环](./N2-AI润色闭环.md)、[N7-求职信与面试准备](./N7-求职信与面试准备.md) 有交集：
  本需求是它们的"Agent 化 + RAG 化"升级，落地时可合并评审，避免重复造轮子。

> AI 生成 · 设计稿待评审
