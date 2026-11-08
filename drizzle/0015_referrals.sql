-- 内推信息（Referral）：统一的内推资源池，公司与内推人一一挂账。
--
-- 设计取舍：
--   · 与 companies / company_jds 保持一致，用 text id + jsonb payload，不额外开列；
--   · company_id 不加外键（companies 主键是 (user_id, id) 复合键），删除公司时
--     由 BusinessService 显式级联软删除，内推记录不会因为公司档案被删而变成孤儿外键错误；
--   · 同步三元组 hlc / device_id / deleted_at 与 0011 完全一致，触发器统一授时，
--     应用层不写时钟；软删除走 deleted_at，读查询经 TenantDb active() 过滤。
--
-- 触发器等价的既有函数（0010 的 ca_record_business_change / 0011 的 ca_business_row_guard）
-- 在这里直接复用，只为新表挂载，不重复定义函数体。

CREATE TABLE IF NOT EXISTS referrals (
  id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  hlc text NOT NULL DEFAULT '',
  device_id text NOT NULL DEFAULT 'local',
  deleted_at timestamptz,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS referrals_user_idx ON referrals (user_id);
CREATE INDEX IF NOT EXISTS referrals_user_company_idx ON referrals (user_id, company_id);
-- 活跃行部分索引：软删除后列表查询一律带 deleted_at IS NULL。
CREATE INDEX IF NOT EXISTS referrals_active_idx ON referrals (user_id) WHERE deleted_at IS NULL;

-- 统一授时 / 回灌 LWW 守卫（与 0011 的 12 张业务表同一函数）。
DROP TRIGGER IF EXISTS ca_business_row_guard ON referrals;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON referrals
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();

-- 增量记账（change_log）：软删除写 delete 墓碑，回灌期间自动吞掉。
DROP TRIGGER IF EXISTS ca_business_change ON referrals;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON referrals
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();

-- 说明：本迁移不动 companies 表。招聘官网链接是 payload 上的新字段 careersUrl，
-- jsonb 天然免迁移；公司详情页直接读写 payload，旧数据零影响。
