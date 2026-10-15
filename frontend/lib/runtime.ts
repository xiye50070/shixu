import "server-only";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { HttpAgent } from "@ag-ui/client";
import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2";
import { SqliteAgentRunner } from "@copilotkit/sqlite-runner";
import { getRuntimeCoordination, holdResponseReservation } from "./runtime-coordination";

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
  const route = new URL(request.url).pathname.match(/\/agent\/[^/]+\/(run|connect)$/);
  if (request.method !== "POST" || !route) return getRuntime().handler(request);
  const coordination = getRuntimeCoordination();
  let release: (() => void) | undefined;
  let responseOwnsReservation = false;
  try {
    const body = await request.clone().json();
    const threadId = body.threadId;
    if (typeof threadId !== "string" || !threadId) {
      return Response.json({ error: "缺少会话 ID" }, { status: 400 });
    }
    // Admission boundary: reserve synchronously BEFORE the first backend await.
    // A concurrent project delete sees even a run that is not yet in SQLite.
    // Connect only reads/rejoins history and must not hold a new run admission.
    if (route[1] === "run") release = coordination.reserveThread(threadId);
    const lookup = await fetch(`${backendUrl}/api/conversations/${encodeURIComponent(threadId)}`, {
      cache: "no-store", signal: request.signal,
    });
    if (!lookup.ok) {
      return Response.json({ error: "会话不存在或后端暂时不可用" }, { status: lookup.status });
    }
    const conversation = await lookup.json() as { project_id: string | null };
    if (release && (coordination.isProjectDeleting(conversation.project_id) || coordination.wasProjectDeleted(conversation.project_id))) {
      return Response.json({ error: "项目正在删除或目录已变化，请等待完成后重新发送任务。" }, { status: 409 });
    }
    const response = await getRuntime().handler(request);
    if (!release) return response;
    // Returning headers does not mean the queued/model run has completed.
    // Its body owns this reservation until EOF, error, or cancellation.
    const held = holdResponseReservation(response, release, request.signal);
    responseOwnsReservation = true;
    return held;
  } catch {
    return Response.json({ error: "无法连接 Agent 后端，请检查服务是否启动" }, { status: 502 });
  } finally {
    if (!responseOwnsReservation) release?.();
  }
}

export function runtimeThreadIsRunning(threadId: string): boolean {
  return runtimeThreadsAreRunning([threadId]);
}

export function runtimeThreadsAreRunning(threadIds: string[]): boolean {
  if (!threadIds.length) return false;
  if (getRuntimeCoordination().hasReservedThreads(threadIds)) return true;
  getRuntime();
  const db = new Database(runtimeDbPath);
  try {
    const statement = db.prepare("SELECT is_running FROM run_state WHERE thread_id = ?");
    return threadIds.some((threadId) => (statement.get(threadId) as { is_running: number } | undefined)?.is_running === 1);
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
