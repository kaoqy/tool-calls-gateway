# syntax=docker/dockerfile:1
# ---------- 依赖层（零运行时依赖，此层仅生成 lock 供审计/缓存） ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts

# ---------- 运行层 ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8787
WORKDIR /app
COPY --from=deps --chown=node:node /app/package.json ./package.json
COPY --chown=node:node src ./src
COPY --chown=node:node mock ./mock

# 设置文件落盘目录（docker compose 里挂 named volume，容器重建不丢配置）
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
