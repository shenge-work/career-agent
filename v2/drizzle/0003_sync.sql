-- P2b 第二期 · 飞书同步：凭证与状态全部按账号落库
--
-- v1 的三份本机文件（sync.config.json / sync.oauth.json / sync.state.json）是
-- 服务级单份状态，多账号下必然互相覆盖。v2 把它们拆成三张带 user_id 的表：
--   sync_configs：每账号一份「应用身份」配置（app_id/app_secret 及默认项）。
--                 app_secret 只留在服务端，任何 GET 接口都不回传明文（只给 hasSecret）。
--                 未配置时服务只读回退 v1 的 sync.config.json（老用户零配置过渡，
--                 一旦在本系统保存过配置即以 DB 为准）。
--   sync_oauth  ：扫码授权（OAuth 授权码模式）换来的用户身份凭证，
--                 access_token 过期用 refresh_token 惰性刷新（沿用 v1 语义）。
--                 有效期用 bigint 毫秒时间戳（与 v1 Date.now() 语义一致）。
--   sync_state  ：每份简历 × 认证模式的飞书锚点（document_id / file_token）。
--                 v1 用 stateKeyFor() 把 user 身份的键加 `_user` 后缀做分键隔离，
--                 这里直接落到不同的列 —— app 身份与 user 身份读写各自的文件，
--                 与 v1 的 authStateKey 契约等价。
-- 表名/列名与 schema.ts 一一对应，方言与真 PostgreSQL 一致。

CREATE TABLE IF NOT EXISTS sync_configs (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  app_id           text        NOT NULL DEFAULT '',
  app_secret       text        NOT NULL DEFAULT '',
  domain           text        NOT NULL DEFAULT '',
  folder_token     text        NOT NULL DEFAULT '',
  doc_title        text        NOT NULL DEFAULT '',
  file_name        text        NOT NULL DEFAULT '',
  file_upload_mode text        NOT NULL DEFAULT 'versioned',
  dry_run          boolean     NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_oauth (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token       text   NOT NULL,
  refresh_token      text   NOT NULL DEFAULT '',
  expires_at         bigint NOT NULL,
  refresh_expires_at bigint NOT NULL DEFAULT 0,
  scope              text   NOT NULL DEFAULT '',
  updated_at         bigint NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_state (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resume_id   text NOT NULL,
  -- 应用身份（tenant_access_token）的锚点
  document_id text NOT NULL DEFAULT '',
  file_token  text NOT NULL DEFAULT '',
  -- 扫码授权用户身份（user_access_token）的锚点：两套身份的云盘命名空间互不相通
  user_document_id text NOT NULL DEFAULT '',
  user_file_token   text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_state_user_id_resume_id_pk PRIMARY KEY (user_id, resume_id)
);
