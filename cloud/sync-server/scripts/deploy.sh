#!/usr/bin/env bash
#
# CareerAgent 同步服务端一键部署（Ubuntu / 任意 Linux x64，以部署用户身份运行）
#
# 前置：把 dist/ + package.json + .env.example + deploy.sh 已传到 $APP_DIR。
# 本脚本负责：装 Node 20+（若缺失/过旧）、装运行时依赖、生成自签名证书、写 .env、
# 注册 systemd 并启动。涉及 /etc 的 systemd 步骤用 sudo（密码从 $SUDO_PASS 读取）。
#
# 用法（在服务器上，以部署用户运行）：
#   SUDO_PASS='你的密码' APP_DIR=/home/ubuntu/ca-sync PORT=8443 bash deploy.sh
#
set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/ca-sync}"
PORT="${PORT:-8443}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
NODE_MAJOR=20
NODE_VERSION="v20.18.1"
NODE_DIST="node-${NODE_VERSION}-linux-x64"
SUDO_PASS="${SUDO_PASS:-}"

sudo_if_needed() {
  if [ "$(id -u)" = "0" ]; then
    "$@"
  else
    echo "$SUDO_PASS" | sudo -S "$@"
  fi
}

echo "==> [1/6] 检查并安装 Node ${NODE_MAJOR}+"
NODE_BIN="$(command -v node || true)"
if [ -n "$NODE_BIN" ]; then
  CUR=$(node -v | tr -d 'v' | cut -d. -f1)
  if [ "${CUR:-0}" -ge "$NODE_MAJOR" ]; then
    echo "    已存在 Node $(node -v) @ $NODE_BIN，跳过安装"
  else
    echo "    当前 Node $(node -v) 过旧，升级到 ${NODE_VERSION}"
    NEED_NODE=1
  fi
else
  echo "    未检测到 Node，安装 ${NODE_VERSION}"
  NEED_NODE=1
fi

if [ "${NEED_NODE:-0}" = "1" ]; then
  cd /tmp
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.xz" -o "${NODE_DIST}.tar.xz"
  tar -xf "${NODE_DIST}.tar.xz" -C /usr/local --strip-components=1
  rm -f "${NODE_DIST}.tar.xz"
  hash -r
  NODE_BIN="$(command -v node)"
  echo "    已安装 Node $(node -v) @ $NODE_BIN"
fi

echo "==> [2/6] 安装运行时依赖（仅 better-sqlite3）"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund

echo "==> [3/6] 生成自签名证书（客户端 insecureTls 接受，不校验 CN）"
mkdir -p "$APP_DIR/certs"
if [ ! -f "$APP_DIR/certs/cert.pem" ] || [ ! -f "$APP_DIR/certs/key.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$APP_DIR/certs/key.pem" \
    -out "$APP_DIR/certs/cert.pem" \
    -days 365 -subj "/CN=ca-sync-selfsigned"
  echo "    证书已生成（有效期 365 天）"
else
  echo "    证书已存在，复用"
fi

echo "==> [4/6] 写 .env"
cat > "$APP_DIR/.env" <<EOF
PORT=$PORT
DATA_DIR=$DATA_DIR
TLS_CERT_PATH=$APP_DIR/certs/cert.pem
TLS_KEY_PATH=$APP_DIR/certs/key.pem
EOF

echo "==> [5/6] 注册 systemd 服务（User=$(whoami)）"
UNIT=/etc/systemd/system/ca-sync.service
TMP_UNIT=/tmp/ca-sync.service
# 先以部署用户写临时文件，再 sudo cp，避免 sudo 吞掉 heredoc 管道。
cat > "$TMP_UNIT" <<EOF
[Unit]
Description=CareerAgent Sync Server
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$NODE_BIN $APP_DIR/dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo_if_needed cp "$TMP_UNIT" "$UNIT"
sudo_if_needed chmod 644 "$UNIT"

sudo_if_needed systemctl daemon-reload
sudo_if_needed systemctl enable ca-sync
sudo_if_needed systemctl restart ca-sync
sleep 2
sudo_if_needed systemctl status ca-sync --no-pager || true

echo "==> [6/6] 自检 health"
if command -v curl >/dev/null 2>&1; then
  curl -fsSk "https://127.0.0.1:${PORT}/v1/health" && echo "  ✅ 本地 health 正常" || echo "  ⚠️ health 检查失败，查看: sudo journalctl -u ca-sync -n 50"
else
  echo "    无 curl，手动验证：curl -k https://127.0.0.1:${PORT}/v1/health"
fi

echo "完成。请在腾讯云防火墙（安全组）放行 TCP $PORT；客户端 baseUrl=https://<公网IP>:$PORT，并开启 insecureTls。"
