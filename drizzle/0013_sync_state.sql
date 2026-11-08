-- 同步状态表：local-first 的本地游标 + E2EE 密钥柜（云端是哑管道，游标必须本地记）。
--
-- 云端只认 seq、只存密文，根本不知道「本地推到哪了 / 拉到哪了」；这两个游标必须由本地持久化。
-- 同时把派生的 E2EE 密钥（base64）落本机：同机重启后无需重新手抄恢复码即可继续同步；
-- 恢复码本身绝不落库（scrypt 单向，换设备加入仍需手抄）。
--
-- 同步范围：8 张可变实体表（resumes / companies / company_jds / tracker / applications /
--   portfolios / interview_notes / interview_kb）+ attachments；versions / application_events /
--   settings / ai_configs 暂不同步，其 change_log 增量会被游标直接跳过。
--
-- pushed_cursor 空串 = 尚未做过基线全量首传（首次启用时把当前全部活跃行推上去）。

CREATE TABLE IF NOT EXISTS sync_state (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vault_id     text NOT NULL,
  device_id    text NOT NULL,
  pushed_cursor text NOT NULL DEFAULT '',
  pulled_seq   text NOT NULL DEFAULT '00000000000000000000',
  keys_json    jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'idle',
  last_error   text,
  last_sync_at timestamptz,
  known_blobs  jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sync_state
  ADD CONSTRAINT sync_state_status_check
  CHECK (status IN ('idle', 'syncing', 'error', 'disabled'));
