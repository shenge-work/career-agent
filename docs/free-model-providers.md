# 免费大模型 API 接入指南（CareerAgent）

> 调研日期：2026-11-13 · 限额与免费模型变动频繁，**接入前请以各平台官网为准**。

## 一、项目为什么能直接接免费 API

AI 接入层是**开放式 OpenAI-compatible 代理**（`src/server/ai/ai-config.ts` +
`src/web/AiSettings.tsx`）：用户只需在账号设置（`#/ai`）填写 `baseURL` + `apiKey` + 模型
id，后端原样转发到 `{baseUrl}/chat/completions`，**没有 provider 白名单**，所以任何
OpenAI 兼容的免费 API 都能即接即用，零后端改动。

### 后端安全约束（填 baseURL 时要注意）
- 只接受 `https` 公网域名；`http` 仅限本机回环（本地 Ollama）。
- 拒绝内网 / 云元数据等字面私有 IP（SSRF 防护）。
- `baseURL` 不能带 query / hash / `..` 路径穿越。
- 模型 id 大小写敏感；`temperature` 0~2；`max_tokens` ≤ 128000。

## 二、已内置的服务商预设（`#/ai` 可一键选择）

设置页顶部「快速选择服务商」下拉会自动填好 `provider` 与 `baseURL`，并给出推荐模型占位：

| 预设 key | 服务商 | baseURL | fast 示例 | strong 示例 |
|---|---|---|---|---|
| siliconflow | 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` | `deepseek-ai/DeepSeek-R1-Distill-Qwen-32B` |
| zhipu | 智谱 BigModel | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | `glm-4.7` |
| deepseek | DeepSeek 官方 | `https://api.deepseek.com/v1` | `deepseek-chat` | `deepseek-reasoner` |
| qwen | 阿里云百炼（通义千问） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | `qwen-max` |
| xfyun | 讯飞星火 | `https://spark-api-open.xf-yun.com/v1` | `generalv3`(Pro) | `generalv3.5`(Max) |
| doubao | 火山方舟（豆包） | `https://ark.cn-beijing.volces.com/api/v3` | `ep-xxxxxxxx`（接入点 ID） | — |
| hunyuan | 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-lite` | `hunyuan-standard` |
| kimi | Kimi（月之暗面） | `https://platform.moonshot.cn/v1` | `moonshot-v1-8k` | `moonshot-v1-32k` |
| gemini | Google AI Studio（Gemini） | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-2.5-flash` | `gemini-3-flash` |
| groq | Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `deepseek-r1-distill-llama-70b` |
| nvidia | NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `deepseek-ai/deepseek-v3` | — |
| openrouter | OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat-v3-0324:free` | — |
| topenrouter | TopenRouter（OpenAI 兼容聚合） | `https://tp-api.chinadatapay.com:8000/v1` | `deepseek-v4-flash` | `deepseek-ai/DeepSeek-V4-Pro` |
| cerebras | Cerebras | `https://api.cerebras.ai/v1` | `llama-3.3-70b` | `gpt-oss-120b` |

## 三、免费额度与适用场景（2026-11）

### 国内（中文友好、国内直连，推荐本项目的目标用户优先）
| 平台 | 免费方式 | 注册门槛 | 是否 OpenAI 兼容 | 备注 |
|---|---|---|---|---|
| 硅基流动 | 注册即送额度，多开源模型免费 | 免信用卡 | ✅ | 1000 RPM / 50000 TPM；官方声明无数据留存 |
| 智谱 BigModel | `glm-4-flash` 等 Flash 系列**长期免费**（128K 上下文）；新用户送 2000 万 Tokens | 免卡 / 国际端免国内手机 | ✅ | 中文能力强；`glm-5.3` 等旗舰为付费模型（可用资源包抵扣） |
| DeepSeek | 送免费额度 | 免卡 | ✅ | 代码 / 推理强，国内直连 |
| 阿里云百炼 | 新用户免费额度 | 需阿里云账号 | ✅ | `qwen-max` 可能计费 |
| 火山方舟 | 首开每模型送 50 万 tokens | 需字节账号 | ✅（用 `ep-` 接入点） | — |
| 腾讯混元 | 首开送 100 万 tokens | 需腾讯云账号 | ✅ | — |
| Kimi | 新用户送代金券 | 需国内手机 | ✅ | — |
| TopenRouter | 聚合 DeepSeek/GLM 等，国内直连 | 免卡 | ✅ | baseUrl 必须带 `/v1` 且带端口 `8000`，见下方坑 |
| 讯飞星火 | `Spark Lite`（`lite`）永久免费 | 免卡（控制台领免费额度） | ✅（`spark-api-open.xf-yun.com/v1`） | 鉴权用控制台 APIPassword 作 Bearer；`generalv3`=Pro / `generalv3.5`=Max / `4.0Ultra`=旗舰 |

