-- 全业务表接入 change_log（本地 outbox），为「本地所有数据可上云」铺完整增量通道。
--
-- 背景：0009 只有附件模块在应用层显式记账；其余业务表（简历 / 岗位 / 公司 /
-- 投递 / 作品集 / 面经 / 设置…）仍是墙钟时间戳 + 物理删除，删除根本同步不出去。
--
-- 为什么用触发器而不是改 61 个 TenantDb 方法：
--   1. 触发器与业务写在【同一事务】，不会出现「行改了但增量没记」；
--   2. 对应用代码零侵入，现有查询语义、物理删除行为、209 个既有测试全部不变；
--   3. TenantDb.forUser 仍是唯一读写入口，将来做客户端加密 / Sync Engine 不用回改这里。
--
-- 游标职责分离（重要）：
--   · change_log.hlc 是【本地增量拉取游标】，由 change_log_cursor_seq 单一序列生成，
--     严格单调递增；同一毫秒内多条写若各自取墙钟会重复/回退，按 hlc > cursor 会漏记录。
--   · 业务行自己的 hlc（如 attachments.hlc）是应用层 HLC，用于跨设备 last-write-wins。
--     两者不是同一个东西：跨设备合并应由云端统一授时，不能拿本地游标当全局时钟。
--   · 将来 Sync Engine 回灌远端变更到 change_log 时，需要改用独立的 seq 列或禁用该触发器。
--
-- 不纳入同步的表：users / sessions（账号与会话由云端账号体系单独设计）、
--   attachments（0009 已在应用层同事务记账，避免双份）、ai_usage / share_grants /
--   sync_*（本地统计、未接 API 的授权表、已退役的飞书同步残留）。
-- 触发器 payload 只放轻量信号（table / op / id），绝不写整行：避免 api_key 等敏感列
--   落到会被 UI 读取、将来会被上传的 outbox 里，也避免 800ms 自动保存把 payload 撑爆。

CREATE SEQUENCE IF NOT EXISTS change_log_cursor_seq AS bigint;

-- 种子取「已有最大游标的毫秒段」与「当前墙钟毫秒」的较大值 +1，
-- 保证 0010 之后的新记录一定排在 0009 阶段已写入的记录之后。
SELECT setval(
  'change_log_cursor_seq',
  greatest(
    coalesce((SELECT max((split_part(hlc, '.', 1))::bigint) FROM change_log), 0),
    (extract(epoch from clock_timestamp()) * 1000)::bigint
  ) + 1,
  false
);

CREATE OR REPLACE FUNCTION ca_change_log_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.hlc := lpad(nextval('change_log_cursor_seq')::text, 13, '0') || '.000000';
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ca_change_log_cursor ON change_log;
CREATE TRIGGER ca_change_log_cursor
  BEFORE INSERT ON change_log
  FOR EACH ROW EXECUTE FUNCTION ca_change_log_cursor();

-- 业务表通用记账函数：INSERT/UPDATE → upsert，DELETE → delete（墓碑事件）。
CREATE OR REPLACE FUNCTION ca_record_business_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rowj jsonb;
  uid uuid;
  eid text;
  v_op text;
  v_payload jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN rowj := to_jsonb(OLD); ELSE rowj := to_jsonb(NEW); END IF;
  uid := (rowj->>'user_id')::uuid;
  IF uid IS NULL THEN RETURN NULL; END IF;

  -- 删除用户时 ON DELETE CASCADE 会先移除父行：此时再往 change_log 写会撞 FK，
  -- 直接跳过记账，保证「删账号」这种运维操作不被 outbox 卡住。
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = uid) THEN RETURN NULL; END IF;

  -- 无 id 列的表（settings / ai_configs）用表名作实体标识。
  eid := coalesce(rowj->>'id', TG_TABLE_NAME);
  v_op := CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END;
  v_payload := jsonb_build_object('table', TG_TABLE_NAME, 'op', v_op, 'id', eid);
  IF TG_OP = 'DELETE' THEN
    v_payload := v_payload || jsonb_build_object('deleted_at', now());
  END IF;

  -- hlc 传空占位，由 ca_change_log_cursor 统一改写；device_id 可由会话 GUC 覆盖，
  -- 默认 local（本地单机写入），接云时由 Sync Engine 补真实设备标识。
  INSERT INTO change_log (user_id, entity, entity_id, op, hlc, device_id, payload)
  VALUES (
    uid, TG_TABLE_NAME, eid, v_op, '',
    coalesce(nullif(current_setting('app.device_id', true), ''), 'local'),
    v_payload
  );
  RETURN NULL;
END $$;

-- 每张表独立建触发器（显式列出，便于审计；不用动态 DO 块）。
DROP TRIGGER IF EXISTS ca_business_change ON resumes;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON resumes
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();

DROP TRIGGER IF EXISTS ca_business_change ON versions;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON versions
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();

DROP TRIGGER IF EXISTS ca_business_change ON companies;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON companies
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();

DROP TRIGGER IF EXISTS ca_business_change ON company_jds;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON company_jds
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();

DROP TRIGGER IF EXISTS ca_business_change ON tracker;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON tracker
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();

DROP TRIGGER IF EXISTS ca_business_change ON applications;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON applications
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();

DROP TRIGGER IF EXISTS ca_business_change ON application_events;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON application_events
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();

DROP TRIGGER IF EXISTS ca_business_change ON portfolios;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON portfolios
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();

DROP TRIGGER IF EXISTS ca_business_change ON interview_notes;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON interview_notes
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();

DROP TRIGGER IF EXISTS ca_business_change ON interview_kb;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON interview_kb
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();

DROP TRIGGER IF EXISTS ca_business_change ON settings;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON settings
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();

DROP TRIGGER IF EXISTS ca_business_change ON ai_configs;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON ai_configs
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();
