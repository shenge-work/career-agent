-- 业务表同步语义改造：HLC 冲突时钟 / 软删除墓碑 / 冲突快照 / chat append-only。
--
-- 背景：0010 只解决了「写操作能被增量拉走」，但业务行仍是墙钟时间戳 + 物理删除 +
-- 整块 jsonb，两台设备同时编辑同一份简历时只能 last-write-wins 丢改动，且删除会
-- 在另一台设备上「僵尸复活」。本迁移把冲突地基补齐，全部在数据库层完成：
--   1. 12 张业务表统一加 hlc / device_id / deleted_at 三列（叠加，不删旧列，
--      savedAt / updatedAt 继续服务前端排序与展示，降级为「展示用墙钟」）；
--   2. BEFORE 触发器统一授时，应用代码零侵入（含 import:v1、直接 SQL、级联更新）；
--   3. 物理删除改为软删除墓碑（TenantDb 层读过滤 + UPDATE 设 deleted_at），
--      0010 的记账函数同步升级为「软删除也写 delete 事件」；
--   4. 跨设备回灌（app.sync_import='on'）时按 HLC + device_id 做 LWW，
--      无论谁胜都把落败方整行留进 conflict_snapshots，绝不静默丢改动；
--   5. tracker.payload.chat[] 由触发器投影成 append-only 事件流，将来可合并而非整块覆盖。
--
-- 时钟职责（务必分清，见 README）：
--   · change_log.hlc = 本地增量拉取游标（0010 的 change_log_cursor_seq，严格单调）；
--   · 业务行 hlc     = 跨设备 HLC 因果时钟（本迁移的 ca_hlc_state，可 observe 远端）；
--   · updatedAt/savedAt = 本机墙钟，仅用于 UI 展示与排序，绝不参与冲突判定。
-- 云端上线后应由服务端统一授时（把远端 hlc 通过 app.sync_import 回灌并 observe），
-- 本地 HLC 只保证「本机严格单调 + 已见远端之后」，不假装是全局时钟。
--
-- 不改造的表：users / sessions（账号与会话由云端账号体系单独设计）、
--   ai_usage / share_grants（本地统计与未接 API 的授权表）、
--   attachments / change_log / conflict_snapshots（已有自己的时钟与记账路径）。
-- 流水/快照/单例配置表（versions / application_events / settings / ai_configs）
--   同样加三列以统一审计，但语义上是「只增不删」：deleted_at 恒为 null，
--   TenantDb 的降采样与级联清理仍走物理删除，避免把历史快照变成软删垃圾。

-- ---------------------------------------------------------------- 1. 列
ALTER TABLE resumes
  ADD COLUMN IF NOT EXISTS hlc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_id text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE versions
  ADD COLUMN IF NOT EXISTS hlc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_id text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS hlc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_id text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE company_jds
  ADD COLUMN IF NOT EXISTS hlc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_id text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE tracker
  ADD COLUMN IF NOT EXISTS hlc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_id text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS hlc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_id text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE application_events
  ADD COLUMN IF NOT EXISTS hlc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_id text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE portfolios
  ADD COLUMN IF NOT EXISTS hlc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_id text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE interview_notes
  ADD COLUMN IF NOT EXISTS hlc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_id text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE interview_kb
  ADD COLUMN IF NOT EXISTS hlc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_id text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS hlc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_id text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS hlc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_id text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 活跃行部分索引：软删除后所有读查询都带 deleted_at IS NULL，避免墓碑拖慢列表。
