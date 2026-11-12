# CareerAgent AI 链路打磨方案（差距分析 + 分级改造设计）

> 架构师：高见远（Gao）｜范围：模型接入 → 模型配置 → 模型用到的功能模块
> 产出性质：只出方案，不写代码，供用户评审
> 兼容目标第一优先级：硅基流动 SiliconFlow（`https://api.siliconflow.cn/v1`，OpenAI-compatible）

## 0. 方案综述（TL;DR）

现状是一条「能跑通、但不够稳、反馈不透明」的链：配置页能填能测、代理能转发、4 个动作有降级，但存在三处体验断层（配置/test/试用台/真实功能各自为政）、免费模型能力差异（`response_format`/`stream` 不支持）导致的隐性失败、以及错误信息对用户不友好等问题。

核心原则（不可逾越边界）：
1. 不引入任何新 SDK/依赖（重试/退避手写，理由：链路本身是透传）。
2. 守住 4 条安全边界：`validateBaseUrl` 的 SSRF 防护、`apiKey` 永不回传、账号数据隔离、「AI 未配置时规则/模板降级仍可用」。
3. 默认 OpenAI-compatible，硅基流动为第一兼容目标。
4. 改造以「数据结构 + 接口签名」先行，前后端契约一致。

落地顺序：Phase 0 打地基（错误模型+观测+统一 HTTP）→ Phase 1 配置体验 → Phase 2 功能质量 → Phase 3 端到端闭环 → Phase 4 可选增强。

## 1. 差距分析（按四方向）

### 方向一：配置体验
- 1.1 预设是否含硅基流动 + 模型占位符是否真实可用 id（否则 404）
- 1.2 保存后无即时校验，要手动点测试
- 1.3 上游原始错误（401/403/404/429/超时）直接透传，用户难定位
- 1.4 fast/strong 无用途说明，用户不知如何选型
- 1.5 timeoutMs/temperature 对小白无感知，易误调

### 方向二：功能模块质量（4 个动作）
- 2.1 parseJd 强制 response_format=json_object，硅基流动免费模型可能不支持 → 400/降级
- 2.2 parseJsonLoose 对代码块/前后废话/半截 JSON 健壮性未知
- 2.3 4 个动作返回结构不统一、无「来源」标记
- 2.4 genPitch 覆盖式写回，无法重生成/编辑
- 2.5 reviewInterview 结构化 schema 不明确
- 2.6 kbAsk 检索 topK/引用来源回传未知
- 2.7 prompt 未针对 Qwen/DeepSeek 优化

### 方向三：健壮性与错误处理
- 3.1 超时语义不明确（流式首字节 vs 整段）
- 3.2 429 限流无重试
- 3.3 JSON 解析失败 fallback 覆盖不全（强 JSON vs 弱文本动作未区分）
- 3.4 openChat 流式 hijack 后错误难返回
- 3.5 用量统计维度少（缺 latencyMs/action/errorCode/tokens）
- 3.6 重试不区分错误类型（400/401 不该重试）

### 方向四：端到端体验
- 4.1 三处模型选择各自为政（配置页/试用台/真实功能）
- 4.2 test 只做连通探活，不验 response_format/stream/fast+strong
- 4.3 试用台与真实功能脱节，无法预演 parseJd 能力
- 4.4 无全局 AI 配置状态指示
- 4.5 降级触发后用户不知原因/如何启用

## 2. 分级改造设计

### P0（必须做）
- P0-1 SiliconFlow 预设 + 自定义 provider 打通（配置体验）
- P0-2 统一错误模型 + 友好错误映射（健壮性）
- P0-3 response_format 能力降级 + parseJd JSON 健壮性（功能质量）
- P0-4 统一 HTTP 客户端（超时 + 429 退避重试）（健壮性）
- P0-5 ai_usage 观测字段扩展 + 结构化日志（可观测性）

### P1（重要）
- P1-1 动作结果统一结构 ActionResult<T> + 来源标记（功能质量）
- P1-2 保存后即时校验 + 模型用途说明（配置体验）
- P1-3 test 升级为「连通 + 能力探活」（端到端）
- P1-4 genPitch 重新生成/编辑 + 结果预览（功能质量）
- P1-5 全局 AI 状态徽标 + 未配置引导（端到端）

### P2（可选）
- P2-1 试用台「真实动作演示」
- P2-2 prompt 版本管理 + few-shot 增强
- P2-3 SSE event:error 通道约定
- P2-4 用量可视化与配额提醒
- P2-5 更多服务商预设扩充

## 3. 优先级与依赖

实施顺序：
- Phase 0（地基）：P0-2 错误模型 + P0-4 统一 HTTP + P0-5 观测字段（可并行）
- Phase 1（配置体验）：P0-1 预设/自定义 + P1-2 保存即校验
- Phase 2（功能质量）：P0-3 能力降级 + P1-1 动作结果 + P1-4 genPitch
- Phase 3（端到端闭环）：P1-3 能力探活 + P1-5 状态徽标
- Phase 4（可选）：P2-1~P2-5

关键结论：Phase 0 是地基必须先做；P0-1（硅基流动预设）是用户当前最大痛点，可与 Phase 0 并行优先交付。

## 4. 风险与注意事项
1. local-first 隐私：genPitch/reviewInterview 会发 PII 到第三方 baseUrl，设置页须明确提示；日志/用量只落元数据，绝不落 prompt/响应正文。
2. 免费模型能力差异：强依赖 JSON 的路径须「去 response_format 重试 + parseJsonLoose + 规则降级」三级兜底。
3. 429 限流：重试带退避 + 尊重 Retry-After + 上限 2 次。
4. SSRF 边界不能松：validateBaseUrl 是硬边界，自定义 provider 不可绕过。
5. apiKey 不回传 + 账号隔离：扩展字段不破坏。
6. 降级核心特性保留：改造不得让「AI 未配置→规则降级」失效。
7. 不引入新依赖。

## 5. 待明确事项（已拍板 2026-11-13）

| # | 事项 | 决定 |
|---|---|---|
| 1 | fast/strong 用途映射 | ✅ 采纳默认：fast→parseJd+genPitch（高频轻量）、strong→reviewInterview+kbAsk（复杂推理/长上下文） |
| 2 | 保存后自动测试 | ✅ 是，保存配置后自动发起一次真实探活（计入用量） |
| 3 | response_format 不支持时 | ✅ 自动降级重试一次（多耗一次调用但保质量） |
| 4~8 | genPitch 写回策略/历史版本/用量图表/试用台演示/错误文案 | 边做边定，不阻塞主线（错误文案默认统一中文） |

其余默认：错误文案统一中文；genPitch 保持自动写回；P2 全部可选。
