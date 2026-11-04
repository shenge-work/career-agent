-- P2b · AI 转发层：按账号隔离的模型配置与用量统计
--
-- 旧版 ai.config.json 是服务级单份配置，多账号下无法各自填 Key，也无法
-- 知道某个账号用了多少次。这里拆成两张带 user_id 的表：
--   ai_configs：每账号一行；api_key 只留在服务端，GET 接口永不回传明文。
--   ai_usage  ：按 (user_id, day) 累计请求数/错误数，内测可观测。
-- 表名/列名/默认值与 schema.ts 一一对应，方言与真 PostgreSQL 一致。

CREATE TABLE IF NOT EXISTS ai_configs (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider    text        NOT NULL DEFAULT 'openai-compatible',
  base_url    text        NOT NULL,
  api_key     text        NOT NULL DEFAULT '',
  models      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  temperature real        NOT NULL DEFAULT 0.4,
  timeout_ms  integer     NOT NULL DEFAULT 60000,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_usage (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        text NOT NULL,
  requests   integer NOT NULL DEFAULT 0,
  errors     integer NOT NULL DEFAULT 0,
  last_at    timestamptz,
  last_model text,
  CONSTRAINT ai_usage_user_id_day_pk PRIMARY KEY (user_id, day)
);
