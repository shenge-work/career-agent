-- 本地对象存储（local-first）+ 同步 outbox
--
-- 定位：附件字节落 <dataRoot>/blobs/sha256/<前2>/<后62>，PG 只存元数据与归属。
-- 与 schema.ts 的 attachments / change_log 一一对应，DDL 方言与真 PostgreSQL 一致。
--
-- 设计要点：
--   1. 主键 (user_id, id) 沿用项目铁律；查询一律经 TenantDb.forUser，跨用户 404。
--   2. sha256 既是本地 blob 路径，也是未来云端 object key —— 接云时零映射、天然去重。
--   3. hlc（逻辑时钟，定长字典序可比）+ device_id 替代会漂移的墙钟做冲突判定。
--   4. deleted_at 是软删除墓碑；删除也要写 change_log(op='delete')，否则跨设备会僵尸复活。
--   5. 这不是 pgDump/WAL 物理复制：PGlite 的 pgdata 无法被原生 PG 打开，
--      云端同步必须走 change_log 这条应用级逻辑增量通道。

CREATE TABLE IF NOT EXISTS attachments (
  id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256 text NOT NULL,
  mime text NOT NULL,
  bytes bigint NOT NULL,
  original_name text NOT NULL,
  owner_type text,
  owner_id text,
  sync_state text NOT NULL DEFAULT 'local',
  remote_key text,
  hlc text NOT NULL,
  device_id text NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachments_user_id_id_pk PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS attachments_user_sha_idx ON attachments(user_id, sha256);
CREATE INDEX IF NOT EXISTS attachments_user_hlc_idx ON attachments(user_id, hlc);
CREATE INDEX IF NOT EXISTS attachments_user_owner_idx ON attachments(user_id, owner_type, owner_id);

CREATE TABLE IF NOT EXISTS change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity text NOT NULL,
  entity_id text NOT NULL,
  op text NOT NULL,
  hlc text NOT NULL,
  device_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS change_log_user_hlc_idx ON change_log(user_id, hlc);
