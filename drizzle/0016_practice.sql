-- AI 面试练习（Practice）：会话 / 题目 / 回答 / 评分 / 弱项 5 张业务表。
--
-- 设计取舍（N14）：
--   · 与 companies / applications 等实体表一致，text id + jsonb 承载可变结构；
--     id 前缀 ps_/pq_/pa_/pe_/pw_，主键一律 (user_id, id) 复合键；
--   · application_id / resume_id / question_id / answer_id / interview_note_id 均只读引用，
--     不加外键（关联表的复合主键使 FK 无法指向单列，删除时也不应产生孤儿外键错误）；
--   · 回答与评分「只增不改」是产品语义（无编辑入口），不是 DB 层不可变：
--     草稿提交 / 评分重试 / 校准标注都是合法 UPDATE，因此 5 表全部按可变实体表接入云同步；
--   · 同步三元组 hlc / device_id / deleted_at 与 0011 完全一致，触发器统一授时，
--     应用层不写时钟；软删除走 deleted_at，读查询经 TenantDb active() 过滤。
--
-- 触发器等价的既有函数（0010 的 ca_record_business_change / 0011 的 ca_business_row_guard）
-- 在这里直接复用，只为新表挂载，不重复定义函数体（照 0015_referrals.sql 模板）。

CREATE TABLE IF NOT EXISTS practice_sessions (
  id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'configuring',
  application_id text,
  resume_id text,
  goal jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_question_order integer NOT NULL DEFAULT 0,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  hlc text NOT NULL DEFAULT '',
  device_id text NOT NULL DEFAULT 'local',
  deleted_at timestamptz,
  PRIMARY KEY (user_id, id),
  CONSTRAINT practice_sessions_status_check CHECK (status IN ('configuring', 'active', 'paused', 'completed'))
);

CREATE TABLE IF NOT EXISTS practice_questions (
  id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  "order" integer NOT NULL DEFAULT 0,
  question_key text NOT NULL,
  question text NOT NULL,
  type text NOT NULL,
  dimension text,
  difficulty text NOT NULL DEFAULT 'standard',
  basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_follow_ups integer NOT NULL DEFAULT 2,
  skipped boolean NOT NULL DEFAULT false,
  regenerated_from text,
  weakness_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  hlc text NOT NULL DEFAULT '',
  device_id text NOT NULL DEFAULT 'local',
  deleted_at timestamptz,
  PRIMARY KEY (user_id, id),
  CONSTRAINT practice_questions_type_check CHECK (type IN ('behavioral', 'project', 'hr', 'system_design')),
  CONSTRAINT practice_questions_difficulty_check CHECK (difficulty IN ('standard', 'easy', 'hard'))
);

