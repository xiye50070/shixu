import "server-only";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { HttpAgent } from "@ag-ui/client";
import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2";
import { SqliteAgentRunner } from "@copilotkit/sqlite-runner";

const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:8765";
export const runtimeDbPath = resolve(process.env.RUNTIME_DB_PATH || "../data/runtime.db");

type RuntimeBundle = {
  handler: ReturnType<typeof createCopilotRuntimeHandler>;
  runner: SqliteAgentRunner;
};

const globalRuntime = globalThis as typeof globalThis & { workspaceRuntime?: RuntimeBundle };

function initializeRuntime(): RuntimeBundle {
  mkdirSync(dirname(runtimeDbPath), { recursive: true });
  const runner = new SqliteAgentRunner({ dbPath: runtimeDbPath });
  const db = new Database(runtimeDbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  // This singleton runs only once per process, including Next dev HMR.
  // A crashed process has no live agent; clear its persisted running flags.
  db.prepare("UPDATE run_state SET is_running = 0, current_run_id = NULL, updated_at = ?").run(Date.now());
  db.close();
  const runtime = new CopilotRuntime({
    agents: {
      assistant: new HttpAgent({ url: process.env.AGENT_URL || `${backendUrl}/agent` }),
    },
    runner,
  });
  const handler = createCopilotRuntimeHandler({ runtime, basePath: "/api/copilotkit" });
  return { runner, handler };
}

export function getRuntime(): RuntimeBundle {
  return globalRuntime.workspaceRuntime ??= initializeRuntime();
}

export async function runtimeHandler(request: Request): Promise<Response> {
  // Only existing business conversations can acquire runtime history.
  if (request.method === "POST" && /\/agent\/[^/]+\/(run|connect)$/.test(new URL(request.url).pathname)) {
    try {
      const body = await request.clone().json();
      const threadId = body.threadId;
      if (typeof threadId !== "string" || !threadId) {
        return Response.json({ error: "缺少会话 ID" }, { status: 400 });
      }
      const conversation = await fetch(`${backendUrl}/api/conversations/${encodeURIComponent(threadId)}`, { cache: "no-store" });
      if (!conversation.ok) {
        return Response.json({ error: "会话不存在或后端暂时不可用" }, { status: conversation.status });
      }
    } catch {
      return Response.json({ error: "无法连接 Agent 后端，请检查服务是否启动" }, { status: 502 });
    }
  }
  return getRuntime().handler(request);
}

export function runtimeThreadIsRunning(threadId: string): boolean {
  getRuntime();
  const db = new Database(runtimeDbPath);
  try {
    const row = db.prepare("SELECT is_running FROM run_state WHERE thread_id = ?").get(threadId) as { is_running: number } | undefined;
    return row?.is_running === 1;
  } finally { db.close(); }
}

export function deleteRuntimeThread(threadId: string): void {
  getRuntime();
  const db = new Database(runtimeDbPath);
  try {
    db.transaction(() => {
      db.prepare("DELETE FROM agent_runs WHERE thread_id = ?").run(threadId);
      db.prepare("DELETE FROM run_state WHERE thread_id = ?").run(threadId);
    })();
  } finally { db.close(); }
}
