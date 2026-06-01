#!/bin/zsh
set -e

cd "$(dirname "$0")/app"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 24+。"
  read "?按回车退出"
  exit 1
fi

echo "检查运行环境..."
npm run doctor

if [ ! -d "node_modules" ]; then
  echo "首次运行，正在安装依赖..."
  npm install
fi

echo "构建前端..."
npm run build

echo "启动工作台：http://127.0.0.1:5174"
(sleep 2 && open "http://127.0.0.1:5174") &
npm run start
