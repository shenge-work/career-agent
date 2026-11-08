-- 冲突恢复 UI 的数据库支撑：把 0011 的「只增快照」升级成可处理的状态机。
--
-- 0011 只负责留底：LWW 判输的一方整行进 conflict_snapshots，但没有任何「用户已处理」
-- 的痕迹。恢复 UI 需要区分待处理 / 已恢复 / 已忽略，并且恢复时必须把「当前版本」
-- 再留一条底 —— 否则人工恢复本身又会变成一次静默覆盖。
--
-- 三条铁律（由 src/server/sync/restore.ts 与 TenantDb 共同保证，DB 只管结构）：
--   1. 恢复不是「把旧 hlc/device_id 写回去」（那会回拨因果时钟，云端会拒收），
--      而是一次全新的本地写：BEFORE 守卫重新领 HLC、归因本机、写 change_log；
--   2. 恢复前先给当前行留一条 resolution='restore' 的 pending 快照，
--      来回恢复可以无限次，任何一版都不会丢；
--   3. 快照状态只在本表内流转，不进 change_log、不进同步流（纯本地审计数据）。
--
-- 敏感列仍由 0011 的 ca_safe_row_json 在写入时剔除，本迁移不触碰。

ALTER TABLE conflict_snapshots
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS restored_from uuid;

-- resolution 增加 'restore'：人工恢复时被替换掉的「当前版本」留底。
-- 0011 建的是列级匿名 CHECK，名字由 PG 自动派生；按定义动态找出来再替换，
-- 避免不同 PG 版本自动命名差异导致漏删。
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'conflict_snapshots'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%resolution%'
  LOOP
    EXECUTE format('ALTER TABLE conflict_snapshots DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE conflict_snapshots
  ADD CONSTRAINT conflict_snapshots_resolution_check
  CHECK (resolution IN ('remote_wins', 'local_wins', 'restore'));

ALTER TABLE conflict_snapshots
  DROP CONSTRAINT IF EXISTS conflict_snapshots_status_check;
ALTER TABLE conflict_snapshots
  ADD CONSTRAINT conflict_snapshots_status_check
  CHECK (status IN ('pending', 'restored', 'dismissed'));

CREATE INDEX IF NOT EXISTS conflict_snapshots_user_status_idx
  ON conflict_snapshots (user_id, status, created_at DESC);
