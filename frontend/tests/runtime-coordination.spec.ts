import { test, expect } from "@playwright/test";
import { RuntimeCoordination, holdResponseReservation } from "../lib/runtime-coordination";

// These are coordination unit checks in the Playwright runner. They do not use
// a browser, a server, a model, or a native dialog. HTTP/UI integration remains
// covered by the separate project-deletion browser tests.
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("协调单元：删除先占位，等待项目查询的同项目运行随后可检测到拒绝条件", async () => {
  const coordination = new RuntimeCoordination();
  const releaseDelete = coordination.tryBeginProjectDeletion("project-a");
  expect(releaseDelete).not.toBeNull();
  const lookup = deferred<string>();
  const releaseRun = coordination.reserveThread("thread-a");
  const admissionBlocked = lookup.promise.then((projectId) => coordination.isProjectDeleting(projectId));
  expect(coordination.hasReservedThreads(["thread-a"])).toBe(true);
  expect(coordination.tryBeginProjectDeletion("project-a")).toBeNull();
  lookup.resolve("project-a");
  expect(await admissionBlocked).toBe(true);
  releaseRun();
  releaseDelete!();
  expect(coordination.isProjectDeleting("project-a")).toBe(false);
  expect(coordination.hasReservedThreads(["thread-a"])).toBe(false);
});

test("协调单元：运行在查询前预留，删除查询成员后持续判忙直到运行释放", async () => {
  const coordination = new RuntimeCoordination();
  const lookup = deferred<string>();
  const releaseRun = coordination.reserveThread("thread-a");
  const projectLookup = lookup.promise;
  // The lookup is intentionally unresolved: the reservation must already be
  // visible to a deletion that discovers this thread in its membership query.
  const releaseDelete = coordination.tryBeginProjectDeletion("project-a");
  expect(releaseDelete).not.toBeNull();
  const members = deferred<string[]>();
  const deletionBusy = members.promise.then((threadIds) => coordination.hasReservedThreads(threadIds));
  members.resolve(["thread-a"]);
  expect(await deletionBusy).toBe(true);
  expect(coordination.hasReservedThreads(["thread-a"])).toBe(true);
  releaseDelete!();
  lookup.resolve("project-a");
  expect(await projectLookup).toBe("project-a");
  expect(coordination.isProjectDeleting("project-a")).toBe(false);
  expect(coordination.hasReservedThreads(["thread-a"])).toBe(true);
  releaseRun();
  const retryDelete = coordination.tryBeginProjectDeletion("project-a");
  expect(retryDelete).not.toBeNull();
  expect(coordination.hasReservedThreads(["thread-a"])).toBe(false);
  retryDelete!();
});

test("协调单元：不同项目互不阻塞，重复线程预留计数且释放幂等", () => {
  const coordination = new RuntimeCoordination();
  const firstRun = coordination.reserveThread("thread-a");
  const secondRun = coordination.reserveThread("thread-a");
  const deleteOtherProject = coordination.tryBeginProjectDeletion("project-b");
  expect(deleteOtherProject).not.toBeNull();
  expect(coordination.isProjectDeleting("project-a")).toBe(false);
  expect(coordination.isProjectDeleting("project-b")).toBe(true);
  expect(coordination.isProjectDeleting(null)).toBe(false);
  expect(coordination.hasReservedThreads(["thread-b"])).toBe(false);
  firstRun();
  firstRun();
  expect(coordination.hasReservedThreads(["thread-a"])).toBe(true);
  secondRun();
  secondRun();
  expect(coordination.hasReservedThreads(["thread-a"])).toBe(false);
  deleteOtherProject!();
  deleteOtherProject!();
  expect(coordination.isProjectDeleting("project-b")).toBe(false);
});

