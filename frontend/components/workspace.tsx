"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { CopilotChat, CopilotKitProvider, useAgent } from "@copilotkit/react-core/v2";
import {
  ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleHelp, CornerDownLeft,
  FileText, Folder, FolderPlus, KeyRound, LoaderCircle, MessageCircle, MoreHorizontal,
  PanelLeftClose, PanelLeftOpen, PenLine, Pin, Plus, Search, Settings2, Trash2, X,
} from "lucide-react";
import { Dialog } from "./dialog";

type Project = { id: string; name: string; created_at: string };
type Conversation = { id: string; title: string; project_id: string | null; pinned: boolean; created_at: string; updated_at: string };
type SearchResult = { id: string; title: string; project_id: string | null; project_name: string | null; snippet: string; updated_at: string };
type Health = { status: string; model: string; model_configured: boolean };
type EditDialog = { mode: "rename" | "move"; conversation: Conversation } | null;

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/backend/${path}`, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  if (!response.ok) {
    let detail = "请求未完成，请重试";
    try { const body = await response.json(); if (typeof body.detail === "string") detail = body.detail; } catch { /* An unavailable backend may return HTML. */ }
    throw new Error(detail);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

function relativeTime(value: string) {
  const parsed = new Date(value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`).getTime();
  const minutes = Math.max(0, (Date.now() - parsed) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "刚刚";
  if (minutes < 60) return `${Math.floor(minutes)}分钟`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}天`;
  return new Date(parsed).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function Mark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark ${small ? "brand-mark-small" : ""}`} aria-hidden="true"><span /><span /><span /><span /></span>;
}

const HiddenControl = () => null;

function ConversationMenu({ conversation, position, onClose, onAction }: {
  conversation: Conversation;
  position: { x: number; y: number };
  onClose: () => void;
  onAction: (action: "rename" | "pin" | "move" | "delete", conversation: Conversation) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: globalThis.MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [onClose]);
  return createPortal(<div className="conversation-menu" role="menu" ref={ref} style={{ left: Math.min(position.x, window.innerWidth - 198), top: Math.min(position.y, window.innerHeight - 185) }}>
    <button role="menuitem" onClick={() => onAction("rename", conversation)}><PenLine size={15} />重命名</button>
    <button role="menuitem" onClick={() => onAction("pin", conversation)}><Pin size={15} />{conversation.pinned ? "取消置顶" : "置顶会话"}</button>
    <button role="menuitem" onClick={() => onAction("move", conversation)}><Folder size={15} />移动到项目</button>
    <div className="menu-divider" />
    <button role="menuitem" className="danger" onClick={() => onAction("delete", conversation)}><Trash2 size={15} />删除会话</button>
  </div>, document.body);
}

