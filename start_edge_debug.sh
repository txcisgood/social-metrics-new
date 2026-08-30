#!/bin/bash
# 启动带远程调试端口的 Edge（你的真实 Profile，登录态保留）
# 跑完 Facebook 采集后用 ./stop_edge_debug.sh 关闭

EDGE="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
PORT=9222
PORT_FILE="/tmp/edge_debug_port"
USER_DATA="$HOME/Library/Application Support/Microsoft Edge"

# 1. 温和退出当前 Edge（保留 Profile 数据）
osascript -e 'tell application "Microsoft Edge" to quit' 2>/dev/null
sleep 2
pkill -x "Microsoft Edge" 2>/dev/null
sleep 2

# 2. 启动带调试端口的 Edge（直接复用你的 Default profile）
"$EDGE" \
  --remote-debugging-port=$PORT \
  --user-data-dir="$USER_DATA" \
  --profile-directory=Default \
  --no-first-run \
  --no-default-browser-check \
  --no-sandbox \
  --disable-gpu \
  --headless=new \
  --window-size=1400,1000 \
  > /tmp/edge_debug.log 2>&1 &

echo $PORT > "$PORT_FILE"
echo "Edge 启动中，PID=$!"
sleep 5

# 3. 验证端口
if curl -s "http://127.0.0.1:$PORT/json/version" > /dev/null; then
  echo "✓ 调试端口 $PORT 已就绪"
  echo "现在可以跑 run.py --platform facebook 了"
else
  echo "✗ 端口未起，请检查 /tmp/edge_debug.log"
fi