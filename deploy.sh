#!/usr/bin/env sh
# 一键部署：拉取已发布镜像 → 生成/复用 .env → 起容器 → 等 /healthz 就绪
#
#   curl -fsSL https://raw.githubusercontent.com/kaoqy/tool-calls-gateway/main/deploy.sh | sh
#   # 或本地：sh deploy.sh
#
# 可用环境变量覆盖：
#   TCG_IMAGE    镜像地址（默认 ghcr.io/kaoqy/tool-calls-gateway:v1.0.0）
#   HOST_PORT    宿主端口（默认 8787）
#   INSTALL_DIR  安装目录（默认 ./toolcall-gateway）
set -eu

IMAGE="${TCG_IMAGE:-ghcr.io/kaoqy/tool-calls-gateway:v1.0.0}"
PORT="${HOST_PORT:-8787}"
DIR="${INSTALL_DIR:-./toolcall-gateway}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少命令：$1"; exit 1; }; }
need docker

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "需要 docker compose（或 docker-compose）"; exit 1
fi

echo "==> 镜像: $IMAGE"
echo "==> 端口: $PORT   目录: $DIR"

mkdir -p "$DIR"
cd "$DIR"

# 1) 生成 .env（已存在则保留，不覆盖用户的密钥）
if [ ! -f .env ]; then
  printf '%s\n' \
    "UPSTREAM_BASE_URL=https://api.deepseek.com" \
    "UPSTREAM_API_KEY=" \
    "DEFAULT_MODEL=deepseek-chat" \
    "GATEWAY_API_KEY=" \
    "TOOL_MODE=auto" \
    "REASONING_PASSTHROUGH=on" \
    "REQUEST_TIMEOUT_MS=60000" \
    "MAX_BODY_BYTES=2097152" \
    "LOG_LEVEL=info" \
    > .env
  echo "==> 已生成 .env，请填入 UPSTREAM_BASE_URL / UPSTREAM_API_KEY 后重新运行本脚本"
  echo "    编辑：$DIR/.env"
  echo "    然后再执行：sh deploy.sh"
  exit 0
fi

# 2) 校验必填项
if ! grep -Eq '^UPSTREAM_BASE_URL=https?://' .env; then
  echo "!! .env 里的 UPSTREAM_BASE_URL 未填写"; exit 1
fi
if ! grep -Eq '^UPSTREAM_API_KEY=.+' .env || grep -Eq '^UPSTREAM_API_KEY=sk-REPLACE_ME' .env; then
  echo "!! .env 里的 UPSTREAM_API_KEY 未填写"; exit 1
fi

# 3) 写一份使用预构建镜像的 compose 文件
cat > docker-compose.yml <<EOF
services:
  toolcall-gateway:
    image: $IMAGE
    container_name: toolcall-gateway
    ports:
      - "$PORT:8787"
    env_file:
      - .env
    environment:
      PORT: "8787"
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      start_period: 5s
      retries: 3
EOF

# 4) 拉取并启动
echo "==> 拉取镜像"
$COMPOSE pull
echo "==> 启动"
$COMPOSE up -d

# 5) 等健康检查
printf '==> 等待健康检查'
i=0
while [ "$i" -lt 30 ]; do
  if body=$(curl -fsS "http://127.0.0.1:$PORT/healthz" 2>/dev/null); then
    printf '\n'
    echo "==> 就绪：$body"
    echo
    echo "OpenAI 兼容端点： http://127.0.0.1:$PORT/v1"
    echo "健康检查：       http://127.0.0.1:$PORT/healthz"
    echo "查看日志：       $COMPOSE logs -f"
    echo "停止：           $COMPOSE down"
    exit 0
  fi
  printf '.'
  i=$((i + 1))
  sleep 1
done
printf '\n'
echo "!! 30s 内未就绪，最近日志："
$COMPOSE logs --tail=50 || true
exit 1