### 国外（免信用卡，但墙 / 隐私需考量）
| 平台 | 免费方式 | 限速 | 备注 |
|---|---|---|---|
| Google AI Studio (Gemini) | Gemini Flash 系列 | ~15 RPM / 1500 RPD | 国内访问不稳；免费层可能用 prompt 训练⚠️ |
| Groq | Llama / Gemma / DeepSeek-R1-Distill | ~30 RPM | 极快、免卡 |
| NVIDIA NIM | DeepSeek / Llama 等 | ~40 RPM、无日上限 | 部分模型需手机验证 |
| OpenRouter | 聚合 200+ 模型 | ~200 请求/天 | 免卡、可切模型 |
| Cerebras | GPT-OSS 120B + GLM | ~100 万 tokens/天 | 免卡、快 |

## 四、接入步骤
1. 打开 `#/ai`，在「快速选择服务商」选一项（自动填 baseURL），或手动填 baseURL。
2. 粘贴该平台生成的 `apiKey`。
3. 填模型 id：`models.fast`（必填，默认模型）、`models.strong`（可选，更强模型）。
   - 模型 id 必须精确（大小写 / 斜杠都不能错），建议从平台模型列表页复制。
4. 点「测试连接」验证（后端返回延迟与样例）。
5. 点「保存配置」。

## 五、常见问题 / 坑
- **400 `model not found`**：模型 id 写错，去平台复制准确值。
- **429 `Too Many Requests`**：免费额度用尽或并发超限；可多备几个平台轮换。
- **隐私**：所有云端免费 API 都会看到你的 prompt。本项目 prompt 含简历等 PII，
  本地优先用户需知情；**不建议把简历隐私发到 Google 免费层**（可能用于训练）。
- **能力差异**：部分平台不支持 `stream` 流式或 `response_format=json`（JD 解析
  `parse-jd` 依赖 JSON 模式），接入前确认该模型是否支持。
- **限额**：免费额度普遍偏低，适合个人内测 / 原型，不适合高并发生产。
- **TopenRouter 的 `/v1` 与端口 8000 坑**：TopenRouter 的对话补全端点是
  `POST /v1/chat/completions`、模型列表是 `GET /v1/models`，而 CareerAgent 后端是
  `{baseUrl}/chat/completions` 与 `{baseUrl}/models` 拼接。因此 baseUrl 必须填
  `https://tp-api.chinadatapay.com:8000/v1`（**带 `/v1` 后缀、带端口 `8000`**），
  拼出来才是 `/v1/chat/completions` 与 `/v1/models`；漏掉 `/v1` 会拼成
  `/chat/completions` 导致 404。端口是合法的（服务端校验只取 hostname，不校验端口），
  但别在复制地址时把 `:8000` 弄丢。

## 六、针对本项目的推荐组合
- **主力免费**：硅基流动（综合最稳、免卡、国内直连、无数据留存）+ 智谱 `glm-4-flash`（中文免费主力、永久免）。
- **推理 / 代码**：DeepSeek（`deepseek-chat` / `deepseek-reasoner`，或硅基流动上的蒸馏版）。
- **不推荐**：把含 PII 的简历 prompt 发到 Google 免费层。
