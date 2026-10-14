import { deleteRuntimeThread, runtimeThreadIsRunning } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const deletingConversation = request.method === "DELETE" && path[0] === "conversations" && path.length === 2;
  if (deletingConversation && runtimeThreadIsRunning(path[1])) {
    return Response.json({ detail: "任务仍在运行，请先停止后再删除" }, { status: 409 });
  }
  const target = new URL(`/api/${path.map(encodeURIComponent).join("/")}`, process.env.BACKEND_URL || "http://127.0.0.1:8765");
  target.search = new URL(request.url).search;
  try {
    const response = await fetch(target, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
      cache: "no-store",
      signal: request.signal,
    });
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
  }
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