function ChatPane({ conversation, configured, onError, onUpdate }: {
  conversation: Conversation;
  configured: boolean;
  onError: (message: string) => void;
  onUpdate: () => void;
}) {
  const { agent, isReady } = useAgent({ agentId: "assistant" });
  const running = agent.isRunning;
  const empty = agent.threadId === conversation.id && agent.messages.length === 0;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) onUpdate();
    wasRunning.current = running;
  }, [running, onUpdate]);
  return <div className="chat-pane">
    <CopilotChat agentId="assistant" threadId={conversation.id} className="workspace-chat"
      welcomeScreen={false} inspectorTools={false}
      input={{
        className: "workspace-input", autoFocus: configured,
        textArea: { disabled: !configured, "aria-label": "发送给 Agent 的消息" },
        sendButton: { ...(!configured ? { disabled: true } : {}), "aria-label": running ? "停止生成" : "发送消息" },
        addMenuButton: HiddenControl, startTranscribeButton: HiddenControl,
      }}
      messageView={{ assistantMessage: { thumbsUpButton: HiddenControl, thumbsDownButton: HiddenControl, readAloudButton: HiddenControl, regenerateButton: HiddenControl } }}
      labels={{
        chatInputPlaceholder: configured ? "描述你的任务…" : "配置 DeepSeek API Key 后即可开始对话",
        welcomeMessageText: "今天，我们从哪里开始？",
        chatDisclaimerText: "Enter 发送 · Shift + Enter 换行",
        chatInputToolbarAddButtonLabel: "添加附件",
        chatInputToolbarToolsButtonLabel: "工具",
        assistantMessageToolbarCopyCodeLabel: "复制代码",
        assistantMessageToolbarCopyCodeCopiedLabel: "已复制",
        assistantMessageToolbarCopyMessageLabel: "复制回复",
        assistantMessageToolbarThumbsUpLabel: "有帮助",
        assistantMessageToolbarThumbsDownLabel: "需要改进",
        assistantMessageToolbarReadAloudLabel: "朗读",
        assistantMessageToolbarRegenerateLabel: "重新生成",
        userMessageToolbarCopyMessageLabel: "复制消息",
        userMessageToolbarEditMessageLabel: "编辑消息",
      }}
      onError={(event) => { if ("error" in event) onError(event.error.message || "Agent 暂时无法回复，请检查模型配置并重试"); }} />
    {empty && !running && <div className="chat-empty" aria-live="polite"><span className="empty-symbol"><MessageCircle size={26} strokeWidth={1.3} /></span><h2>一个新的开始</h2><p>写下你的问题，让思路在这里展开。</p><span className="small-hint">这个任务的对话会自动保存</span></div>}
    {!isReady && <span className="chat-connecting"><LoaderCircle className="spin" size={13} />正在连接 Agent</span>}
  </div>;
}

