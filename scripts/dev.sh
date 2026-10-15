#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
BACKEND_PYTHON="$PROJECT_DIR/backend/.venv/bin/python"
NEXT_CLI="$PROJECT_DIR/frontend/node_modules/next/dist/bin/next"
BACKEND_PORT=8765
WEB_PORT=3210
BACKEND_PID=""
WEB_PID=""

if [[ ! -x "$BACKEND_PYTHON" || ! -f "$NEXT_CLI" ]]; then
  echo "依赖尚未安装，请先运行 make setup。" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装。" >&2
  exit 1
fi
if ! command -v pgrep >/dev/null 2>&1; then
  echo "未找到 pgrep，无法可靠清理本脚本启动的子进程。" >&2
  exit 1
fi

# Check both ports before starting either server. Never stop an existing listener.
"$BACKEND_PYTHON" - "$BACKEND_PORT" "$WEB_PORT" <<'PY'
import socket
import sys

for value in sys.argv[1:]:
    port = int(value)
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError as exc:
            print(f"端口 {port} 无法使用：{exc}。请自行关闭占用进程后重试。", file=sys.stderr)
            raise SystemExit(1)
PY

# Only walk descendants of the two processes launched below.
terminate_tree() {
  local process_id="$1"
  local signal_name="${2:-TERM}"
  local child_id
  local child_ids
  child_ids="$(pgrep -P "$process_id" 2>/dev/null || true)"
  for child_id in $child_ids; do
    terminate_tree "$child_id" "$signal_name"
  done
  kill -"$signal_name" "$process_id" 2>/dev/null || true
}

cleanup() {
  local attempt
  trap - EXIT INT TERM
  [[ -z "$WEB_PID" ]] || terminate_tree "$WEB_PID"
  [[ -z "$BACKEND_PID" ]] || terminate_tree "$BACKEND_PID"
  for attempt in 1 2 3 4 5; do
    if ! { [[ -n "$WEB_PID" ]] && kill -0 "$WEB_PID" 2>/dev/null; } &&
       ! { [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; }; then
      break
    fi
    sleep 1
  done
  if [[ -n "$WEB_PID" ]] && kill -0 "$WEB_PID" 2>/dev/null; then
    terminate_tree "$WEB_PID" KILL
  fi
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    terminate_tree "$BACKEND_PID" KILL
  fi
  [[ -z "$WEB_PID" ]] || wait "$WEB_PID" 2>/dev/null || true
  [[ -z "$BACKEND_PID" ]] || wait "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export COPILOTKIT_TELEMETRY_DISABLED=true
export NEXT_TELEMETRY_DISABLED=1
export NEXT_DIST_DIR=.next-dev
mkdir -p -- "$PROJECT_DIR/data"

(
  cd -- "$PROJECT_DIR/backend"
  exec "$BACKEND_PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port "$BACKEND_PORT"
) &
BACKEND_PID=$!

(
  cd -- "$PROJECT_DIR/frontend"
  exec node "$NEXT_CLI" dev --webpack --hostname 127.0.0.1 --port "$WEB_PORT"
) &
WEB_PID=$!

echo "Web：http://127.0.0.1:$WEB_PORT"
echo "后端：http://127.0.0.1:$BACKEND_PORT"
echo "按 Ctrl+C 停止本次启动的两个服务。"

while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 1
done

echo "一个服务已经退出，正在清理本次启动的进程。" >&2
exit 1
