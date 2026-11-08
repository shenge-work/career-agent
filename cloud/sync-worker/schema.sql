-- CareerAgent 同步云端 D1 schema（哑云：只有授权哈希与密文事件流，没有业务表）
-- 应用：wrangler d1 execute career-agent-sync --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS vaults (
  vault_id    TEXT PRIMARY KEY,          -- 由恢复码 HKDF 派生的 32 位 hex
  auth_hash   TEXT NOT NULL,             -- sha256(authKey)；authKey 只在 TLS 请求头出现
  salt        TEXT NOT NULL,             -- 可公开：另一台设备加入时核对，恢复码本身也能派生
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  vault_id      TEXT NOT NULL REFERENCES vaults(vault_id),
  device_id     TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  PRIMARY KEY (vault_id, device_id)
);

-- 事件只追加；主键 (vault_id, seq) 同时承担 CAS 并发冲突检测
CREATE TABLE IF NOT EXISTS events (
  vault_id    TEXT NOT NULL REFERENCES vaults(vault_id),
  seq         TEXT NOT NULL,             -- 20 位定长十进制，字典序 = 数值序
  device_id   TEXT NOT NULL,
  aad         TEXT NOT NULL,             -- 明文路由信息（vault/device/batch/index/时间）
  nonce       TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,            -- AES-256-GCM 密文 base64，云端永不解密
  bytes       INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (vault_id, seq)
);

-- blob 实体在 R2，key = v1/<vaultId>/blobs/<64位hex objectKey>；
-- D1 不记 blob 索引，引用计数 GC 留到 Sync Engine 阶段再做。
