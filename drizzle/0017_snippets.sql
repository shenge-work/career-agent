-- STAR 经历素材库（Snippet）：跨简历复用的经历片段。
--
-- 设计取舍（N15）：
--   · 与 companies / referrals 等实体表一致，text id + (user_id, id) 复合主键；
--   · 显式列承载 STAR 四要素 + 标题 / 分类 / 标签，均为结构固定且高频检索字段，
--     比落 jsonb 更清晰、可索引；
--   · 同步三元组 hlc / device_id / deleted_at 与 0011 完全一致，触发器统一授时，
--     应用层不写时钟；软删除走 deleted_at，读查询经 TenantDb active() 过滤。
--
-- 触发器等价的既有函数（0010 的 ca_record_business_change / 0011 的 ca_business_row_guard）
-- 在这里直接复用，只为新表挂载，不重复定义函数体（照 0015_referrals.sql 模板）。

CREATE TABLE IF NOT EXISTS snippets (
  id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  category text,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  situation text,
  task text,
  action text,
  result text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  hlc text NOT NULL DEFAULT '',
  device_id text NOT NULL DEFAULT 'local',
  deleted_at timestamptz,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS snippets_user_idx ON snippets (user_id);
CREATE INDEX IF NOT EXISTS snippets_user_cat_idx ON snippets (user_id, category);
-- 活跃行部分索引：软删除后列表查询一律带 deleted_at IS NULL。
CREATE INDEX IF NOT EXISTS snippets_active_idx ON snippets (user_id) WHERE deleted_at IS NULL;

-- 统一授时 / 回灌 LWW 守卫（与 0011 的业务表同一函数）。
DROP TRIGGER IF EXISTS ca_business_row_guard ON snippets;
CREATE TRIGGER ca_business_row_guard BEFORE INSERT OR UPDATE ON snippets
  FOR EACH ROW EXECUTE FUNCTION ca_business_row_guard();

-- 增量记账（change_log）：软删除写 delete 墓碑，回灌期间自动吞掉。
DROP TRIGGER IF EXISTS ca_business_change ON snippets;
CREATE TRIGGER ca_business_change AFTER INSERT OR UPDATE OR DELETE ON snippets
  FOR EACH ROW EXECUTE FUNCTION ca_record_business_change();
