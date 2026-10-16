#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "请先从 https://nodejs.org 安装 Node.js LTS，再重新打开此文件。"
else
  node scripts/install-xjtlu.mjs
fi
echo ""
read -r -p "按回车关闭窗口…"
