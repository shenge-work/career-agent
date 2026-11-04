# Agent Harness 架构调研与选型

> 调研日期：2026-11-04
> 目的：为 resume-builder 从「AI 透传代理」升级到「Agent Harness」做架构选型与方案沉淀。
> 范围：GitHub 主流 agent 框架对比 + 本地现成参考项目 `lessie-sourcing-agents` 深度解析 + 已拉取的 `openai/codex` 源码解析 + 已拉取的 Claude Code 泄露源码解析 + 落地路线。

---

## 一、结论速览

1. **业界主流**（2026）：生产级 agent 的默认答案是 **LangGraph**（Klarna/Uber/LinkedIn 在用）；TS 栈想最小体积自己掌控 loop 可选 **OpenAI Agents SDK（TS 版 `openai-agents-js`）**；前沿方向有三条——**DeepSeek Harness（`dsh`）** 的「一切皆插件」、**OpenAI Codex**（Rust 终端 coding agent，本机已克隆到 `~/Documents/codex/`）、以及 **Claude Code**（其源码 2026-03-31 因 npm source map 泄露，本机已克隆泄露镜像到 `~/Documents/claude-code/`）。

2. **本地最有参考价值的范本**：`/Volumes/Untitled/飞向月球/项目代码/lessie-sourcing-agents` —— 一套已上生产、带完整架构文档的 **LangGraph Supervisor 多 Agent 编排系统**。它的 LLM 池化容灾、上下文管理、追踪上报正是 LangGraph 开箱缺失、需自研的部分。

3. **resume-builder 现状**：AI 层只是 `src/server/ai/ai.service.ts` 里的 SSE 透传 proxy（`resolveConfig → callUpstream → openChat`），**没有 agent loop、没有工具调用、没有会话状态机**，不是 harness。

4. **推荐路线**：借鉴 lessie 的架构**模式**（Supervisor 路由 + Checkpointer + LLM 主备 + 事件追踪）+ 吸收 **Codex** 的 turn/step 显式循环与工具审批/沙箱思想，用 TS 生态实现，不重蹈 Python 依赖。

---

## 二、GitHub 主流方案对比（2026）

