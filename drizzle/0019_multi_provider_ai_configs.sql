-- P0-6 · ai_configs 多厂商并存
--
-- 目标：一个账号可配置多个 AI 厂商，每个厂商独立一套 baseUrl/apiKey/models/
-- temperature/timeoutMs，并有一个「当前生效」厂商（is_active = true）。
--
-- 变更点：
--   1. 主键由 (user_id) 升级为 (user_id, provider)：provider 现有列是
--      text NOT NULL DEFAULT 'openai-compatible'，无 NULL，改复合主键安全。
--   2. 新增 is_active 布尔列，默认 false。
--   3. 回填现有「有效配置」行（base_url <> '' AND api_key <> ''）为生效。
--   4. 单一生效约束：每个 user_id 至多一行 is_active = true（部分唯一索引）。
--
-- 已知可接受边界：0010/0011 的业务触发器仍以表名作为 ai_configs 的 entity_id，
-- 多厂商共享同一 entity_id；本地单用户场景下不影响正确性，不做同步触发器改造。

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_pkey;
ALTER TABLE ai_configs ADD PRIMARY KEY (user_id, provider);

ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false;

UPDATE ai_configs SET is_active = true WHERE base_url <> '' AND api_key <> '';

CREATE UNIQUE INDEX IF NOT EXISTS ai_configs_one_active_idx
  ON ai_configs (user_id) WHERE is_active;
