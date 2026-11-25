#!/usr/bin/env bash
#
# 启动前后端服务，等 Web 端口就绪后用系统浏览器打开控制台。
# macOS / Linux（bash 3.2+）。
#
#   ./scripts/dev-open.sh          # 开发模式，打开 http://127.0.0.1:5173
#   ./scripts/dev-open.sh --prod   # 先构建，再以生产模式启动，打开 http://127.0.0.1:8758
#
# 端口遵循 PRINT_WEB_PORT / PRINT_PORT，与 npm 脚本保持一致。

set -uo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root" || exit 1

usage() {
  printf '用法: %s [--prod]\n' "$0"
  printf '  --prod  先构建，再以生产模式在同一端口启动并打开页面\n'
}

mode=dev
case "${1:-}" in
  --prod) mode=prod ;;
  -h | --help) usage; exit 0 ;;
  '') ;;
  *)
    usage >&2
    exit 2
    ;;
esac

die() {
  printf 'dev-open: %s\n' "$*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || die '找不到 node，请先安装 Node.js 24.13 或更高版本'
command -v npm >/dev/null 2>&1 || die '找不到 npm'
command -v curl >/dev/null 2>&1 || die '找不到 curl，无法探测 Web 端口是否就绪'
[ -d node_modules ] || die '依赖尚未安装，请先在仓库根目录运行 npm ci'

if [ "$mode" = prod ]; then
  port=${PRINT_PORT:-8758}
  label='生产模式'
  probe="/"
else
  port=${PRINT_WEB_PORT:-5173}
  label='开发模式'
  # 用 Vite 自带入口判断，避免把占用同一端口的其他开发服务器当成我们的页面。
  probe='/@vite/client'
fi
url="http://127.0.0.1:${port}"
probeUrl="${url}${probe}"

open_browser() {
  case "$(uname -s)" in
    Darwin)
      open "$1"
      ;;
    *)
      if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$1" >/dev/null 2>&1
      else
        printf '[dev-open] 没有可用的打开命令，请手动打开 %s\n' "$1" >&2
      fi
      ;;
  esac
}

# 轮询到页面返回 2xx 再打开，避免浏览器先于 Vite 就绪而显示空白页。
wait_and_open() {
  local ticks=0
  printf '[dev-open] 等待 %s 就绪 …\n' "$url"
  while [ "$ticks" -lt 240 ]; do
    if curl -fs --max-time 1 -o /dev/null "$probeUrl" 2>/dev/null; then
      printf '[dev-open] 已就绪，用浏览器打开 %s\n' "$url"
      open_browser "$url"
      return 0
    fi
    sleep 0.5
    ticks=$((ticks + 1))
  done
  printf '[dev-open] 等待超时（120 秒）：%s 仍未响应，请检查上面的日志。\n' "$url" >&2
  return 1
}

if [ "$mode" = prod ]; then
  printf '[dev-open] %s：构建中 …\n' "$label"
  npm run build || die '构建失败，已停止'
fi

opener=
trap '[ -n "$opener" ] && kill "$opener" 2>/dev/null' EXIT

printf '[dev-open] %s，按 Ctrl+C 停止服务。\n' "$label"
wait_and_open &
opener=$!

if [ "$mode" = prod ]; then
  npm start
else
  npm run dev
fi
status=$?

exit "$status"
