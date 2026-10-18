#!/bin/bash
# 西浦课程助手 · 一行安装（macOS / Linux）
#   /bin/bash -c "$(curl -fsSL https://shanyuzhang.com/xjtlu-core-mcp/install.sh)"
# 没有 Node.js 20+ 时，下载官方 Node.js 到 ~/.xjtlu-session-mcp/node（不需要管理员权限，不改系统设置），
# 然后下载工具包、安装依赖、打开学校登录窗口并连接 AI 应用。
set -euo pipefail

NODE_VERSION="v24.21.0"
SITE="${XJTLU_INSTALL_BASE:-https://shanyuzhang.com/xjtlu-core-mcp}"
REPO_ZIP="https://github.com/shanyuzhang/xjtlu-core-mcp/archive/refs/heads/main.zip"
NODE_MIRRORS=("https://nodejs.org/dist" "https://cdn.npmmirror.com/binaries/node")
APP_HOME="${XJTLU_MCP_HOME:-$HOME/.xjtlu-session-mcp}"

say() { printf '%s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
# 慢于 20 KB/s 持续 20 秒就放弃，换下一个来源。
fetch() { curl -fL --connect-timeout 10 --speed-limit 20480 --speed-time 20 --retry 1 -sS -o "$2" "$1"; }

say "西浦课程助手 · 正在安装"
say ""

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

node_ok() { [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; }

NODE=""
if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"
elif node_ok "$APP_HOME/node/bin/node"; then
  NODE="$APP_HOME/node/bin/node"
else
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail "暂不支持这个系统。" ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail "暂不支持这种处理器：$(uname -m)" ;; esac
  file="node-$NODE_VERSION-$os-$arch.tar.gz"
  say "① 没有找到 Node.js，正在下载 Node.js ${NODE_VERSION#v}（约 50 MB，只装在你的用户目录）…"
  got=""
  for mirror in "${NODE_MIRRORS[@]}"; do
    if fetch "$mirror/$NODE_VERSION/$file" "$TMP/$file" && fetch "$mirror/$NODE_VERSION/SHASUMS256.txt" "$TMP/SHASUMS256.txt"; then
      want="$(awk -v f="$file" '$2 == f { print $1 }' "$TMP/SHASUMS256.txt")"
      have="$(shasum -a 256 "$TMP/$file" 2>/dev/null | awk '{print $1}' || sha256sum "$TMP/$file" | awk '{print $1}')"
      if [ -n "$want" ] && [ "$want" = "$have" ]; then got=1; break; fi
      say "  校验没通过，换一个下载源…"
    else
      say "  这个下载源太慢或连不上，换一个…"
    fi
  done
  [ -n "$got" ] || fail "Node.js 下载失败。请检查网络后重新运行同一行命令。"
  tar -xzf "$TMP/$file" -C "$TMP"
  rm -rf "$APP_HOME/node"; mkdir -p "$APP_HOME"
  mv "$TMP/node-$NODE_VERSION-$os-$arch" "$APP_HOME/node"
  NODE="$APP_HOME/node/bin/node"
  say "  ✓ Node.js 已就绪"
fi
# 安装向导会调用 npm，让它用上面这份 Node.js。
export PATH="$(dirname "$NODE"):$PATH"

if [ "$(uname -s)" = Darwin ]; then
  found=""
  for app in "/Applications/Google Chrome.app" "$HOME/Applications/Google Chrome.app" "/Applications/Microsoft Edge.app" "$HOME/Applications/Microsoft Edge.app"; do
    [ -d "$app" ] && found=1
  done
  [ -n "$found" ] || fail "登录学校账号需要 Chrome 或 Edge 浏览器。请先安装 Chrome（https://www.google.com/chrome/），再重新运行同一行命令。"
fi

say "② 正在下载课程助手…"
# 优先从 npm 下载（国内镜像 npmmirror 在前），按 npm 公布的 sha512 校验；都不行再用 GitHub Pages / 仓库 ZIP。
NPM_FETCH='const [reg, pkg, out] = process.argv.slice(1);
(async () => {
  const meta = await (await fetch(`${reg}/${pkg}/latest`, { signal: AbortSignal.timeout(15000) })).json();
  const res = await fetch(meta.dist.tarball, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(String(res.status));
  const buf = Buffer.from(await res.arrayBuffer());
  const [algo, want] = meta.dist.integrity.split(/-(.*)/s);
  if (require("crypto").createHash(algo).update(buf).digest("base64") !== want) throw new Error("integrity");
  require("fs").writeFileSync(out, buf);
})().catch(() => process.exit(1));'
mkdir -p "$TMP/app"
got_app=""
for reg in https://registry.npmmirror.com https://registry.npmjs.org; do
  if "$NODE" -e "$NPM_FETCH" "$reg" xjtlu-core-mcp "$TMP/app.tgz" && tar -xzf "$TMP/app.tgz" -C "$TMP/app"; then got_app=1; break; fi
done
if [ -z "$got_app" ]; then
  if fetch "$SITE/xjtlu-core-mcp.zip" "$TMP/app.zip" || fetch "$REPO_ZIP" "$TMP/app.zip"; then
    unzip -q "$TMP/app.zip" -d "$TMP/app"
  else
    fail "课程助手下载失败。请检查网络（或连接校园网 / VPN）后重新运行同一行命令。"
  fi
fi
INSTALLER="$(find "$TMP/app" -maxdepth 3 -path '*/scripts/install-xjtlu.mjs' | head -n 1)"
[ -n "$INSTALLER" ] || fail "下载的文件不完整，请重新运行同一行命令。"

# npm 官方源连不上时改用国内镜像（依赖版本由锁文件固定，只换下载地址）。
if [ -z "${npm_config_registry:-}" ] && ! curl -fsS -o /dev/null --connect-timeout 6 -m 10 https://registry.npmjs.org/zod; then
  export npm_config_registry="https://registry.npmmirror.com"
fi

export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
say "③ 正在安装依赖，然后会打开学校登录窗口…"
say ""
# XJTLU_SETUP_ARGS 给 AI 代装用，例如 "--yes --clients all"（没有交互终端时不提问）。
# shellcheck disable=SC2206
EXTRA=(${XJTLU_SETUP_ARGS:-})
# 兼容 curl … | bash：此时标准输入是管道，问答改从终端读取。
if [ -t 0 ] || ! { : < /dev/tty; } 2>/dev/null; then
  "$NODE" "$INSTALLER" --quick ${EXTRA[@]+"${EXTRA[@]}"} "$@"
else
  "$NODE" "$INSTALLER" --quick ${EXTRA[@]+"${EXTRA[@]}"} "$@" < /dev/tty
fi
