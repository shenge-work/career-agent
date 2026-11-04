-- P1 · 数据层加固：业务表主键由 (id) 改为 (user_id, id)
--
-- 起因：v1 迁移进来的 id 全部由客户端生成（res_* / co_* / jd_*），
-- 多用户下不同账号完全可能持有同一个 id。若沿用单列主键，A 用户的导入
-- 会覆盖或撞上 B 用户的数据 —— 这是行级隔离的一个真实缺口。
-- 复合主键与 TenantDb.forUser「所有查询必带 user_id」构成同一套隔离语义。
--
-- 约束名与 drizzle-kit generate 的输出保持一致（见 drizzle/generated/0001_*.sql），
-- 便于后续继续用 generate 校验 schema 漂移。

ALTER TABLE resumes ALTER COLUMN id SET NOT NULL;
ALTER TABLE resumes DROP CONSTRAINT IF EXISTS resumes_pkey;
ALTER TABLE resumes ADD CONSTRAINT resumes_user_id_id_pk PRIMARY KEY (user_id, id);

ALTER TABLE companies ALTER COLUMN id SET NOT NULL;
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_pkey;
ALTER TABLE companies ADD CONSTRAINT companies_user_id_id_pk PRIMARY KEY (user_id, id);

ALTER TABLE company_jds ALTER COLUMN id SET NOT NULL;
ALTER TABLE company_jds DROP CONSTRAINT IF EXISTS company_jds_pkey;
ALTER TABLE company_jds ADD CONSTRAINT company_jds_user_id_id_pk PRIMARY KEY (user_id, id);

ALTER TABLE tracker ALTER COLUMN id SET NOT NULL;
ALTER TABLE tracker DROP CONSTRAINT IF EXISTS tracker_pkey;
ALTER TABLE tracker ADD CONSTRAINT tracker_user_id_id_pk PRIMARY KEY (user_id, id);
