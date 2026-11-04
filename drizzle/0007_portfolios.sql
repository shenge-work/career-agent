-- N13 · 个人作品集站点（portfolios）
--
-- 定位：把「个人作品集官网」纳入 CareerAgent，做成「模板化 + 数据驱动 + 一键生成 + 一键发布」的闭环。
--   一次配置，可反复生成静态站 / 反复发布到 GitHub Pages（用户站点 <username>.github.io）。
--
-- 设计要点：
--   1. 主键 (user_id, id) 沿用项目铁律；id 由服务端生成（pf_ 前缀）。
--   2. 内容独立维护（不复用简历数据，用户明确要求），payload 承载作品集专属内容。
--   3. template_id 只存引用，模板定义在代码内置模板库（src/server/portfolio/templates/）。
--   4. deploy 为 jsonb 可空，承载发布配置（仓库/分支/发布时间/URL），未发布前为 NULL。

CREATE TABLE IF NOT EXISTS portfolios (
  id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  template_id text NOT NULL,
  layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  deploy jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portfolios_user_id_id_pk PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS portfolios_user_idx ON portfolios(user_id);
