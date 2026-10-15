/** In-process coordination between runtime admission and project removal. */
export class RuntimeCoordination {
  private readonly pendingThreads = new Map<string, number>();
  private readonly deletingProjects = new Set<string>();
  private readonly deletedProjects = new Set<string>();

  reserveThread(threadId: string): () => void {
    this.pendingThreads.set(threadId, (this.pendingThreads.get(threadId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.pendingThreads.get(threadId) ?? 1) - 1;
      if (remaining) this.pendingThreads.set(threadId, remaining);
      else this.pendingThreads.delete(threadId);
      // No membership lookup can still carry a stale project ID once every
      // admission/stream reservation has ended.
      if (!this.pendingThreads.size) this.deletedProjects.clear();
    };
  }

  hasReservedThreads(threadIds: string[]): boolean {
    return threadIds.some((threadId) => this.pendingThreads.has(threadId));
  }

  tryBeginProjectDeletion(projectId: string): (() => void) | null {
    if (this.deletingProjects.has(projectId)) return null;
    this.deletingProjects.add(projectId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.deletingProjects.delete(projectId);
    };
  }

  isProjectDeleting(projectId: string | null): boolean {
    return projectId !== null && this.deletingProjects.has(projectId);
  }

  markProjectDeleted(projectId: string): void {
    if (this.pendingThreads.size) this.deletedProjects.add(projectId);
  }

  wasProjectDeleted(projectId: string | null): boolean {
    return projectId !== null && this.deletedProjects.has(projectId);
  }
}

// This state is independent of the already-initialized CopilotRuntime singleton,
// so Next development HMR never replaces pending admissions or deletion guards.
const shared = globalThis as typeof globalThis & { workspaceRuntimeCoordination?: RuntimeCoordination };

export function getRuntimeCoordination(): RuntimeCoordination {
  return shared.workspaceRuntimeCoordination ??= new RuntimeCoordination();
}

/** A Response object is not completion: keep admission held for its body. */
export function holdResponseReservation(response: Response, release: () => void, signal?: AbortSignal): Response {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", abort);
    release();
    reader.releaseLock();
  };
  const abort = () => {
    const reason = signal?.reason ?? new DOMException("Request aborted", "AbortError");
    // Canceling the upstream reader releases its runtime subscription as well.
    // A pending read can settle during cancel(), so close this response only in
    // one place and always release the reservation even if cancel itself fails.
    void reader.cancel(reason).catch(() => undefined).finally(() => {
      if (finished) return;
      finish();
      controller.error(reason);
    });
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    },
    async pull(value) {
      try {
        const result = await reader.read();
        if (finished) return;
        if (result.done) {
          finish();
          value.close();
        } else value.enqueue(result.value);
      } catch (error) {
        if (finished) return;
        finish();
        value.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { finish(); }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
