-- P0-5 · ai_usage 观测字段扩展
--
-- requests/errors 仍按 (user_id, day) 聚合；新增列记录「当日最近一次调用」的
-- 维度元数据（provider/action/status/error_code/latency_ms/prompt_tokens/
-- completion_tokens），与 last_model 的语义一致，只在 on conflict 时覆盖为最新值。
--
-- 隐私铁律：只落元数据，绝不落 prompt 与响应正文。

ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS action text;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS latency_ms integer;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS prompt_tokens integer;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS completion_tokens integer;