export default function Workspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [currentProject, setCurrentProject] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [projectDialog, setProjectDialog] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [editDialog, setEditDialog] = useState<EditDialog>(null);
  const [editValue, setEditValue] = useState("");
  const [menu, setMenu] = useState<{ conversation: Conversation; position: { x: number; y: number } } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const initialized = useRef(false);
  const active = conversations.find((conversation) => conversation.id === activeId);
  const selectedProject = projects.find((project) => project.id === (active?.project_id ?? currentProject));

  const notify = useCallback((message: string) => setToast(message), []);
  const refresh = useCallback(async () => {
    try {
      const [nextProjects, nextConversations, nextHealth] = await Promise.all([
        api<Project[]>("projects"), api<Conversation[]>("conversations"), api<Health>("health"),
      ]);
      setProjects(nextProjects);
      setConversations(nextConversations);
      setHealth(nextHealth);
      setLoadError(false);
      if (!initialized.current) {
        initialized.current = true;
        const saved = localStorage.getItem("agent-workspace-active-thread");
        if (saved && nextConversations.some((conversation) => conversation.id === saved)) setActiveId(saved);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (initialized.current) {
      if (activeId) localStorage.setItem("agent-workspace-active-thread", activeId);
      else localStorage.removeItem("agent-workspace-active-thread");
    }
  }, [activeId]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6500);
    return () => clearTimeout(timer);
  }, [toast]);

  const openConversation = useCallback((conversation: Pick<Conversation, "id" | "project_id">) => {
    setActiveId(conversation.id);
    setCurrentProject(conversation.project_id);
    if (conversation.project_id) setCollapsedProjects((previous) => {
      const next = new Set(previous);
      next.delete(conversation.project_id as string);
      return next;
    });
    setSidebarOpen(false);
    setSearchOpen(false);
  }, []);

  const createTask = useCallback(async (projectId?: string | null) => {
    if (creating) return;
    setCreating(true);
    try {
      const conversation = await api<Conversation>("conversations", { method: "POST", body: JSON.stringify({ project_id: projectId === undefined ? currentProject : projectId }) });
      setConversations((previous) => [conversation, ...previous]);
      openConversation(conversation);
    } catch (error) { notify((error as Error).message); }
    finally { setCreating(false); }
  }, [creating, currentProject, openConversation, notify]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen((previous) => !previous); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n" && !projectDialog && !editDialog && !searchOpen) { event.preventDefault(); void createTask(); }
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [createTask, projectDialog, editDialog, searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    if (!query.trim()) {
      setResults(conversations.slice(0, 10).map((conversation) => ({
        ...conversation,
        project_name: projects.find((project) => project.id === conversation.project_id)?.name ?? null,
        snippet: "",
      })));
      setSearching(false);
      setSearchError("");
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    setSearchError("");
    const timer = setTimeout(async () => {
      try {
        const data = await api<SearchResult[]>(`search?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        setResults(data);
      } catch (error) {
        if ((error as Error).name !== "AbortError") setSearchError("搜索暂时不可用，请稍后重试");
      } finally { if (!controller.signal.aborted) setSearching(false); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, searchOpen, conversations, projects]);

  const pinned = useMemo(() => conversations.filter((conversation) => conversation.pinned), [conversations]);
  const ungrouped = useMemo(() => conversations.filter((conversation) => !conversation.project_id && !conversation.pinned), [conversations]);

  async function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectName.trim() || creating) return;
    setCreating(true); setFormError("");
    try {
      const project = await api<Project>("projects", { method: "POST", body: JSON.stringify({ name: projectName.trim() }) });
      setProjects((previous) => [...previous, project]);
      setCurrentProject(project.id); setActiveId(null); setProjectDialog(false); setProjectName("");
      notify("项目已创建，可以开始第一个任务了");
    } catch (error) { setFormError((error as Error).message); }
    finally { setCreating(false); }
  }

  async function patchConversation(conversation: Conversation, patch: Partial<Pick<Conversation, "title" | "pinned" | "project_id">>) {
    const updated = await api<Conversation>(`conversations/${conversation.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    setConversations((previous) => previous.map((item) => item.id === updated.id ? updated : item));
    if (activeId === updated.id) setCurrentProject(updated.project_id);
  }

  async function menuAction(action: "rename" | "pin" | "move" | "delete", conversation: Conversation) {
    setMenu(null);
    if (action === "rename" || action === "move") {
      setEditDialog({ mode: action, conversation });
      setEditValue(action === "rename" ? conversation.title : (conversation.project_id ?? "")); setFormError(""); return;
    }
    try {
      if (action === "pin") await patchConversation(conversation, { pinned: !conversation.pinned });
      if (action === "delete" && window.confirm(`删除「${conversation.title}」？这会删除该会话的历史记录。`)) {
        await api<void>(`conversations/${conversation.id}`, { method: "DELETE" });
        setConversations((previous) => previous.filter((item) => item.id !== conversation.id));
        if (activeId === conversation.id) setActiveId(null);
        notify("会话已删除");
      }
    } catch (error) { notify((error as Error).message); }
  }

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editDialog || creating || (editDialog.mode === "rename" && !editValue.trim())) return;
    setCreating(true); setFormError("");
    try {
      await patchConversation(editDialog.conversation, editDialog.mode === "rename" ? { title: editValue.trim() } : { project_id: editValue || null });
      setEditDialog(null);
    } catch (error) { setFormError((error as Error).message); }
    finally { setCreating(false); }
  }

  function showMenu(event: MouseEvent<HTMLButtonElement>, conversation: Conversation) {
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    setMenu({ conversation, position: { x: bounds.right - 185, y: bounds.bottom + 5 } });
  }

  function conversationRow(conversation: Conversation, indented = false) {
    return <div key={conversation.id} className={`conversation-row ${activeId === conversation.id ? "is-active" : ""} ${indented ? "indented" : ""}`}>
      <button className="conversation-select" onClick={() => openConversation(conversation)} title={conversation.title} aria-current={activeId === conversation.id ? "page" : undefined}>
        {conversation.pinned ? <Pin size={14} /> : <MessageCircle size={14} />}<span>{conversation.title}</span><time>{relativeTime(conversation.updated_at)}</time>
      </button>
      <button className="conversation-options" onClick={(event) => showMenu(event, conversation)} aria-label={`${conversation.title}的更多操作`}><MoreHorizontal size={17} /></button>
    </div>;
  }

  const beginProject = () => { setProjectName(""); setFormError(""); setProjectDialog(true); };

  return <CopilotKitProvider runtimeUrl="/api/copilotkit" agentId="assistant" enableInspector={false} showIntelligenceIndicator={false}>
    <div className="workspace-shell">
      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="关闭侧栏" />}
      <aside className={`sidebar ${sidebarOpen ? "sidebar-mobile-open" : ""}`} aria-label="工作空间导航">
        <div className="sidebar-brand"><button className="brand-home" onClick={() => { setActiveId(null); setCurrentProject(null); setSidebarOpen(false); }}><Mark small /><span>拾序<span className="brand-subtitle">Shixu Work</span></span></button><button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="收起侧栏"><PanelLeftClose size={18} /></button><span className="demo-badge">DEMO</span></div>
        <div className="sidebar-actions">
          <button className="nav-action new-task" aria-label="新建任务" onClick={() => void createTask()} disabled={creating || loadError}><PenLine size={17} /><span>新建任务</span>{creating ? <LoaderCircle size={14} className="spin" /> : <kbd aria-hidden="true">⌘ N</kbd>}</button>
          <button className="nav-action" aria-label="搜索会话" onClick={() => setSearchOpen(true)}><Search size={17} /><span>搜索会话</span><kbd aria-hidden="true">⌘ K</kbd></button>
        </div>
        <div className="sidebar-scroll">
          <div className="list-heading"><span>已置顶</span><Pin size={12} /></div>
          {pinned.length ? pinned.map((conversation) => conversationRow(conversation)) : <p className="list-empty">重要的会话，可以留在这里</p>}
          <div className="list-heading projects-heading"><span>项目</span><button className="icon-button" onClick={beginProject} aria-label="创建项目" title="创建项目"><Plus size={16} /></button></div>
          {loading ? <div className="sidebar-skeleton"><span /><span /><span /></div> : projects.length ? projects.map((project) => {
            const items = conversations.filter((conversation) => conversation.project_id === project.id && !conversation.pinned);
            const collapsed = collapsedProjects.has(project.id);
            return <div className="project-group" key={project.id}>
              <div className={`project-row ${currentProject === project.id ? "project-selected" : ""}`}>
                <button className="project-toggle" aria-expanded={!collapsed} onClick={() => { setCurrentProject(project.id); setCollapsedProjects((previous) => { const next = new Set(previous); if (next.has(project.id)) next.delete(project.id); else next.add(project.id); return next; }); }}>
                  {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<Folder size={16} /><span>{project.name}</span><span className="project-count">{conversations.filter((conversation) => conversation.project_id === project.id).length}</span>
                </button><button className="project-add" onClick={() => void createTask(project.id)} disabled={creating} title="在此项目中新建任务" aria-label={`在${project.name}中新建任务`}><Plus size={15} /></button>
              </div>
              {!collapsed && <div className="project-conversations">{items.length ? items.map((conversation) => conversationRow(conversation, true)) : <p className="project-empty">暂无任务</p>}</div>}
            </div>;
          }) : <button className="first-project" onClick={beginProject}><FolderPlus size={17} /><span>创建第一个项目</span><Plus size={13} /></button>}
          <div className="list-heading recent-heading"><span>未分组会话</span><span className="count-badge">{ungrouped.length}</span></div>
          {ungrouped.length ? ungrouped.map((conversation) => conversationRow(conversation)) : <p className="list-empty">每个想法都可以成为一个任务</p>}
        </div>
        <div className="sidebar-footer"><span className="user-avatar">L</span><span className="user-info">本地工作空间<span><i />数据保存在本机</span></span><button className="icon-button" aria-label="使用说明" title="使用说明" onClick={() => setHelpOpen(true)}><Settings2 size={17} /></button></div>
      </aside>
      <main className="main-panel">
        <header className="workspace-header"><div className="header-title"><button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="展开侧栏"><PanelLeftOpen size={19} /></button><Folder size={17} className="header-folder" /><span>{active?.title ?? selectedProject?.name ?? "工作空间"}</span>{active && <button className="icon-button header-more" onClick={(event) => showMenu(event, active)} aria-label="当前任务的更多操作"><MoreHorizontal size={18} /></button>}</div><div className="header-meta">{selectedProject && active && <span className="header-project">{selectedProject.name}</span>}<span className="model-badge"><i />DeepSeek<span>flash</span></span><button className="icon-button header-help" onClick={() => setHelpOpen(true)} aria-label="帮助"><CircleHelp size={17} /></button></div></header>
        {loadError && <div className="connection-banner"><span><LoaderCircle size={15} />无法连接后端，请确认服务已启动</span><button onClick={() => void refresh()}>重试</button></div>}
        {!loadError && health && !health.model_configured && <div className="setup-banner"><span><KeyRound size={15} /><span>还差一步：在 <code>backend/.env</code> 中配置 <code>DEEPSEEK_API_KEY</code>，然后重启后端。</span></span><button onClick={() => setHelpOpen(true)}>查看说明<ArrowUpRight size={13} /></button></div>}
        {active ? <ChatPane conversation={active} configured={!!health?.model_configured} onError={notify} onUpdate={refresh} /> : <div className="welcome-view">
          <div className="welcome-content"><div className="welcome-eyebrow"><span />你的专属 Agent 工作空间</div><Mark /><h1>{selectedProject ? <>在「{selectedProject.name}」里，<br />开始一个新任务。</> : <>让想法，<br />从这里开始。</>}</h1><p>和 Agent 一起梳理问题、整理思路。<br />每段对话，都会成为下一次出发的起点。</p><div className="welcome-actions"><button className="primary-button" onClick={() => void createTask()} disabled={creating || loadError}>{creating ? <LoaderCircle size={17} className="spin" /> : <Plus size={17} />}新建任务<ArrowRight size={16} /></button><button className="secondary-button" onClick={beginProject}><FolderPlus size={16} />创建项目</button></div><div className="welcome-cards"><button onClick={() => void createTask()} disabled={creating || loadError}><span className="welcome-card-icon"><MessageCircle size={19} /></span><strong>从一个问题开始</strong><span>提问、分析，让思路变得清晰</span><ArrowUpRight className="card-arrow" size={16} /></button><button onClick={beginProject}><span className="welcome-card-icon"><Folder size={19} /></span><strong>给工作一个归处</strong><span>用项目整理相关任务和对话</span><ArrowUpRight className="card-arrow" size={16} /></button></div><div className="welcome-footnote"><span className="footnote-line" /><span><Check size={13} />会话自动保存</span><span><Search size={13} />随时搜索历史</span><span className="footnote-line" /></div></div>
          <span className="welcome-page-note">少一些切换，多一些专注。</span>
        </div>}
      </main>
      {toast && <div className="toast" role="status"><span>{toast}</span><button className="icon-button" onClick={() => setToast(null)} aria-label="关闭提示"><X size={15} /></button></div>}
      {menu && <ConversationMenu {...menu} onClose={() => setMenu(null)} onAction={(action, conversation) => void menuAction(action, conversation)} />}
      {projectDialog && <Dialog title="创建项目" onClose={() => { if (!creating) setProjectDialog(false); }}><form onSubmit={submitProject}><p className="dialog-description">把相关的任务和思路，放在同一个地方。</p><label htmlFor="project-name">项目名称</label><input autoFocus id="project-name" className="form-input" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="例如：产品研究、个人学习" maxLength={80} required /><p className="field-hint">你可以在项目中创建多个独立会话。</p>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setProjectDialog(false)} disabled={creating}>取消</button><button type="submit" className="primary-button" disabled={creating || !projectName.trim()}>{creating && <LoaderCircle size={15} className="spin" />}创建项目</button></div></form></Dialog>}
      {editDialog && <Dialog title={editDialog.mode === "rename" ? "重命名会话" : "移动到项目"} onClose={() => { if (!creating) setEditDialog(null); }}><form onSubmit={submitEdit}><p className="dialog-description">{editDialog.mode === "rename" ? "一个清晰的名字，让你更容易找回这段对话。" : "会话内容和 Agent 的上下文会一起保留。"}</p><label htmlFor="edit-value">{editDialog.mode === "rename" ? "会话名称" : "目标项目"}</label>{editDialog.mode === "rename" ? <input autoFocus id="edit-value" className="form-input" value={editValue} onChange={(event) => setEditValue(event.target.value)} maxLength={120} required /> : <select autoFocus id="edit-value" className="form-input" value={editValue} onChange={(event) => setEditValue(event.target.value)}><option value="">未分组会话</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>}{formError && <p className="form-error" role="alert">{formError}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setEditDialog(null)} disabled={creating}>取消</button><button type="submit" className="primary-button" disabled={creating || (editDialog.mode === "rename" && !editValue.trim())}>{creating && <LoaderCircle size={15} className="spin" />}保存</button></div></form></Dialog>}
      {searchOpen && <Dialog title="搜索会话" className="search-dialog" onClose={() => setSearchOpen(false)}><div className="search-input-wrap"><Search size={20} /><input autoFocus aria-label="搜索会话标题或消息内容" placeholder="搜索会话标题或消息内容…" value={query} onChange={(event) => setQuery(event.target.value)} />{searching && <LoaderCircle size={17} className="spin" />}</div><div className="search-caption">{query.trim() ? "搜索结果" : "最近的会话"}<span>{!searching && `${results.length} 个会话`}</span></div><div className="search-results">{searchError ? <p className="search-empty" role="alert">{searchError}</p> : results.length ? results.map((result) => <button className="search-result" key={result.id} onClick={() => { openConversation(result); if (!conversations.some((conversation) => conversation.id === result.id)) void refresh(); }}><MessageCircle size={18} /><span className="search-result-content"><strong>{result.title}</strong>{result.snippet && <span>{result.snippet}</span>}<small>{result.project_name ?? "未分组会话"} · {relativeTime(result.updated_at)}</small></span><CornerDownLeft size={14} /></button>) : <div className="search-empty"><Search size={28} strokeWidth={1.2} /><p>{searching ? "正在搜索…" : query.trim() ? "没有找到匹配的会话" : "还没有会话记录"}</p><span>{!searching && (query.trim() ? "试试另一个关键词" : "新建一个任务，开始你的第一段对话")}</span></div>}</div><div className="search-bottom"><span><kbd>Esc</kbd>关闭</span><span>搜索标题与已保存的消息</span></div></Dialog>}
      {helpOpen && <Dialog title="使用拾序" onClose={() => setHelpOpen(false)}><div className="help-content"><p>这是一个单用户的本地 Web Demo。新建任务后，右侧即可开始对话；项目用于整理相关会话。</p><div className="help-block"><KeyRound size={19} /><div><strong>连接 DeepSeek</strong><p>在项目的 <code>backend/.env</code> 文件里填写 <code>DEEPSEEK_API_KEY</code>，保存后重启后端服务。</p><small>模型固定使用 deepseek-flash。密钥只由后端读取。</small></div></div><div className="help-block"><FileText size={19} /><div><strong>对话自动保存</strong><p>刷新页面或重新启动服务后，可以从左侧继续已有会话。用搜索找到标题或消息中的关键词。</p></div></div><div className="help-shortcuts"><span><kbd>⌘ / Ctrl K</kbd>搜索会话</span><span><kbd>Enter</kbd>发送消息</span><span><kbd>Shift Enter</kbd>消息换行</span></div></div></Dialog>}
    </div>
  </CopilotKitProvider>;
}
