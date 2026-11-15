#!/usr/bin/env sh
# 一键部署：拉取已发布镜像 → 起容器 → 等 /healthz 就绪 → 打印下一步。
#
#   curl -fsSL https://raw.githubusercontent.com/kaoqy/tool-calls-gateway/main/deploy.sh | sh
#   # 或本地：sh deploy.sh
#
# 全程无需任何环境变量：上游地址、密钥、管理员账号都在首次打开 /admin 时用网页填。
# 唯一会持久化的是数据卷 tcg-data（user.role=node 可写 /app/data），容器重建不丢配置。
#
# 可选覆盖：
#   TCG_IMAGE    镜像地址（默认 ghcr.io/kaoqy/tool-calls-gateway:v1.4.0）
#   HOST_PORT    宿主端口（默认 8787）
#   INSTALL_DIR  安装目录（默认 ./toolcall-gateway）
set -eu

IMAGE="${TCG_IMAGE:-ghcr.io/kaoqy/tool-calls-gateway:v1.4.0}"
PORT="${HOST_PORT:-8787}"
DIR="${INSTALL_DIR:-./toolcall-gateway}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少命令：$1"; exit 1; }; }
need docker

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "需要 docker compose（或 docker-compose）；也可以只用 docker run，见 README"; exit 1
fi

echo "==> 镜像: $IMAGE"
echo "==> 端口: $PORT   目录: $DIR"

mkdir -p "$DIR"
cd "$DIR"

# 1) 生成 compose 文件（只依赖镜像；如果用户自己放了 .env，一并注入，方便高级用法）
ENV_FILE_BLOCK=""
if [ -f .env ]; then
  ENV_FILE_BLOCK='    env_file:
      - .env'
  echo "==> 检测到 .env，将作为可选环境变量注入容器"
fi

cat > docker-compose.yml <<EOF
services:
  toolcall-gateway:
    image: $IMAGE
    container_name: toolcall-gateway
    ports:
      - "$PORT:8787"
    environment:
      PORT: "8787"
$ENV_FILE_BLOCK
    restart: unless-stopped
    read_only: true
    volumes:
      - tcg-data:/app/data
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

volumes:
  tcg-data:
EOF

# 2) 拉取并启动
echo "==> 拉取镜像"
$COMPOSE pull
echo "==> 启动"
$COMPOSE up -d

# 3) 等健康检查（首次启动就要建数据卷，给足 60s）
printf '==> 等待健康检查'
i=0
while [ "$i" -lt 60 ]; do
  if body=$(curl -fsS "http://127.0.0.1:$PORT/healthz" 2>/dev/null); then
    printf '\n'
    echo "==> 就绪：$body"
    echo
    echo "下一步（一次性，完成后就不用再碰这些文件）："
    echo "  1. 浏览器打开  http://127.0.0.1:$PORT/admin"
    echo "     网页里创建管理员账号 + 填写上游 Base URL / API Key / 默认模型，保存即生效"
    echo "  2. 把下游客户端指向  http://127.0.0.1:$PORT/v1"
    echo
    echo "OpenAI 兼容端点： http://127.0.0.1:$PORT/v1"
    echo "设置页：         http://127.0.0.1:$PORT/admin"
    echo "健康检查：       http://127.0.0.1:$PORT/healthz"
    echo "查看日志：       $COMPOSE logs -f"
    echo "停止：           $COMPOSE down"
    echo "配置文件：       docker volume inspect ${DIR##*/}_tcg-data  （auth.json / settings.json）"
    exit 0
  fi
  printf '.'
  i=$((i + 1))
  sleep 1
done
printf '\n'
echo "!! 60s 内未就绪，最近日志："
$COMPOSE logs --tail=50 || true
exit 1
