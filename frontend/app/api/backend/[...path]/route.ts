import { deleteRuntimeThread, runtimeThreadIsRunning, runtimeThreadsAreRunning } from "@/lib/runtime";
import { getRuntimeCoordination } from "@/lib/runtime-coordination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const origin = request.headers.get("origin");
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && origin) {
    const requestUrl = new URL(request.url);
    // Next may normalize request.url to localhost internally. The browser's Host
    // header retains the actual destination (including its port); forwarded
    // origin/host headers are deliberately not used as an authorization source.
    const host = request.headers.get("host") || requestUrl.host;
    let sameOrigin = false;
    try { sameOrigin = origin === new URL(`${requestUrl.protocol}//${host}`).origin; } catch { /* An invalid host cannot authorize a mutation. */ }
    if (!sameOrigin) return Response.json({ detail: "此操作只允许从当前拾序页面发起" }, { status: 403 });
  }
  const { path } = await context.params;
  const deletingConversation = request.method === "DELETE" && path[0] === "conversations" && path.length === 2;
  const deletingProject = request.method === "DELETE" && path[0] === "projects" && path.length === 2;
  if (deletingConversation && runtimeThreadIsRunning(path[1])) {
    return Response.json({ detail: "任务仍在运行，请先停止后再删除" }, { status: 409 });
  }
  const target = new URL(`/api/${path.map(encodeURIComponent).join("/")}`, process.env.BACKEND_URL || "http://127.0.0.1:8765");
  target.search = new URL(request.url).search;
  const coordination = getRuntimeCoordination();
  // Deletion boundary: announce BEFORE awaiting the membership list, and hold
  // through the backend's actual result. Later run admissions cannot slip
  // between the pending/SQLite check and DELETE acquiring the backend lock.
  const releaseProject = deletingProject ? coordination.tryBeginProjectDeletion(path[1]) : null;
  if (deletingProject && !releaseProject) {
    return Response.json({ detail: "项目正在删除，请等待完成。" }, { status: 409 });
  }
  try {
    if (deletingProject) {
      // The runtime can have a queued run before FastAPI acquires its thread
      // lock. Moving its project conversations must wait for both stages.
      const membersResponse = await fetch(new URL("/api/conversations", target), { cache: "no-store", signal: request.signal });
      if (!membersResponse.ok) return Response.json({ detail: "无法读取项目会话，请稍后重试" }, { status: membersResponse.status });
      const conversations = await membersResponse.json() as { id: string; project_id: string | null }[];
      const threadIds = conversations.filter((conversation) => conversation.project_id === path[1]).map((conversation) => conversation.id);
      if (runtimeThreadsAreRunning(threadIds)) {
        return Response.json({ detail: "项目中有任务仍在运行，请先停止或等待完成后再删除项目" }, { status: 409 });
      }
    }
    const response = await fetch(target, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
      cache: "no-store",
      signal: request.signal,
    });
    // A previously-started lookup can return its old project ID after DELETE
    // succeeds. Keep a tombstone for those pending admissions; fresh lookups
    // return project_id=null and can start normally in the default directory.
    if (deletingProject && response.status === 204) coordination.markProjectDeleted(path[1]);
    if (deletingConversation && (response.ok || response.status === 404)) {
      try {
        // A repeated delete also removes events after a partial prior cleanup.
        deleteRuntimeThread(path[1]);
      } catch {
        return Response.json({ detail: "会话已移除，聊天历史清理暂未完成，请重试删除" }, { status: 500 });
      }
      return new Response(null, { status: 204 });
    }
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/json", "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ detail: "无法连接后端，请启动 FastAPI 服务后重试" }, { status: 502 });
  } finally {
    releaseProject?.();
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
