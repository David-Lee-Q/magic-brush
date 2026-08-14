#!/bin/bash
set -u

PORT="${PORT:-8000}"
WORKDIR="/workspace/.mcp/imagegen-bridge"
LOG_FILE="${WORKDIR}/server.log"

if ss -tln | grep -q ":$PORT "; then
  echo "服务已在端口 $PORT 运行，无需重复启动"
  exit 0
fi

for d in "${WORKDIR}"/.next "${WORKDIR}"/dist "${WORKDIR}"/build; do
  if [ -d "$d" ]; then
    echo "清理构建缓存: $d"
    rm -rf "$d"
  fi
done

export IMG_URL="${IMG_URL:-https://8000-f7c2c497f2f22e08.code.cosmoplat.cn/sse}"
export IMG_TOKEN="${IMG_TOKEN:-1792bf9c72a069e4d875790321e95c93a87320dc712398b4}"
export PORT

cd "$WORKDIR" || { echo "工作目录不存在: $WORKDIR" >&2; exit 2; }

echo "=== $(date '+%Y-%m-%d %H:%M:%S') 启动服务 ===" >> "$LOG_FILE"
nohup node server-http.mjs >> "$LOG_FILE" 2>&1 &
echo "服务进程已启动 PID=$!，等待端口 $PORT 就绪..."

for i in $(seq 1 30); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:$PORT/" || echo "000")
  if [ "$CODE" = "200" ]; then
    echo "服务启动成功: http://127.0.0.1:$PORT/ (HTTP $CODE)"
    exit 0
  fi
  sleep 0.5
done

echo "服务启动失败: 端口 $PORT 就绪检查未通过 (最后一次 HTTP $CODE)" >&2
exit 2
