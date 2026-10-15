"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, CheckCircle2, Cpu, Folder, FolderOpen, LoaderCircle, RefreshCw, Settings2 } from "lucide-react";
import { workspaceApi } from "@/lib/workspace-api";
import { Dialog } from "./dialog";
import { DirectoryPicker } from "./directory-picker";

type WorkspaceSettingsValue = { default_workspace_path: string };

export function WorkspaceSettings({ onBack, onModel, onSaved }: { onBack: () => void; onModel: () => void; onSaved: () => void | Promise<void> }) {
  const [saved, setSaved] = useState<WorkspaceSettingsValue | null>(null);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [leave, setLeave] = useState<"back" | "model" | null>(null);
  const pickerTrigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  const dirty = !!saved && path !== saved.default_workspace_path;
  const load = useCallback(async () => {
    setLoading(true); setError(""); setFeedback("");
    try {
      const value = await workspaceApi<WorkspaceSettingsValue>("settings/workspace");
      if (mounted.current) { setSaved(value); setPath(value.default_workspace_path); }
    } catch (failure) { if (mounted.current) setError((failure as Error).message); }
    finally { if (mounted.current) setLoading(false); }
  }, []);
  useEffect(() => { mounted.current = true; heading.current?.focus(); void load(); return () => { mounted.current = false; }; }, [load]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function navigate(destination: "back" | "model") {
    setPickerOpen(false);
    if (dirty) setLeave(destination);
    else if (destination === "model") onModel(); else onBack();
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || pickerOpen || !path.trim()) return;
    setSaving(true); setError(""); setFeedback("");
    try {
      const result = await workspaceApi<WorkspaceSettingsValue>("settings/workspace", { method: "PUT", body: JSON.stringify({ default_workspace_path: path.trim() }) });
      if (!mounted.current) return;
      setSaved(result); setPath(result.default_workspace_path); setFeedback("工作目录已保存，未分组会话的后续任务将使用此目录。");
      await onSaved();
    } catch (failure) { if (mounted.current) setError((failure as Error).message); }
    finally { if (mounted.current) setSaving(false); }
  }
  return <div className="settings-shell" data-testid="workspace-settings">
    <aside className="settings-sidebar" aria-label="配置导航">
      <div className="settings-brand"><span className="settings-brand-icon"><Settings2 size={20} /></span><span>工作空间配置</span></div>
      <button className="settings-back" onClick={() => navigate("back")} disabled={saving}><ArrowLeft size={17} />返回工作区</button>
      <p className="settings-nav-heading">基础设置</p>
      <nav><button className="settings-nav-item" onClick={() => navigate("model")} disabled={saving}><Cpu size={18} />模型配置</button><button className="settings-nav-item" aria-current="page"><Folder size={18} />工作目录</button></nav>
      <div className="settings-sidebar-bottom"><span className="user-avatar">拾</span><span>拾序<span>Shixu Work</span></span></div>
    </aside>
    <main className="settings-main"><header className="settings-topbar"><span>配置</span></header><div className="settings-scroll"><div className="settings-content">
      <div className="settings-page-heading"><div><h1 ref={heading} tabIndex={-1}>工作目录</h1><p>设置未分组会话保存和处理文件的位置。</p></div></div>
      {loading ? <div className="workspace-settings-card settings-load-state" role="status"><LoaderCircle size={22} className="spin" />正在加载工作目录…</div> : !saved ? <div className="workspace-settings-card settings-load-state"><p role="alert">{error}</p><button className="secondary-button" onClick={() => void load()}><RefreshCw size={16} />重新加载</button></div> : <form className="workspace-settings-card" onSubmit={save} aria-busy={saving || pickerOpen}>
        <div className="workspace-field"><label htmlFor="default-workspace-path">默认工作目录</label><div className="path-field"><input id="default-workspace-path" className="form-input path-input" value={path} onChange={(event) => { setPath(event.target.value); setError(""); setFeedback(""); }} autoComplete="off" spellCheck={false} disabled={saving || pickerOpen} required /><button type="button" className="secondary-button" aria-label="浏览默认工作目录" onClick={(event) => { if (saving || pickerOpen) return; pickerTrigger.current = event.currentTarget; setError(""); setFeedback(""); setPickerOpen(true); }} disabled={saving || pickerOpen}><FolderOpen size={16} />浏览</button></div></div>
        {error && <p className="form-error" role="alert">{error}</p>}{feedback && <p className="model-feedback success" role="status"><CheckCircle2 size={16} />{feedback}</p>}
        <div className="workspace-save-actions"><button type="submit" className="primary-button" disabled={saving || pickerOpen || !dirty || !path.trim()}>{saving && <LoaderCircle size={16} className="spin" />}保存工作目录</button></div>
      </form>}
    </div></div></main>
    {pickerOpen && !leave && <DirectoryPicker title="选择默认工作目录" initialPath={path} returnFocusRef={pickerTrigger} onClose={() => setPickerOpen(false)} onError={(message) => { setPickerOpen(false); setError(message); setFeedback(""); }} onSelect={(selected) => { setPath(selected); setPickerOpen(false); setError(""); setFeedback(""); }} />}
    {leave && <Dialog title="放弃未保存的修改？" onClose={() => setLeave(null)}><p className="dialog-description">工作目录的修改尚未保存。</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setLeave(null)}>继续编辑</button><button className="primary-button" onClick={() => { const destination = leave; setLeave(null); if (destination === "model") onModel(); else onBack(); }}>放弃修改</button></div></Dialog>}
  </div>;
}
