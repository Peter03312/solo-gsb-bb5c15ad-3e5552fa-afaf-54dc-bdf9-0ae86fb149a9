#!/usr/bin/env bash
# 本机一键：安装依赖 + 初始化数据库 + 启动
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/3] 安装依赖 …"
npm install --omit=dev

echo "[2/3] 初始化数据库（首次启动自动建表并写入示例数据）…"
mkdir -p data

echo "[3/3] 启动服务 …"
exec node src/server.js