CREATE TABLE IF NOT EXISTS practice_answers (
  id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  question_id text NOT NULL,
  turn integer NOT NULL DEFAULT 0,
  prompt text NOT NULL,
  answer text NOT NULL DEFAULT '',
  is_draft boolean NOT NULL DEFAULT true,
  word_count integer NOT NULL DEFAULT 0,
  para_count integer NOT NULL DEFAULT 0,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  hlc text NOT NULL DEFAULT '',
  device_id text NOT NULL DEFAULT 'local',
  deleted_at timestamptz,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS practice_evaluations (
  id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer_id text NOT NULL,
  question_id text NOT NULL,
  source text NOT NULL DEFAULT 'ai',
  status text NOT NULL DEFAULT 'generated',
  rubric_version text NOT NULL,
  prompt_version text NOT NULL,
  model_id text,
  dimensions jsonb NOT NULL DEFAULT '[]'::jsonb,
  strengths jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  sample_answer text,
  summary text,
  include_in_profile boolean NOT NULL DEFAULT false,
  calibration jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  hlc text NOT NULL DEFAULT '',
  device_id text NOT NULL DEFAULT 'local',
  deleted_at timestamptz,
  PRIMARY KEY (user_id, id),
  CONSTRAINT practice_evaluations_source_check CHECK (source IN ('ai', 'self')),
  CONSTRAINT practice_evaluations_status_check CHECK (status IN ('generated', 'pending_retry', 'not_generated'))
);

CREATE TABLE IF NOT EXISTS practice_weaknesses (
  id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL,
  dimension text,
  question_id text,
  interview_note_id text,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  last_practice_at timestamptz,
  last_level integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  hlc text NOT NULL DEFAULT '',
  device_id text NOT NULL DEFAULT 'local',
  deleted_at timestamptz,
  PRIMARY KEY (user_id, id),
  CONSTRAINT practice_weaknesses_source_check CHECK (source IN ('dimension', 'question', 'interview_note')),
  CONSTRAINT practice_weaknesses_status_check CHECK (status IN ('pending', 'practiced', 'resolved'))
);

-- 常用查询索引。
CREATE INDEX IF NOT EXISTS practice_sessions_user_idx ON practice_sessions (user_id);
CREATE INDEX IF NOT EXISTS practice_sessions_user_status_idx ON practice_sessions (user_id, status);

CREATE INDEX IF NOT EXISTS practice_questions_user_session_order_idx ON practice_questions (user_id, session_id, "order");
CREATE INDEX IF NOT EXISTS practice_questions_user_key_idx ON practice_questions (user_id, question_key);

CREATE INDEX IF NOT EXISTS practice_answers_user_question_turn_idx ON practice_answers (user_id, question_id, turn);
CREATE INDEX IF NOT EXISTS practice_answers_user_session_question_idx ON practice_answers (user_id, session_id, question_id);

CREATE INDEX IF NOT EXISTS practice_evaluations_user_answer_idx ON practice_evaluations (user_id, answer_id);
CREATE INDEX IF NOT EXISTS practice_evaluations_user_question_idx ON practice_evaluations (user_id, question_id);
CREATE INDEX IF NOT EXISTS practice_evaluations_user_rubric_idx ON practice_evaluations (user_id, rubric_version, created_at);

CREATE INDEX IF NOT EXISTS practice_weaknesses_user_status_idx ON practice_weaknesses (user_id, status);
CREATE INDEX IF NOT EXISTS practice_weaknesses_user_dim_status_idx ON practice_weaknesses (user_id, dimension, status);

-- 活跃行部分索引：软删除后列表查询一律带 deleted_at IS NULL。
CREATE INDEX IF NOT EXISTS practice_sessions_active_idx ON practice_sessions (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS practice_questions_active_idx ON practice_questions (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS practice_answers_active_idx ON practice_answers (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS practice_evaluations_active_idx ON practice_evaluations (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS practice_weaknesses_active_idx ON practice_weaknesses (user_id) WHERE deleted_at IS NULL;

-- 统一授时 / 回灌 LWW 守卫（与 0011 的业务表同一函数）。
DROP TRIGGER IF EXISTS ca_business_row_guard ON practice_sessions;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON practice_sessions
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();
DROP TRIGGER IF EXISTS ca_business_row_guard ON practice_questions;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON practice_questions
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();
DROP TRIGGER IF EXISTS ca_business_row_guard ON practice_answers;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON practice_answers
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();
DROP TRIGGER IF EXISTS ca_business_row_guard ON practice_evaluations;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON practice_evaluations
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();
DROP TRIGGER IF EXISTS ca_business_row_guard ON practice_weaknesses;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON practice_weaknesses
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();

-- 增量记账（change_log）：软删除写 delete 墓碑，回灌期间自动吞掉。
DROP TRIGGER IF EXISTS ca_business_change ON practice_sessions;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON practice_sessions
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();
DROP TRIGGER IF EXISTS ca_business_change ON practice_questions;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON practice_questions
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();
DROP TRIGGER IF EXISTS ca_business_change ON practice_answers;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON practice_answers
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();
DROP TRIGGER IF EXISTS ca_business_change ON practice_evaluations;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON practice_evaluations
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();
DROP TRIGGER IF EXISTS ca_business_change ON practice_weaknesses;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON practice_weaknesses
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();
