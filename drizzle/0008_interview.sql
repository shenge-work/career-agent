-- N12 S2 · 面试复盘 + 面经知识库
--
-- 定位：补齐「求职旅程」里面试环节的事实沉淀与「RAG 知识沉淀」的落点。
--   · interview_notes：一次面试 = 一轮复盘，挂 applications 聚合根，
--     让「岗位 → 面试 → 复盘 → 改进」有单一血缘；AI 复盘结果写 payload.aiReview。
--   · interview_kb ：面经/面试题/技巧知识库，供 kb-ask 动作做本地检索
--     （关键词 + 全文），让大模型只引用用户自己的知识库回答。
--
-- 设计要点：
--   1. 主键 (user_id, id) 沿用项目铁律；id 由服务端生成（in_ / kb_ 前缀）。
--   2. 两表均带 user_id 物理隔离，检索/查询一律经 TenantDb.forUser。
--   3. 内容独立维护，不强制关联 company/resume 表（company/position 为快照冗余）。

CREATE TABLE IF NOT EXISTS interview_notes (
  id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id text,
  company text,
  position text,
  round text,
  interview_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interview_notes_user_id_id_pk PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS interview_notes_user_app_idx ON interview_notes(user_id, application_id);

CREATE TABLE IF NOT EXISTS interview_kb (
  id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  category text,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interview_kb_user_id_id_pk PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS interview_kb_user_cat_idx ON interview_kb(user_id, category);
