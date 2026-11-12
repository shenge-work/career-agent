-- P0-6 · AI 用量明细事件表（按次 append-only，供厂商/模型对账）
--
-- 背景：ai_usage 主键是 (user_id, day)，同一天不同 provider/model 的调用会挤进同一行，
-- provider/model/token 等维度字段被后一次调用覆盖、token 不累加，无法按厂商/模型对账。
-- 本表每行 = 一次 AI 调用（含探活），append-only、永不更新，是「对账」的权威事实源；
-- ai_usage 继续按天聚合、供 7 天趋势图使用，二者互补、不互相替代。
--
-- 隐私铁律：只落元数据，绝不落 prompt 与响应正文。token 数只在能从上/下游拿到时记录。

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text,
  model text,
  action text,
  status text,
  error_code text,
  latency_ms integer,
  prompt_tokens integer,
  completion_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 对账主查询：按账号 + 时间范围扫描（明细最近写入，按时间倒序）。
CREATE INDEX IF NOT EXISTS ai_usage_events_user_time_idx
  ON ai_usage_events (user_id, created_at DESC);

-- 按厂商聚合对账。
CREATE INDEX IF NOT EXISTS ai_usage_events_user_provider_idx
  ON ai_usage_events (user_id, provider);

-- 按模型聚合对账。
CREATE INDEX IF NOT EXISTS ai_usage_events_user_model_idx
  ON ai_usage_events (user_id, model);
