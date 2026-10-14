.PHONY: setup dev test build test-e2e

setup:
	bash ./scripts/setup.sh

dev:
	bash ./scripts/dev.sh

test:
	cd backend && UV_CACHE_DIR="$${UV_CACHE_DIR:-$${TMPDIR:-/tmp}/agent-workspace-uv-cache}" uv run --frozen pytest
	cd frontend && npm run typecheck

build:
	cd frontend && NEXT_TELEMETRY_DISABLED=1 COPILOTKIT_TELEMETRY_DISABLED=true npm run build

test-e2e:
	bash ./scripts/test-e2e.sh
