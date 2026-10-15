"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, FileText, Folder, FolderOpen, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { workspaceApi, type ConversationWorkspace } from "@/lib/workspace-api";
import { Dialog } from "./dialog";
import { DirectoryPicker } from "./directory-picker";

export function WorkspaceAccess({ conversationId, revision, onAvailability, onProjectSaved, onDefaultSettings }: {
  conversationId: string;
  revision: string;
  onAvailability: (available: boolean) => void;
  onProjectSaved: () => void | Promise<void>;
  onDefaultSettings: () => void;
}) {
  const [workspace, setWorkspace] = useState<ConversationWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [access, setAccess] = useState<"read" | "read_write">("read");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [errorScope, setErrorScope] = useState<"grant" | "project" | null>(null);
  const [feedback, setFeedback] = useState("");
  const [picker, setPicker] = useState<"grant" | "project" | null>(null);
  const [editProject, setEditProject] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  const pickerTrigger = useRef<HTMLButtonElement | null>(null);
  const busy = !!pending || picker !== null;
  const mounted = useRef(true);
  const loadController = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    loadController.current?.abort();
    const request = new AbortController(); loadController.current = request;
    setLoading(true); setLoadError(""); onAvailability(false);
    try {
      const value = await workspaceApi<ConversationWorkspace>(`conversations/${conversationId}/workspace`, { signal: request.signal });
      if (!request.signal.aborted && mounted.current) { setWorkspace(value); onAvailability(value.available); }
    } catch (failure) {
      if (!request.signal.aborted && mounted.current) setLoadError((failure as Error).message);
    } finally { if (!request.signal.aborted && mounted.current) setLoading(false); }
  }, [conversationId, onAvailability]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; loadController.current?.abort(); }; }, [load, revision]);

  async function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !path.trim()) return;
    setPending("grant"); setErrorScope("grant"); setError(""); setFeedback("");
    try {
      await workspaceApi(`conversations/${conversationId}/grants`, { method: "POST", body: JSON.stringify({ path: path.trim(), access }) });
      if (!mounted.current) return;
      setPath(""); setFeedback("授权已添加，当前会话的后续任务可使用此路径。"); await load();
    } catch (failure) { if (mounted.current) setError((failure as Error).message); }
    finally { if (mounted.current) setPending(null); }
  }
  async function revoke(id: string) {
    if (busy) return; setPending(id); setErrorScope("grant"); setError(""); setFeedback("");
    try {
      await workspaceApi(`conversations/${conversationId}/grants/${id}`, { method: "DELETE" });
      if (!mounted.current) return;
      setFeedback("授权已撤销，原文件保持不变。"); await load();
    } catch (failure) { if (mounted.current) setError((failure as Error).message); }
    finally { if (mounted.current) setPending(null); }
  }
  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !workspace?.project_id || !projectPath.trim()) return;
    setPending("project"); setErrorScope("project"); setError(""); setFeedback("");
    try {
      await workspaceApi(`projects/${workspace.project_id}`, { method: "PATCH", body: JSON.stringify({ workspace_path: projectPath.trim() }) });
      if (!mounted.current) return;
      setEditProject(false); setFeedback("项目目录已保存，后续任务使用新目录，已有文件不搬迁。"); await load(); await onProjectSaved();
    } catch (failure) { if (mounted.current) setError((failure as Error).message); }
    finally { if (mounted.current) setPending(null); }
  }
  function show() { setPicker(null); setOpen(true); setErrorScope(null); setError(""); setFeedback(""); setEditProject(false); void load(); }
  function close() { if (!pending) { setPicker(null); setOpen(false); } }
  return <>
    <div className="conversation-workspace-bar">
      <div className="conversation-cwd"><Folder size={15} /><span>{loading ? "正在加载工作目录…" : workspace?.root_dir ?? "工作目录未设置"}</span></div>
      <button className="secondary-button compact-button" onClick={show} aria-haspopup="dialog"><ShieldCheck size={15} />目录与授权{workspace?.grants.length ? <span className="count-badge">{workspace.grants.length}</span> : null}</button>
    </div>
    {!loading && (loadError || !workspace?.available) && <div className="workspace-inline-error" role="alert"><span>{loadError || workspace?.error || "请先设置可用的工作目录"}</span><button className="text-button" onClick={loadError ? () => void load() : show}>{loadError ? "重试" : "设置目录"}</button></div>}
    {open && <Dialog title="工作目录与授权" className="workspace-access-dialog" onClose={close}>
      <section className="workspace-access-section"><h3>当前工作目录</h3>{loading ? <p className="workspace-loading" role="status"><LoaderCircle size={16} className="spin" />正在加载…</p> : loadError ? <div><p className="form-error" role="alert">{loadError}</p><button className="secondary-button" onClick={() => void load()}><RefreshCw size={15} />重试</button></div> : workspace && <>
        <div className="workspace-current"><span className="workspace-kind">{workspace.kind === "project" ? workspace.project_name : "默认工作目录"}</span><code>{workspace.root_dir ?? "未设置项目目录"}</code>{!workspace.available && <p className="form-error" role="alert">{workspace.error || "工作目录不可用"}</p>}</div>
        {workspace.kind === "project" ? !editProject && <button className="text-button" onClick={() => { setProjectPath(workspace.root_dir ?? ""); setEditProject(true); setError(""); }} disabled={busy}>{workspace.root_dir ? "修改项目目录" : "设置项目目录"}</button> : <button className="text-button" onClick={() => { setPicker(null); setOpen(false); onDefaultSettings(); }} disabled={!!pending}>修改默认工作目录</button>}
        {editProject && <form className="workspace-project-form" onSubmit={saveProject}><label htmlFor="edit-project-workspace-path">项目工作目录</label><div className="path-field"><input id="edit-project-workspace-path" className="form-input path-input" value={projectPath} onChange={(event) => { setProjectPath(event.target.value); setError(""); }} disabled={busy} autoComplete="off" spellCheck={false} required /><button type="button" className="secondary-button" aria-label="浏览项目工作目录" onClick={(event) => { if (busy) return; pickerTrigger.current = event.currentTarget; setErrorScope("project"); setError(""); setFeedback(""); setPicker("project"); }} disabled={busy}><FolderOpen size={16} />浏览</button></div>{error && errorScope === "project" && <p className="form-error" role="alert">{error}</p>}<p className="field-hint">后续任务使用新目录，已有文件不会自动搬迁。</p><div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => { setPicker(null); setEditProject(false); }} disabled={!!pending}>取消修改</button><button className="primary-button" type="submit" disabled={busy || !projectPath.trim()}>{pending === "project" && <LoaderCircle size={15} className="spin" />}保存项目目录</button></div></form>}
      </>}</section>
      <section className="workspace-access-section"><h3>外部路径授权</h3>
        {workspace?.grants.length ? <ul className="workspace-grants">{workspace.grants.map((item) => <li key={item.id}><span className="grant-icon">{item.kind === "directory" ? <Folder size={18} /> : <FileText size={18} />}</span><div className="grant-content"><code>{item.path}</code><span>{item.kind === "directory" ? "目录" : "文件"} · {item.access === "read_write" ? "读写" : "只读"}</span><small>Agent 路径：{item.mount_path}{item.kind === "file" ? item.path.split(/[\\/]/).pop() : ""}</small></div><button className="secondary-button compact-button" aria-label={`撤销对 ${item.path} 的授权`} onClick={() => void revoke(item.id)} disabled={busy}>{pending === item.id && <LoaderCircle size={14} className="spin" />}撤销</button></li>)}</ul> : <p className="workspace-grants-empty">当前会话还没有外部路径授权。</p>}
        <form className="grant-form" onSubmit={grant} aria-busy={pending === "grant" || picker === "grant"}><div className="workspace-field"><label htmlFor="grant-path">外部路径</label><div className="path-field"><input id="grant-path" className="form-input path-input" value={path} onChange={(event) => { setPath(event.target.value); setError(""); }} placeholder="选择文件或目录，或输入绝对路径" autoComplete="off" spellCheck={false} required disabled={busy} /><button type="button" className="secondary-button" aria-label="浏览外部路径" onClick={(event) => { if (busy) return; pickerTrigger.current = event.currentTarget; setErrorScope("grant"); setError(""); setFeedback(""); setPicker("grant"); }} disabled={busy}><FolderOpen size={16} />浏览</button></div>{error && errorScope === "grant" && <p className="form-error" role="alert">{error}</p>}</div><div className="grant-access-row"><div className="workspace-field"><label htmlFor="grant-access">访问权限</label><select id="grant-access" className="form-input" value={access} onChange={(event) => setAccess(event.target.value as "read" | "read_write")} disabled={busy}><option value="read">只读</option><option value="read_write">读写</option></select></div><button className="primary-button" type="submit" disabled={busy || loading || !path.trim()}>{pending === "grant" && <LoaderCircle size={15} className="spin" />}添加授权</button></div></form>
      </section>
      {error && !errorScope && <p className="form-error" role="alert">{error}</p>}{feedback && <p className="model-feedback success" role="status"><CheckCircle2 size={16} />{feedback}</p>}
      <div className="dialog-actions"><button className="secondary-button" onClick={close} disabled={!!pending}>完成</button></div>
    </Dialog>}
    {open && picker && <DirectoryPicker title={picker === "grant" ? "选择授权路径" : "选择项目工作目录"} initialPath={picker === "project" ? projectPath : path} includeFiles={picker === "grant"} returnFocusRef={pickerTrigger} onError={(message) => { setErrorScope(picker); setPicker(null); setError(message); setFeedback(""); }} onClose={() => setPicker(null)} onSelect={(value) => { if (picker === "grant") setPath(value); else setProjectPath(value); setPicker(null); setError(""); }} />}
  </>;
}
