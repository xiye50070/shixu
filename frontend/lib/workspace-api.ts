export type WorkspaceGrant = {
  id: string;
  path: string;
  kind: "file" | "directory";
  access: "read" | "read_write";
  mount_path: string;
};

export type ConversationWorkspace = {
  kind: "default" | "project";
  root_dir: string | null;
  project_id: string | null;
  project_name: string | null;
  grants: WorkspaceGrant[];
  available: boolean;
  error?: string;
};

export async function workspaceApi<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/backend/${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
    cache: "no-store",
  });
  if (!response.ok) {
    let message = "请求未完成，请重试";
    try {
      const body = await response.json();
      if (typeof body.detail === "string") message = body.detail;
    } catch { /* The backend may return a non-JSON connection error. */ }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
