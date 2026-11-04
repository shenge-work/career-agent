-- P2b 二期拆除：飞书远程存储随 v1 退役一并移除
--
-- 数据已全部本地化到 PostgreSQL（简历/版本历史/公司/投递都在库里），
-- 「上报到飞书云盘借其版本历史」的外部同步链路不再需要：三张表全部拆除。
-- 版本能力由 versions 表（N11 本地版本历史）承接，见业务模块版本端点。
--
-- 0003_sync.sql 保留为历史迁移（已应用到既有库），本迁移负责拆除。

DROP TABLE IF EXISTS sync_state;
DROP TABLE IF EXISTS sync_oauth;
DROP TABLE IF EXISTS sync_configs;