| 方案 | 语言 | 架构模型 | 适合 | 关键短板 |
|---|---|---|---|---|
| **LangGraph** | Py/TS | 显式状态图（node+edge+checkpoint） | 复杂、有状态、需人审批/断点续跑的生产 agent | 学习曲线陡；checkpoint ≠ 持久执行（崩溃恢复需自补） |
| **OpenAI Agents SDK** | Py/**TS** | 极简原语：Agent/Runner/Handoff/Guardrail | 想自己掌控 loop、TS 栈、快速落地 | 仍 pre-1.0；OpenAI 生态优先 |
| **CrewAI** | Py | 角色式 crew（Agent/Task/Crew/Flow） | 快速原型、多角色协作 | 抽象粗，条件分支/状态回滚弱 |
| **DeepSeek Harness (dsh)** | **TS** | 一切皆插件（Cordis 驱动） | 可扩展、可插拔的 agent 平台 | 开发者预览，破坏性变更多 |
| **OpenAI Codex** | **Rust** | turn/step 显式循环 + 工具路由 + 沙箱/审批 | 终端 coding agent、工程级实现参考 | Rust 重、为 coding 场景深度定制 |
| **Claude Code**（泄露） | **TS/Bun** | pipeline + QueryEngine 单类 + 工具/权限/多agent | 终端 coding agent、与 resume-builder 同栈（TS） | 非官方开源（泄露镜像）、React+Ink 重 UI |
| Microsoft Agent Framework | .NET/Py | AutoGen+SK 合并，superstep | MS 生态 | 社区最年轻 |
| Google ADK | Py/TS/Go/Java | workflow+graph | Gemini/多语言 | Gemini 优先 |

**选型口诀（按匹配度而非星数）**：
- 复杂、有状态、长流程、需人审批 → **LangGraph**
- TS 栈、最小体积、自己掌控 loop → **OpenAI Agents SDK**
- 快速多角色原型 → **CrewAI**
- 可插拔平台化 → **DeepSeek Harness**
- 想看「生产级 agent 的工程实现长什么样」→ **OpenAI Codex**（源码精读，而非直接引入）
- 想看「同栈（TS）的生产级 agent 如何组织」→ **Claude Code 泄露源码**（架构精读，不可直接引入——版权属 Anthropic）

---

## 三、本地参考项目深度解析：`lessie-sourcing-agents`

### 3.1 项目定位

「飞向月球」达人寻源（influencer sourcing）+ 营销触达平台的 Agent 核心服务。

- 技术栈：Python 3.12 + LangGraph 0.5 + FastAPI + MongoDB + Kafka + Nacos
- 入口：`server.py`（uvicorn）→ `dialogue/app.py`（FastAPI）
- 图注册：`langgraph.json`（三张图：`lessie` 主图 / `review_agent_graph` / `person_search_agent`）

### 3.2 核心架构：Supervisor 多 Agent 编排

```
START ─┬─► supervisor（中央协调器，决定路由）
       └─► quick_summary（异步生成对话标题，不阻塞主流程 → END）
              │
supervisor ──Command──► react_search（搜索 Agent 子图）
                     ► outreach（邮件触达 Agent 子图）
                     ► table_operator（表格操作子图）
                     ► complete_task（清理资源 → END）
所有子图完成后都 Command 回 supervisor，形成循环
```

代码落点：`agents/graph/builder.py`（`_build_base_graph`）。

### 3.3 关键设计点（harness 的精华）

| 机制 | 实现 | 代码位置 | 为什么重要 |
|---|---|---|---|
| 状态图 + Checkpointer | `StateGraph(SupervisorState)` + 内存/MongoDB 双 checkpointer 按环境变量切换 | `agents/graph/builder.py` | 状态持久化、断点续跑、可恢复 |
| Supervisor 用「工具」做路由 | `transfer_to_search_agent` / `transfer_to_outreach_agent` 是两个 `@tool`，模型调工具触发 `Command` 跳转子图 | `agents/nodes/supervisor.py` | 路由交给 LLM 决策，而非硬编码 if-else |
| 子图 subgraph | search/outreach/review 各自独立 `StateGraph`，作为父图一个节点挂载 | `agents/nodes/` | 模块化、可独立测试、可复用 |
| 全局状态基类 + final 属性 | `GlobalAgentState(AgentState)`，`conversation_id/turn_id/search_id` 为 final 不可重写 | `agents/state/GlobalAgentState.py` | 多 Agent 间状态隔离与统一 |
| 事件总线 + 系统提醒队列 | PyPubSub + `ReminderQueue`（按 conversation_id 隔离的 deque） | `agents/nodes/context/event_bus/` | 横切关注点解耦，异步注入 system reminder |
| 上下文管理（模板方法） | `ContextManager` 抽象 + `SupervisorContextManager`/`SearchContextManager` 实现 | `agents/nodes/context/impl/` | 每个 Agent 有独立上下文构建策略 |
| LLM 池化 + 主备容灾 | `LLMType` 枚举 + `preload_all_llm_types()`，多模型兜底、消息格式自适应 | `llm/llm.py` | 高可用，主模型挂了切备用 |
| 追踪系统 | `@tool_trace_point` 装饰器 + LangSmith `@traceable` + Kafka 异步上报 | `traces/` | 全链路可观测 |

### 3.4 自带架构文档（`md/` 目录，可直接当 harness 设计文档范本）

1. `Agent编排系统实施方案.md` —— Supervisor 多 Agent 编排
2. `LLM池化主备容灾实施方案.md` —— 多模型兜底 + 格式适配
3. `RAG系统实施方案.md` —— Few-shot 检索（Milvus/FAISS + 重排）
4. `上下文管理系统实施方案.md` —— Token 压缩 + Prompt Caching + 事件提醒
5. `追踪系统实施方案.md` —— LLM/工具/业务三级追踪 + Kafka
6. `search_agent_design.md` —— ReAct 搜索 Agent（迭代式搜索 + Review 反馈闭环）
7. `review_agent_design.md` —— 审核 Agent（checkpoint 评估 + 并发 + 视觉分析）

---

## 四、多方对照：业界主流 vs 前沿 vs 本地范本 vs Codex vs Claude Code

| 维度 | LangGraph（主流） | deepseek-harness（前沿） | lessie 项目（本地范本） | Codex（工程级参考） | Claude Code（同栈参考） |
|---|---|---|---|---|---|
| 架构哲学 | 显式状态图 | 一切皆插件（Cordis） | 状态图 + Supervisor 多 Agent | turn/step 显式循环 + 工具路由 | pipeline + QueryEngine 单类 |
| 编排模型 | node+edge+checkpoint | 插件挂 ctx + 事件瀑布 | StateGraph + 子图 + Command 路由 | 单循环内采样→工具→回传 | tool-call loop 内聚于 QueryEngine |
| 语言 | Py/TS | TS | Py | Rust | TS/Bun |
| 成熟度 | 生产标准 | 开发者预览 | 已上生产 | 13 万 star、生产级 | 生产级（但非官方开源） |
| 可观测 | LangSmith | 事件日志（model-visible=logged） | LangSmith + Kafka 自研追踪 | OTel + StateDb + history | cost-tracker + 会话状态 |
| 容灾 | 无内置（需 Temporal 补） | 插件可换 | 自研 LLM 池化主备 | daemon_recovery + 沙箱 | 重试 backoff + 会话恢复 |

**洞察**：lessie 项目已经覆盖了「生产级 agent harness」最难的几块 —— LLM 池化容灾、上下文 Token 管理、追踪上报、状态持久化。这些正是 LangGraph 开箱没有、需要自己补的东西。它是「用 LangGraph 造 harness」路线的最佳范本；Codex 则是「自己从零写 agent loop」的顶级工程样本，印证了 turn/step 分层是跨语言跨框架的通用骨架；Claude Code 进一步证明「工具调用 = schema+权限+执行+UI 四合一」是所有 harness 的核心共识，且它与 resume-builder 同为 TS 栈，组织方式最具直接参照价值。

---

## 五、OpenAI Codex 源码解析（已拉取到本机 `~/Documents/codex/`）

### 5.1 项目概况

- 仓库：`https://github.com/openai/codex`，**13.3 万 star**，Apache-2.0，Rust 编写，默认分支 `main`。
- 定位：**Lightweight coding agent that runs in your terminal**（终端本地运行的编码 agent）。
- 本机拉取方式：`git -c http.version=HTTP/1.1 clone --depth 1 --single-branch --branch main https://github.com/openai/codex.git`（浅克隆，约 700MB 仓库）。⚠️ 直连 `github.com` 本机间歇 000，`api.github.com` 仍 200，需走代理 + HTTP/1.1。
- 源码核心：`codex-rs/core/`（业务逻辑 crate），workspace 含 138 个子 crate（`codex-cli`/`codex-rs`/`sdk`/`docs`）。

### 5.2 核心架构：turn/step 显式循环

Codex 是**自己实现 agent loop** 的代表（不依赖 LangGraph 等框架），其心智模型直接写在 `session/turn.rs` 的注释里：

> 一个 turn 是一个循环：每次 sampling request（模型采样请求），模型要么返回 function call（执行后把输出回传、进入下一次采样），要么返回 assistant message（记录进历史、turn 结束）。

关键概念（对应源码位置）：

| 概念 | 定义 | 源码位置 |
|---|---|---|
| **Turn** | 一次用户输入驱动的完整循环，直到模型给出最终 assistant message | `core/src/session/turn.rs`、`turn_context.rs` |
| **Step** | 一次模型采样请求（`Request-scoped state that may change between model sampling requests`） | `core/src/session/step_context.rs` |
| **ToolRouter / ToolOrchestrator** | 工具路由 + 编排（审批、沙箱选择、被拒后重试） | `core/src/tools/router.rs`、`orchestrator.rs` |
| **Guardian 审批** | 工具执行的审批/审查上下文 | `core/src/guardian/`、`tools/approvals.rs` |
| **多 Agent（sub-agent）** | 线程树 + `AgentRegistry` 限制子 agent 数量与深度 | `core/src/agent/registry.rs`、`thread_manager/` |
| **AGENTS.md** | 子 agent 的角色/指令来源 | `docs/agents_md.md` |

### 5.3 Codex 相比 lessie/dsh 的独特之处

1. **Turn/Step 双层模型与 dsh 高度一致**：Codex 的 turn=完整循环、step=一次采样请求，与 dsh 的「step=一次模型请求+工具，turn=零或多 step」是同一套思想，只是 Codex 用 Rust 显式写在一个循环里，dsh 用事件驱动表达。**这印证了「turn/step 分层」是 agent harness 的通用骨架，跨语言跨框架都成立。**

2. **工具层是最重的工程部分**：Codex 的 `tools/` 目录有 40+ 文件（router/orchestrator/approvals/parallel/sandboxing/guardian/executed_tool_calls...），覆盖工具审批、沙箱隔离、并行执行、被拒重试。**它把「工具调用」当一等公民，而非模型的附属品** —— 这是 resume-builder 目前完全缺失的一层。

3. **沙箱与审批内建**：`sandboxing` / `execpolicy` / `guardian` 三套机制做命令执行隔离与权限审查（macOS seatbelt / Linux Landlock+bubblewrap / Windows 受限令牌）。这对需要「AI 帮用户改简历文件」的场景是重要参考。

4. **状态持久化**：`state/`（StateDb + sqlite）、`thread_store`、`history` 分层，`daemon_recovery` 支持崩溃恢复 —— 对应 dsh 的 append-only 日志与 lessie 的 checkpointer。

### 5.4 Codex 的可借鉴点 vs 不可借鉴点

**可借鉴（思想层面）**：
- turn/step 显式循环作为 loop 骨架；
- 工具调用作为一等公民 + 审批/重试编排；
- sub-agent 线程树 + 数量/深度限制（防递归失控）；
- 命令执行沙箱（若将来做「AI 直接改文件」）。

**不可借鉴（对本项目而言）**：
- Rust 重、为 coding 场景深度定制，resume-builder（NestJS+TS）不应引 Rust 依赖；
- 其价值是「源码精读学工程实现」，而非「作为依赖引入」。

---

## 六、Claude Code 泄露源码解析（已拉取到本机 `~/Documents/claude-code/`）

### 6.1 泄露背景（重要，先厘清「是不是官方开源」）

- **Claude Code 从未官方开源**。`anthropics/claude-code` 官方仓库（15.4 万 star）只放文档/示例/插件/CHANGELOG，**不含核心 `src/` 源码**。
- **泄露事件**：2026-03-31，Anthropic 发布 npm 包 `@anthropic-ai/claude-code` 时误将 source map（`cli.js.map`）打包进去，`.map` 的 `sourcesContent` 字段含完整未混淆 TypeScript 源码，并指向公开的 Cloudflare R2 存储桶。发现者 Chaofan Shou（@Fried_rice）。规模约 **1900 文件 / 51.2 万行**。Anthropic 随后移除 source map，但社区已镜像。
- **本机拉取**：选用了 `agate/claude-code`（保留**原始未修改 TS 源码** + 完整 `docs/`：architecture/tools/commands/subsystems/bridge/exploration-guide）。⚠️ 注意：最火的 `ultraworkers/claw-code`（19.5 万 star）是社区 fork，已把源码**重写为 Python** 并大幅魔改，非原始泄露源码，分析架构时应以原始 TS 镜像为准。
- ⚠️ **版权**：泄露源码版权归 Anthropic，仅供学习参考，不可复制进本项目。

### 6.2 核心架构：pipeline 模型 + QueryEngine 单类

Claude Code 的架构是 **pipeline 模型**（`docs/architecture.md`）：

```
用户输入 → CLI解析(Commander.js) → QueryEngine → LLM API → 工具执行循环 → 终端UI(React+Ink)
```

关键组件：

| 组件 | 职责 | 源码位置 |
|---|---|---|
| **QueryEngine** | 心脏：流式响应、tool-call loop、thinking、重试、token 计数、上下文管理 | `src/QueryEngine.ts` |
| **Tool 基类** | 每个工具 = Zod 输入 schema + 权限模型 + 执行逻辑 + UI 组件 | `src/Tool.ts`、`src/tools/`（~40 工具） |
| **Command 系统** | 三类斜杠命令：PromptCommand（发提示）/ LocalCommand（进程内文本）/ LocalJSXCommand（进程内 JSX） | `src/commands.ts`、`src/commands/` |
| **权限系统** | 4 模式：`default`（逐条问）/`plan`（批量批准）/`bypassPermissions`/`auto`（ML 分类） | `src/hooks/toolPermission/` |
| **多 Agent** | `AgentTool` 派生子 agent、`Task`（`local_bash`/`local_agent`/`remote_agent`/`in_process_teammate`）、`Team`/`SendMessage`/`coordinator` | `src/coordinator/coordinatorMode.ts`、`src/Task.ts` |
| **Bridge** | CLI 与 IDE（VS Code/JetBrains）双向通信（JWT 认证 + 权限代理） | `src/bridge/` |
| **MCP** | 既是 MCP client 也可作 MCP server（`src/entrypoints/mcp.ts`） | `src/services/mcp/` |

### 6.3 Claude Code 相比 Codex/dsh/lessie 的独特之处

1. **与 resume-builder 同栈（TypeScript）**：这是四份参考里唯一用 TS 的「生产级 coding agent」源码。Codex 是 Rust、dsh 是 TS 但偏平台化、lessie 是 Python，而 Claude Code 直接用 TS/Bun 写出了完整 agent，组织方式（`src/tools/` 每工具一目录、`src/services/` 集成层、`src/state/` 状态）对 resume-builder 的 NestJS 结构有直接参照意义。

2. **「单一大类 QueryEngine」vs「分层状态机」的对立**：Claude Code 把整个 loop 塞进一个 QueryEngine 类（README 称约 46K 行，本镜像剥离后 1297 行），而 Codex/dsh 都做了显式分层（turn/step + 事件）。**这说明：agent loop 既可以「单类内聚」也可以「分层拆解」，规模小时单类反而简单直观** —— 对 resume-builder 这种轻量场景，「单类内聚 + 工具外置」可能是更务实的起点。

3. **工具 = schema + 权限 + 执行 + UI 四合一**：Claude Code 把每个工具做成一等公民（Zod schema + permission + 执行 + Ink UI 组件四部分），与 Codex 的 ToolRouter/ToolOrchestrator 殊途同归，再次印证「工具调用是 harness 的核心工程」。

4. **多 agent 用「工具」表达**：`AgentTool`/`TeamCreate`/`SendMessage` 把子 agent 也建模成工具，配合 `coordinator` 模式（worker 工具白名单）+ `Task` 生命周期（pending/running/completed/failed/killed）。与 lessie 的 Supervisor+子图、Codex 的 thread 树是同一问题的三种解法。

### 6.4 可借鉴点 vs 不可借鉴点

**可借鉴（思想层面）**：
- 工具四合一（schema/权限/执行/UI）的组织方式；
- 「单类内聚 loop + 工具外置」的轻量起点（适合 resume-builder 当前规模）；
- 多 agent 用工具表达 + 子 agent 工具白名单（`ASYNC_AGENT_ALLOWED_TOOLS`）；
- 权限分级（default/plan/bypass/auto）——若将来做「AI 改简历」需要审批。

**不可借鉴**：
- 版权归 Anthropic，**不能复制代码**，只读架构与命名思路；
- React+Ink 终端 UI 与 resume-builder 的 Web（React+Vite）形态差异大，UI 层无参照；
- Bun runtime + Commander.js + 46K 行单文件的做法对 NestJS 项目不适用。

---

## 七、deepseek-harness 的三条「内功」（跨框架保值，可只借思想）

本机 `~/Documents/deepseek-harness` 是 DeepSeek AI 官方开源的 agent harness（代号 `dsh`，npm `@deepseek-ai/dsh`），架构文档 `docs/architecture.md` 提炼出三条最保值的设计原则：

1. **Append-only 日志为唯一事实源** —— 会话日志只追加不修改，fork/恢复/transcript/telemetry 全从这条流派生。
2. **Model-visible = logged** —— 凡是模型能看见的输入，必须能从日志重建（运行时 invariant 断言）。这是自研 harness 最常缺的一环。
3. **Capability seam 三角色** —— 一个可替换能力 = Service Definition（接口）+ Provider（实现）+ Consumer（模型可见工具）。三者缺一不算 seam。

---

## 八、对 resume-builder 的落地路线

### 现状

`src/server/ai/ai.service.ts` 当前只做：账号隔离的配置解析（`ai_configs` 表，apiKey 脱敏永不出服务端）、上游 SSE 透传、用量统计（`ai_usage`）。**没有 agent loop / 工具调用 / 会话状态机。**

### 三条路线

**路线 A（推荐）—— 借鉴 lessie 的「模式」+ Codex 的「循环骨架」+ Claude Code 的「工具组织」，用 TS 生态实现**
- Supervisor 路由 → 简历场景天然是「意图路由」（改简历 / 匹配 JD / 生成 summary），用 LLM 工具调用做路由；
- turn/step 显式循环 → 借鉴 Codex/dsh 的双层模型，自研轻量 loop（`for step in turn: 采样 → 若有 tool_call 则执行并回传，否则结束`）；
- 工具组织 → 借鉴 Claude Code 的「工具 = schema + 权限 + 执行 + UI 四合一」，且同为 TS 栈可直接对齐目录结构；
- Checkpointer → `tracker.payload.chat` 已有雏形，升级成 append-only 日志 + 可恢复；
- LLM 主备 → `ai_configs.models` 已存 fast/slow 字典，正好扩展成「主备兜底」。

**路线 B —— 直接引 TS 版框架**
- LangGraph 官方 TS 版（`@langchain/langgraph`），吃 lessie 同款状态图能力，模式一一对应；
- 或 OpenAI Agents SDK TS 版（`openai-agents-js`），更轻，只取 Agent/Runner/Handoff/Guardrail 四原语。

**路线 C —— 吸收 dsh 的「内功」，只借思想不引库**
- 三条铁律（见第七节）直接约束后续 AI 层设计；
- `ai_configs` 的 provider + baseUrl 抽象已是 seam 雏形，往这个方向长。

### 决策建议

resume-builder 栈是 NestJS + TypeScript，场景是「简历定制」这类确定性较强的流程，不是长程自主 agent，**不建议引入 LangGraph 这类重框架**。短期优先 **路线 A**（借模式 + 自研轻量 loop），长期以 **路线 C** 的三条原则兜底约束，需要状态图能力时再按路线 B 引入 TS 版 LangGraph。Codex 与 Claude Code 源码定位为「工程实现精读参考」，均不直接引入（后者版权归 Anthropic，更不可复制代码）。

---

## 九、目标架构图（融合四份参考源码，适配 NestJS 栈）

### 9.1 总体分层（四层）

```
① 接入层（现状已有，保留）          SSE openChat / TenantDb 隔离 / apiKey 脱敏 / 用量统计
        │  ↓（把「透传」改为「喂给 loop」）
② Agent 循环层（核心新增）          AgentLoop（turn/step）+ 意图路由 Supervisor
        │                            + append-only 会话日志（唯一事实源）
        │  ↓
③ 工具层（一等公民）                Tool Registry（Zod schema + 权限 + 执行）
        │                            + ToolOrchestrator（审批 / 重试 / 并行）+ Guardian
        │  ↓
④ 能力 seam 层（可替换）            模型 provider（主备兜底）/ 存储 / 工具 provider
```

### 9.2 turn/step 循环（心脏）

```
开始 turn → 采样请求(step) → 模型返回
                ↑                   │
                │            ┌──────┴──────┐
                │          tool_call      文本
                │            │             │
                └── 执行工具 ←┘       结束 turn → 输出 assistant 消息
                     （结果回传 + 追加日志）
```

- **turn** = 一个循环（用户一次请求到最终回复）
- **step** = 一次模型采样请求 + 它触发的工具调用
- 三条内功贯穿全程：① append-only 日志为唯一事实源 ② model-visible = logged ③ 状态可恢复（checkpoint）

### 9.3 各层借鉴来源（不复制代码）

| 目标层 | 借鉴自 |
|---|---|
| turn/step 循环 | Codex（`session/turn.rs`）与 dsh 同构 |
| 意图路由 Supervisor | lessie（`agents/nodes/supervisor.py`） |
| 工具 schema + 权限 + 执行 | Claude Code（`src/tools/` 每工具一目录） |
| append-only 日志铁律 | dsh（model-visible = logged） |
| checkpointer / LLM 池化主备 | lessie（`llm/llm.py` + checkpointer） |
| TS 组织方式（每工具一目录） | Claude Code（同栈） |

> 全部为「借思想 / 借模式」。Codex 为 Apache-2.0 可读；Claude Code 泄露源码版权归 Anthropic，仅可读架构不可复制代码。

---

## 十、待办 / 下一步

- [x] 画「resume-builder 的 agent harness 目标架构图」（对照 lessie 的 Supervisor 架构）—— 已完成，见 §九
- [ ] 确认「改简历 / 匹配 JD / 生成 summary」的意图路由模型
- [ ] 评估 `ai_configs.models` 扩展为主备兜底的最小改动
- [ ] 决定 `tracker.payload.chat` 是否升级为 append-only 会话日志
- [ ] （可选）精读 Codex `tools/router.rs` 的审批/重试编排，评估是否要引入「工具审批」层

---

## 附：关键文件索引

- 本机范本：`/Volumes/Untitled/飞向月球/项目代码/lessie-sourcing-agents/`
  - 图构建：`agents/graph/builder.py`
  - Supervisor：`agents/nodes/supervisor.py`
  - 状态：`agents/state/GlobalAgentState.py`、`agents/state/state.py`
  - 事件总线：`agents/nodes/context/event_bus/`
- 本机 Codex 源码：`~/Documents/codex/`（`openai/codex` 浅克隆）
  - agent loop：`codex-rs/core/src/session/turn.rs`、`turn_context.rs`、`step_context.rs`
  - 工具层：`codex-rs/core/src/tools/`（router / orchestrator / approvals / parallel / sandboxing / guardian）
  - 多 agent：`codex-rs/core/src/agent/registry.rs`、`thread_manager/`
- 本机 Claude Code 泄露源码：`~/Documents/claude-code/`（`agate/claude-code` 浅克隆，原始 TS）
  - 架构文档：`docs/architecture.md`、`docs/tools.md`、`docs/commands.md`、`docs/subsystems.md`
  - agent 心脏：`src/QueryEngine.ts`、`src/Tool.ts`、`src/tools/`
  - 多 agent：`src/coordinator/coordinatorMode.ts`、`src/Task.ts`、`src/tools/AgentTool/`
  - 权限：`src/hooks/toolPermission/`；MCP：`src/services/mcp/`
- 本机前沿范本：`~/Documents/deepseek-harness/`
  - 架构文档：`docs/architecture.md`
  - 核心包：`packages/core/agent-loop/`、`packages/core/agent/`、`packages/core/tools/`
- 本项目现状：`src/server/ai/ai.service.ts`、`src/server/ai/ai-config.ts`
