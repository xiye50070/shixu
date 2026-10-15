#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
BACKEND_PYTHON="$PROJECT_DIR/backend/.venv/bin/python"
NEXT_CLI="$PROJECT_DIR/frontend/node_modules/next/dist/bin/next"
FIXTURE_PORT=18965
BACKEND_PORT=18966
WEB_PORT=3211
FIXTURE_PID=""
BACKEND_PID=""
WEB_PID=""
TEST_PID=""
TEST_DIR=""

if [[ ! -x "$BACKEND_PYTHON" || ! -f "$NEXT_CLI" ]]; then
  echo "依赖尚未安装，请先运行 make setup。" >&2
  exit 1
fi
for command_name in node npm pgrep; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "未找到 $command_name，无法运行浏览器检查。" >&2
    exit 1
  fi
done

"$BACKEND_PYTHON" - "$FIXTURE_PORT" "$BACKEND_PORT" "$WEB_PORT" <<'PY'
import socket
import sys

for value in sys.argv[1:]:
    port = int(value)
    with socket.socket() as sock:
        # Recently closed test connections may remain in TIME_WAIT. An active
        # listener still rejects this bind; a completed run can restart at once.
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError as exc:
            print(f"测试端口 {port} 无法使用：{exc}。请自行关闭占用进程后重试。", file=sys.stderr)
            raise SystemExit(1)
PY

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
  local process_id
  local attempt
  local running
  trap - EXIT INT TERM
  for process_id in "$TEST_PID" "$WEB_PID" "$BACKEND_PID" "$FIXTURE_PID"; do
    [[ -z "$process_id" ]] || terminate_tree "$process_id"
  done
  for attempt in 1 2 3 4 5; do
    running=false
    for process_id in "$TEST_PID" "$WEB_PID" "$BACKEND_PID" "$FIXTURE_PID"; do
      if [[ -n "$process_id" ]] && kill -0 "$process_id" 2>/dev/null; then
        running=true
      fi
    done
    [[ "$running" == true ]] || break
    sleep 1
  done
  for process_id in "$TEST_PID" "$WEB_PID" "$BACKEND_PID" "$FIXTURE_PID"; do
    if [[ -n "$process_id" ]] && kill -0 "$process_id" 2>/dev/null; then
      terminate_tree "$process_id" KILL
    fi
    [[ -z "$process_id" ]] || wait "$process_id" 2>/dev/null || true
  done
  # Only remove the directory created by this invocation's mktemp.
  if [[ -n "$TEST_DIR" && -d "$TEST_DIR" ]]; then
    rm -rf -- "$TEST_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-workspace-e2e.XXXXXX")"
mkdir -p -- "$TEST_DIR/data" "$TEST_DIR/files" "$TEST_DIR/default-alt" \
  "$TEST_DIR/project-a" "$TEST_DIR/project-b" "$TEST_DIR/external"
"$BACKEND_PYTHON" - "$TEST_DIR" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
(root / "external" / "source.txt").write_text("外部路径测试：只读资料\n", encoding="utf-8")
PY

# These explicit process values override .env files, even if a real key is configured.
export DEEPSEEK_API_KEY=test-placeholder
export DEEPSEEK_BASE_URL="http://127.0.0.1:$FIXTURE_PORT"
export WORKSPACE_DATA_DIR="$TEST_DIR/data"
export WORKSPACE_FILES_DIR="$TEST_DIR/files"
export WORKSPACE_E2E_ROOT="$TEST_DIR"
export RUNTIME_DB_PATH="$TEST_DIR/data/runtime.db"
export BACKEND_URL="http://127.0.0.1:$BACKEND_PORT"
export AGENT_URL="$BACKEND_URL/agent"
export E2E_BASE_URL="http://127.0.0.1:$WEB_PORT"
export FIXTURE_PORT
export NEXT_DIST_DIR=.next-test
export COPILOTKIT_TELEMETRY_DISABLED=true
export NEXT_TELEMETRY_DISABLED=1

(
  cd -- "$PROJECT_DIR"
  exec "$BACKEND_PYTHON" tests/mock_deepseek.py
) >"$TEST_DIR/fixture.log" 2>&1 &
FIXTURE_PID=$!

(
  cd -- "$PROJECT_DIR/backend"
  exec "$BACKEND_PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port "$BACKEND_PORT"
) >"$TEST_DIR/backend.log" 2>&1 &
BACKEND_PID=$!

(
  cd -- "$PROJECT_DIR/frontend"
  exec node "$NEXT_CLI" dev --webpack --hostname 127.0.0.1 --port "$WEB_PORT"
) >"$TEST_DIR/frontend.log" 2>&1 &
WEB_PID=$!

echo "等待隔离测试服务启动（最多 60 秒）…"
if ! "$BACKEND_PYTHON" - "$FIXTURE_PID" "$BACKEND_PID" "$WEB_PID" \
  "$DEEPSEEK_BASE_URL" "$BACKEND_URL/api/health" "$E2E_BASE_URL" <<'PY'
import os
import sys
import time
import urllib.error
import urllib.request

pids = [int(value) for value in sys.argv[1:4]]
urls = sys.argv[4:]
pending = set(urls)
deadline = time.monotonic() + 60
while pending and time.monotonic() < deadline:
    for pid in pids:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            print("一个测试服务已经退出。", file=sys.stderr)
            raise SystemExit(1)
    for url in tuple(pending):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            with urllib.request.urlopen(url, timeout=min(1, remaining)) as response:
                if response.status == 200:
                    pending.remove(url)
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
    if pending:
        time.sleep(max(0, min(0.4, deadline - time.monotonic())))
if pending:
    print("测试服务启动超时：" + ", ".join(sorted(pending)), file=sys.stderr)
    raise SystemExit(1)
PY
then
  for log_name in fixture backend frontend; do
    echo "$log_name 启动日志：" >&2
    tail -n 30 "$TEST_DIR/$log_name.log" >&2
  done
  exit 1
fi

echo "运行浏览器检查；模型传输仅连接本地 fixture，不使用真实密钥。"
(
  cd -- "$PROJECT_DIR/frontend"
  exec npm run test:e2e
) &
TEST_PID=$!
if wait "$TEST_PID"; then
  exit 0
else
  test_status=$?
  for log_name in fixture backend frontend; do
    echo "$log_name 测试失败诊断：" >&2
    tail -n 40 "$TEST_DIR/$log_name.log" >&2
  done
  exit "$test_status"
fi