test("协调单元：删除完成后旧项目查询才返回，墓碑仍阻止旧上下文直到预留释放", async () => {
  const coordination = new RuntimeCoordination();
  const lookup = deferred<string | null>();
  const releasePendingRun = coordination.reserveThread("stale-lookup-thread");
  const releaseDelete = coordination.tryBeginProjectDeletion("deleted-project");
  expect(releaseDelete).not.toBeNull();
  // Simulate a successful deletion while an earlier membership response is
  // delayed in transit. Releasing the live guard must not authorize its old PID.
  coordination.markProjectDeleted("deleted-project");
  releaseDelete!();
  expect(coordination.isProjectDeleting("deleted-project")).toBe(false);
  lookup.resolve("deleted-project");
  const staleProjectId = await lookup.promise;
  expect(coordination.wasProjectDeleted(staleProjectId)).toBe(true);
  expect(coordination.hasReservedThreads(["stale-lookup-thread"])).toBe(true);
  releasePendingRun();
  expect(coordination.hasReservedThreads(["stale-lookup-thread"])).toBe(false);
  expect(coordination.wasProjectDeleted("deleted-project")).toBe(false);

  const releaseNewRun = coordination.reserveThread("fresh-lookup-thread");
  const freshLookup = deferred<string | null>();
  freshLookup.resolve(null); // The same conversation is now ungrouped.
  const currentProjectId = await freshLookup.promise;
  expect(coordination.isProjectDeleting(currentProjectId)).toBe(false);
  expect(coordination.wasProjectDeleted(currentProjectId)).toBe(false);
  releaseNewRun();
});

test("协调单元：响应已返回且读到数据时仍预留，响应流真正结束才释放", async () => {
  const coordination = new RuntimeCoordination();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const upstream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  const wrapped = holdResponseReservation(new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream", "x-test-stream": "preserved" } }), coordination.reserveThread("stream-a"));
  expect(wrapped.headers.get("x-test-stream")).toBe("preserved");
  expect(coordination.hasReservedThreads(["stream-a"])).toBe(true);
  const reader = wrapped.body!.getReader();
  const firstChunk = reader.read();
  source.enqueue(new TextEncoder().encode("data: first\n\n"));
  expect((await firstChunk).done).toBe(false);
  expect(coordination.hasReservedThreads(["stream-a"])).toBe(true);
  const finished = reader.read();
  expect(coordination.hasReservedThreads(["stream-a"])).toBe(true);
  source.close();
  expect((await finished).done).toBe(true);
  expect(coordination.hasReservedThreads(["stream-a"])).toBe(false);
});

test("协调单元：上游响应流错误释放真实响应预留", async () => {
  const coordination = new RuntimeCoordination();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const upstream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  const wrapped = holdResponseReservation(new Response(upstream), coordination.reserveThread("error-a"));
  const read = wrapped.body!.getReader().read();
  source.error(new Error("fixture stream failure"));
  await expect(read).rejects.toThrow("fixture stream failure");
  expect(coordination.hasReservedThreads(["error-a"])).toBe(false);
});

test("协调单元：消费者取消会取消上游并释放真实响应预留", async () => {
  const coordination = new RuntimeCoordination();
  const cancelled = deferred<unknown>();
  const upstream = new ReadableStream<Uint8Array>({ cancel(reason) { cancelled.resolve(reason); } });
  const wrapped = holdResponseReservation(new Response(upstream), coordination.reserveThread("cancel-a"));
  expect(coordination.hasReservedThreads(["cancel-a"])).toBe(true);
  await wrapped.body!.cancel("fixture consumer cancellation");
  expect(await cancelled.promise).toBe("fixture consumer cancellation");
  expect(coordination.hasReservedThreads(["cancel-a"])).toBe(false);
});

test("协调单元：请求中止释放预留并终止上游响应流", async () => {
  const coordination = new RuntimeCoordination();
  const request = new AbortController();
  const cancelled = deferred<unknown>();
  const upstream = new ReadableStream<Uint8Array>({ cancel(reason) { cancelled.resolve(reason); } });
  const wrapped = holdResponseReservation(new Response(upstream), coordination.reserveThread("abort-a"), request.signal);
  const read = wrapped.body!.getReader().read();
  request.abort();
  await cancelled.promise;
  await read.catch(() => undefined);
  expect(coordination.hasReservedThreads(["abort-a"])).toBe(false);
});

test("协调单元：无响应体立即释放，不改变响应状态和响应头", () => {
  const coordination = new RuntimeCoordination();
  const wrapped = holdResponseReservation(new Response(null, { status: 204, headers: { "x-test-status": "preserved" } }), coordination.reserveThread("empty-a"));
  expect(wrapped.status).toBe(204);
  expect(wrapped.headers.get("x-test-status")).toBe("preserved");
  expect(wrapped.body).toBeNull();
  expect(coordination.hasReservedThreads(["empty-a"])).toBe(false);
});