CREATE INDEX IF NOT EXISTS resumes_active_idx ON resumes (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS companies_active_idx ON companies (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS company_jds_active_idx ON company_jds (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS tracker_active_idx ON tracker (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS applications_active_idx ON applications (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS portfolios_active_idx ON portfolios (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS interview_notes_active_idx ON interview_notes (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS interview_kb_active_idx ON interview_kb (user_id) WHERE deleted_at IS NULL;

-- ------------------------------------------------- 2. HLC 状态与统一授时
-- 单行状态表：UPDATE ... RETURNING 自带行锁，同一事务内多条写天然串行，
-- 因此同一毫秒的多条写拿到的是 .000000 / .000001 / ... 绝不重复或回退。
CREATE TABLE IF NOT EXISTS ca_hlc_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_ms bigint NOT NULL,
  counter integer NOT NULL
);
INSERT INTO ca_hlc_state (id, last_ms, counter) VALUES (1, 0, 0) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION ca_hlc_next() RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  wall bigint;
  r record;
BEGIN
  wall := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  UPDATE ca_hlc_state
    SET last_ms  = CASE WHEN wall > last_ms THEN wall ELSE last_ms END,
        counter  = CASE WHEN wall > last_ms THEN 0 ELSE counter + 1 END
    WHERE id = 1
    RETURNING last_ms, counter INTO r;
  RETURN lpad(r.last_ms::text, 13, '0') || '.' || lpad(r.counter::text, 6, '0');
END $$;

-- 收到远端 HLC 时推进本地时钟：后续本地写必定大于已见过的任何远端写。
CREATE OR REPLACE FUNCTION ca_hlc_observe(remote text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r_ms bigint;
  r_c integer;
BEGIN
  IF remote IS NULL OR remote !~ '^[0-9]{13}\.[0-9]{6}$' THEN RETURN; END IF;
  r_ms := split_part(remote, '.', 1)::bigint;
  r_c  := split_part(remote, '.', 2)::integer;
  UPDATE ca_hlc_state
    SET last_ms = greatest(last_ms, r_ms),
        counter = CASE
          WHEN r_ms > last_ms THEN r_c + 1
          WHEN r_ms = last_ms AND r_c >= counter THEN r_c + 1
          ELSE counter
        END
    WHERE id = 1;
END $$;

-- 快照绝不落敏感列（冲突快照将来会被 UI 读取、也可能被同步）。
CREATE OR REPLACE FUNCTION ca_safe_row_json(r jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT r - 'api_key' - 'password_hash' - 'token_hash' - 'ip' - 'user_agent';
$$;

-- ------------------------------------------------------------ 3. 冲突快照
-- 清单里写的「留 versions 快照」落地为独立表：现有 versions 表是用户手动版本历史，
-- 把自动冲突快照混进去会污染版本列表；独立表还能覆盖简历以外的全部实体。
CREATE TABLE IF NOT EXISTS conflict_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity text NOT NULL,
  entity_id text NOT NULL,
  resolution text NOT NULL CHECK (resolution IN ('remote_wins', 'local_wins')),
  winner_hlc text NOT NULL,
  loser_hlc text NOT NULL,
  loser_device_id text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conflict_snapshots_user_entity_idx
  ON conflict_snapshots (user_id, entity, entity_id, created_at DESC);

-- ------------------------------------------- 4. chat append-only 事实源
-- 现在 payload.chat[] 仍是整块 jsonb（前端与采集器零改动）；触发器把每条消息
-- 投影成不可变事件，按 (user, tracker, role+text+ts) 幂等去重。将来合并两份
-- 聊天记录时按事件集合取并集即可，不必让 LWW 把一边的对话整段吞掉。
CREATE TABLE IF NOT EXISTS tracker_chat_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tracker_id text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  message jsonb NOT NULL,
  hlc text NOT NULL,
  device_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracker_chat_events_user_tracker_idx
  ON tracker_chat_events (user_id, tracker_id, created_at);

-- ------------------------------------- 5. 业务行统一守卫（BEFORE 触发器）
-- 本地写：强制推进 hlc + 归因设备，应用代码不需要（也不允许）自己算时钟。
-- 回灌写（app.sync_import='on'）：保留远端 hlc / device_id，observe 后做 LWW；
--   跨设备且远端落败时 RETURN NULL 取消该行更新，落败方整行入快照。
-- 同一设备的重复回灌（幂等重试）不做冲突判定，直接覆盖。
CREATE OR REPLACE FUNCTION ca_business_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  importing text;
BEGIN
  importing := coalesce(current_setting('app.sync_import', true), '');

  IF importing = 'on' THEN
    IF NEW.hlc IS NULL OR NEW.hlc = '' THEN NEW.hlc := ca_hlc_next(); END IF;
    PERFORM ca_hlc_observe(NEW.hlc);
    IF TG_OP = 'UPDATE' AND OLD.device_id IS DISTINCT FROM NEW.device_id THEN
      IF NEW.hlc > OLD.hlc THEN
        INSERT INTO conflict_snapshots
          (user_id, entity, entity_id, resolution, winner_hlc, loser_hlc, loser_device_id, snapshot)
        VALUES
          (OLD.user_id, TG_TABLE_NAME, coalesce(to_jsonb(OLD)->>'id', TG_TABLE_NAME), 'remote_wins',
           NEW.hlc, OLD.hlc, OLD.device_id, ca_safe_row_json(to_jsonb(OLD)));
        RETURN NEW;
      ELSE
        INSERT INTO conflict_snapshots
          (user_id, entity, entity_id, resolution, winner_hlc, loser_hlc, loser_device_id, snapshot)
        VALUES
          (OLD.user_id, TG_TABLE_NAME, coalesce(to_jsonb(OLD)->>'id', TG_TABLE_NAME), 'local_wins',
           OLD.hlc, NEW.hlc, NEW.device_id, ca_safe_row_json(to_jsonb(NEW)));
        RETURN NULL;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  NEW.hlc := ca_hlc_next();
  NEW.device_id := coalesce(nullif(current_setting('app.device_id', true), ''), 'local');
  RETURN NEW;
END $$;

-- 显式列出 12 张表（与 0010 的记账触发器一一对应，便于审计）。
DROP TRIGGER IF EXISTS ca_business_row_guard ON resumes;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON resumes
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();
DROP TRIGGER IF EXISTS ca_business_row_guard ON versions;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON versions
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();
DROP TRIGGER IF EXISTS ca_business_row_guard ON companies;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();
DROP TRIGGER IF EXISTS ca_business_row_guard ON company_jds;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON company_jds
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();
DROP TRIGGER IF EXISTS ca_business_row_guard ON tracker;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON tracker
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();
DROP TRIGGER IF EXISTS ca_business_row_guard ON applications;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();
DROP TRIGGER IF EXISTS ca_business_row_guard ON application_events;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON application_events
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();
DROP TRIGGER IF EXISTS ca_business_row_guard ON portfolios;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON portfolios
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();
DROP TRIGGER IF EXISTS ca_business_row_guard ON interview_notes;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON interview_notes
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();
DROP TRIGGER IF EXISTS ca_business_row_guard ON interview_kb;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON interview_kb
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();
DROP TRIGGER IF EXISTS ca_business_row_guard ON settings;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();
DROP TRIGGER IF EXISTS ca_business_row_guard ON ai_configs;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON ai_configs
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();

-- 回填历史行：旧数据 hlc 为空串，不回填就没法参与 LWW。
-- 这里故意让 UPDATE 触发 BEFORE 守卫（自动领号）与 0010 记账（产生全量 upsert 增量）：
-- 首次接云本来就要做全量首传，把历史行标成待同步是正确的，不是副作用。
UPDATE resumes            SET hlc = '' WHERE hlc = '';
UPDATE versions           SET hlc = '' WHERE hlc = '';
UPDATE companies          SET hlc = '' WHERE hlc = '';
UPDATE company_jds        SET hlc = '' WHERE hlc = '';
UPDATE tracker            SET hlc = '' WHERE hlc = '';
UPDATE applications       SET hlc = '' WHERE hlc = '';
UPDATE application_events SET hlc = '' WHERE hlc = '';
UPDATE portfolios         SET hlc = '' WHERE hlc = '';
UPDATE interview_notes    SET hlc = '' WHERE hlc = '';
UPDATE interview_kb        SET hlc = '' WHERE hlc = '';
UPDATE settings           SET hlc = '' WHERE hlc = '';
UPDATE ai_configs         SET hlc = '' WHERE hlc = '';

-- ------------------------------------------- 6. 升级 0010 的增量记账
-- 两处变化：
--   a) 软删除（deleted_at: null → 非 null）视为 delete 墓碑事件，携带业务行 hlc，
--      让云端能用同一套 LWW 判定「删除 vs 编辑」；物理删除仍保留原分支（兼容
--      级联清理、降采样和既有测试直接 db.delete 的路径）。
--   b) 回灌期间不写 change_log，否则「云端推来的变更 → 本地又推回云端」形成回环。
--      change_log 的 BEFORE INSERT 触发器也会一并吞掉应用层 recordChange 的写入，
--      一处开关覆盖附件与全部业务表。
CREATE OR REPLACE FUNCTION ca_record_business_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rowj jsonb;
  oldj jsonb;
  uid uuid;
  eid text;
  v_op text;
  v_payload jsonb;
BEGIN
  IF coalesce(current_setting('app.sync_import', true), '') = 'on' THEN RETURN NULL; END IF;

  IF TG_OP = 'DELETE' THEN rowj := to_jsonb(OLD); ELSE rowj := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN oldj := to_jsonb(OLD); END IF;
  uid := (rowj->>'user_id')::uuid;
  IF uid IS NULL THEN RETURN NULL; END IF;

  -- 删除用户时 ON DELETE CASCADE 会先移除父行：此时再往 change_log 写会撞 FK，跳过。
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = uid) THEN RETURN NULL; END IF;

  eid := coalesce(rowj->>'id', TG_TABLE_NAME);
  v_op := CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END;
  -- 软删除：deleted_at 从 null 变为非 null，等价于一次 delete 事件。
  IF TG_OP = 'UPDATE'
     AND (oldj->>'deleted_at') IS NULL
     AND (rowj->>'deleted_at') IS NOT NULL THEN
    v_op := 'delete';
  END IF;

  v_payload := jsonb_build_object(
    'table', TG_TABLE_NAME, 'op', v_op, 'id', eid,
    'row_hlc', rowj->>'hlc', 'row_device_id', rowj->>'device_id'
  );
  IF v_op = 'delete' THEN
    v_payload := v_payload || jsonb_build_object('deleted_at', coalesce(rowj->>'deleted_at', now()::text));
  END IF;
  -- append-only 聊天事件：把消息本体直接带上，云端按 dedupe_key 取并集即可。
  IF TG_TABLE_NAME = 'tracker_chat_events' THEN
    v_payload := v_payload || jsonb_build_object(
      'tracker_id', rowj->>'tracker_id',
      'dedupe_key', rowj->>'dedupe_key',
      'message', rowj->'message'
    );
  END IF;

  INSERT INTO change_log (user_id, entity, entity_id, op, hlc, device_id, payload)
  VALUES (
    uid, TG_TABLE_NAME, eid, v_op, '',
    coalesce(nullif(current_setting('app.device_id', true), ''), 'local'),
    v_payload
  );
  RETURN NULL;
END $$;

-- 回灌期间吞掉 change_log 写入（BEFORE INSERT RETURN NULL = 取消该行插入）。
-- 0010 建的同名触发器仍指向本函数，无需重建。
CREATE OR REPLACE FUNCTION ca_change_log_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('app.sync_import', true), '') = 'on' THEN RETURN NULL; END IF;
  NEW.hlc := lpad(nextval('change_log_cursor_seq')::text, 13, '0') || '.000000';
  RETURN NEW;
END $$;

-- ------------------------------------- 7. chat 事件投影 + 事件记账
CREATE OR REPLACE FUNCTION ca_tracker_chat_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  arr jsonb;
  m jsonb;
  k text;
BEGIN
  arr := NEW.payload->'chat';
  IF jsonb_typeof(arr) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
  FOR m IN SELECT value FROM jsonb_array_elements(arr) LOOP
    k := md5(
      NEW.user_id::text || '|' || NEW.id || '|' ||
      coalesce(m->>'role', '') || '|' || coalesce(m->>'text', '') || '|' || coalesce(m->>'ts', '')
    );
    INSERT INTO tracker_chat_events (user_id, tracker_id, dedupe_key, message, hlc, device_id)
    VALUES (NEW.user_id, NEW.id, k, m, NEW.hlc, NEW.device_id)
    ON CONFLICT (dedupe_key) DO NOTHING;
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS ca_tracker_chat_events ON tracker;
CREATE TRIGGER ca_tracker_chat_events AFTER INSERT OR UPDATE ON tracker
  FOR EACH ROW EXECUTE FUNCTION ca_tracker_chat_events();

DROP TRIGGER IF EXISTS ca_business_change ON tracker_chat_events;
CREATE TRIGGER ca_business_change AFTER INSERT ON tracker_chat_events
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();
