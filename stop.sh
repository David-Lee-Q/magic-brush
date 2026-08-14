#!/bin/bash
set -u

PORT="${PORT:-8000}"

PIDS=$(ss -tlnp | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)

if [ -z "$PIDS" ]; then
  echo "端口 $PORT 无监听进程，无需停止"
  exit 0
fi

echo "端口 $PORT 监听进程 PID: $(echo $PIDS | tr '\n' ' ')"
for p in $PIDS; do
  echo "正在停止进程 $p ..."
  kill "$p"
done

for i in $(seq 1 20); do
  if ! ss -tln | grep -q ":$PORT "; then
    echo "端口 $PORT 已释放"
    exit 0
  fi
  sleep 0.5
done

echo "端口 $PORT 未在 10 秒内释放，执行强制结束" >&2
for p in $PIDS; do
  kill -9 "$p"
done
exit 1
