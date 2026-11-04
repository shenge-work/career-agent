-- P0 · 岗位/申请聚合根（applications + application_events）
--
-- 定位跃迁「简历工具 → 个人求职 Agent 工作台」的数据基座：
--   一个 application = 一次求职的完整旅程（JD + 公司 + 简历 + 投递状态 + 面试阶段）。
--   把原先散落在 resumes.parentId/job_id、tracker.company_id/payload.status 的血缘收拢到单一实体。
--
-- 设计要点：
--   1. 主键 (user_id, id) 沿用项目铁律；id 由客户端/服务端生成（app_* 前缀），跨用户可能重复。
--   2. tracker 保留不动（BOSS 聊天采集 + IM 事实源），通过 tracker_id 关联；
--      collect 采集链路零改动。
--   3. application_events 是状态流水，tracker 历史状态在下方回填，保证时间线完整。
--   4. resumes.job_id 语义平滑升级：派生简历的 job_id 由「游离文本」改为指向 applications.id，
--      历史数据不做强制改写（旧 job_id 仍可读，仅新派生流程写 application id）。

CREATE TABLE IF NOT EXISTS applications (
  id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position text NOT NULL,
  company_id text,
  jd_id text,
  resume_id text,
  tracker_id text,
  status text NOT NULL DEFAULT 'interested',
  stage text,
  applied_at timestamptz,
  follow_up_after_days integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT applications_user_id_id_pk PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS applications_user_status_idx ON applications(user_id, status);
CREATE INDEX IF NOT EXISTS applications_user_company_idx ON applications(user_id, company_id);

CREATE TABLE IF NOT EXISTS application_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_events_user_app_idx ON application_events(user_id, application_id);

-- 回填：为每条已存在的投递记录（tracker）生成一条 application，并写一条状态事件。
-- status 归一化：tracker.payload 里若带 status 则沿用，否则按投递记录存在即视为 applied。
INSERT INTO applications (
  id, user_id, position, company_id, jd_id, resume_id, tracker_id,
  status, stage, applied_at, payload, created_at, updated_at
)
SELECT
  'app_' || substr(md5(t.id || ':' || t.user_id::text), 1, 16),
  t.user_id,
  COALESCE(t.payload ->> 'position', t.payload ->> 'title', '未命名岗位'),
  t.company_id,
  t.payload ->> 'jdId',
  t.payload ->> 'resumeId',
  t.id,
  CASE
    WHEN t.payload ->> 'status' IN ('interviewing','offered','rejected','withdrawn','interested','applied')
      THEN t.payload ->> 'status'
    ELSE 'applied'
  END,
  t.payload ->> 'stage',
  t.created_at,
  t.payload,
  t.created_at,
  t.updated_at
FROM tracker t
ON CONFLICT DO NOTHING;

-- 为回填的 application 写一条初始状态事件（from_status 为空表示「旅程起点」）。
INSERT INTO application_events (user_id, application_id, from_status, to_status, created_at)
SELECT
  a.user_id,
  a.id,
  NULL,
  a.status,
  a.applied_at
FROM applications a
ON CONFLICT DO NOTHING;
