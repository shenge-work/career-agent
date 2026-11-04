#!/usr/bin/env bash
# start-chrome-debug.sh
# 用「你已登录 BOSS 直聘的 Chrome 默认档案」开启远程调试端口，供投递板块「从 BOSS 直聘采集」使用。
# 用法：先完全退出 Chrome（Cmd+Q），再执行： bash tools/start-chrome-debug.sh
set -e

PORT="${CDP_PORT:-9222}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ ! -x "$CHROME" ]; then
  echo "未找到 Google Chrome（$CHROME）。"
  exit 1
fi

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已在监听 —— 可直接在投递板块点「从 BOSS 直聘采集」。"
  exit 0
fi

if pgrep -x "Google Chrome" >/dev/null 2>&1; then
  echo "检测到 Chrome 正在运行。"
  echo "请先『完全退出 Chrome』（Cmd+Q）后再运行本脚本；"
  echo "因为同一个登录档案不能被两个 Chrome 实例同时使用，远程调试端口需要重启 Chrome 才能生效。"
  exit 1
fi

echo "正在用默认档案启动 Chrome（远程调试端口 $PORT）…"
open -a "Google Chrome" --args --remote-debugging-port="$PORT"
echo "已启动。请在 Chrome 中打开 BOSS 直聘 → 消息 → 与目标公司 HR 的对话，"
echo "然后回到投递板块，点该条投递记录里的「从 BOSS 直聘采集」即可。"
