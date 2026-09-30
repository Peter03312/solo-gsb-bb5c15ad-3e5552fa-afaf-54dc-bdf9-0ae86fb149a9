# 服装裁片排版系统 —— 一键镜像
FROM node:20-bookworm-slim

# better-sqlite3 优先下载预编译二进制；无预编译包时用这些工具回退源码编译
ARG NPM_BETTER_SQLITE3_BINARY_HOST=https://registry.npmmirror.com/-/binary/better-sqlite3
ENV NPM_CONFIG_BETTER_SQLITE3_BINARY_HOST=$NPM_BETTER_SQLITE3_BINARY_HOST

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package.json package-lock.json* .npmrc ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl \
  && npm install --omit=dev \
  && apt-get purge -y python3 make g++ \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# 再拷业务代码
COPY shared ./shared
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# SQLite 数据目录（compose 会在此挂卷）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/marker.db
EXPOSE 3000

# 容器启动即建库建表并写入初始示例数据（src/db.js 自动初始化）
CMD ["node", "src/server.js"]
