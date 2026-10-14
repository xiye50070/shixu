#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

for command_name in uv node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少 $command_name，请先安装后重新运行 make setup。" >&2
    exit 1
  fi
done

node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 9)) {
    console.error("需要 Node.js 20.9 或更新版本。");
    process.exit(1);
  }
'

export UV_CACHE_DIR="${UV_CACHE_DIR:-${TMPDIR:-/tmp}/agent-workspace-uv-cache}"
NPM_CACHE_DIR="${npm_config_cache:-${TMPDIR:-/tmp}/agent-workspace-npm-cache}"

if [[ ! -f "$PROJECT_DIR/backend/.env" ]]; then
  cp -- "$PROJECT_DIR/backend/.env.example" "$PROJECT_DIR/backend/.env"
fi
if [[ ! -f "$PROJECT_DIR/frontend/.env.local" ]]; then
  cp -- "$PROJECT_DIR/frontend/.env.example" "$PROJECT_DIR/frontend/.env.local"
fi
mkdir -p -- "$PROJECT_DIR/data"

echo "安装后端依赖（uv.lock）…"
(
  cd -- "$PROJECT_DIR/backend"
  uv sync --frozen
)

echo "安装前端依赖（package-lock.json）…"
(
  cd -- "$PROJECT_DIR/frontend"
  npm ci --cache "$NPM_CACHE_DIR"
)

echo "安装完成。请在 backend/.env 填写 DEEPSEEK_API_KEY，然后运行 make dev。"
echo "没有配置密钥时，也可以先使用项目和会话管理功能。"
