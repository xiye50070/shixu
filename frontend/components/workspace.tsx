"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { CopilotChat, CopilotKitProvider, useAgent } from "@copilotkit/react-core/v2";
import {
  ArrowRight, ChevronDown, ChevronRight, CircleHelp, CornerDownLeft,
  FileText, Folder, FolderOpen, FolderPlus, KeyRound, LoaderCircle, MessageCircle, MoreHorizontal,
  PanelLeftClose, PanelLeftOpen, PenLine, Pin, Plus, Search, Settings2, Trash2, X,
} from "lucide-react";
import { Dialog } from "./dialog";
import { ModelSettings } from "./model-settings";
import { DirectoryPicker } from "./directory-picker";
import { WorkspaceSettings } from "./workspace-settings";
import { WorkspaceAccess } from "./workspace-access";

type Project = { id: string; name: string; workspace_path: string | null; created_at: string };
type Conversation = { id: string; title: string; project_id: string | null; pinned: boolean; created_at: string; updated_at: string };
type SearchResult = { id: string; title: string; project_id: string | null; project_name: string | null; snippet: string; updated_at: string };
type Health = { status: string; model: string; model_configured: boolean; provider?: "deepseek" | "openai" };
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

function ConversationMenu({ conversation, position, trigger, onClose, onAction }: {
  conversation: Conversation;
  position: { x: number; y: number };
  trigger: HTMLButtonElement;
  onClose: () => void;
  onAction: (action: "rename" | "pin" | "move" | "delete", conversation: Conversation) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const portalTarget = trigger.closest('[role="dialog"][aria-modal="true"]') ?? document.body;
  useEffect(() => {
    const element = ref.current;
    if (element) {
      const bounds = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - bounds.width - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - bounds.height - 8))}px`;
      element.querySelector<HTMLButtonElement>("button")?.focus();
    }
    const outside = (event: globalThis.MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener("mousedown", outside);
    return () => {
      document.removeEventListener("mousedown", outside);
      if (trigger.isConnected && (document.activeElement === document.body || element?.contains(document.activeElement))) trigger.focus();
    };
  }, [onClose, trigger, position.x, position.y]);
  return createPortal(<div className="conversation-menu" role="menu" aria-label={`${conversation.title}的更多操作`} ref={ref} style={{ left: Math.max(8, Math.min(position.x, window.innerWidth - 198)), top: Math.max(8, Math.min(position.y, window.innerHeight - 185)) }} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === "Tab") { onClose(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[nextIndex]?.focus();
  }}>
    <button role="menuitem" tabIndex={-1} onClick={() => onAction("rename", conversation)}><PenLine size={15} />重命名</button>
    <button role="menuitem" tabIndex={-1} onClick={() => onAction("pin", conversation)}><Pin size={15} />{conversation.pinned ? "取消置顶" : "置顶会话"}</button>
    <button role="menuitem" tabIndex={-1} onClick={() => onAction("move", conversation)}><Folder size={15} />移动到项目</button>
    <div className="menu-divider" />
    <button role="menuitem" tabIndex={-1} className="danger" onClick={() => onAction("delete", conversation)}><Trash2 size={15} />删除会话</button>
  </div>, portalTarget);
}

function ProjectMenu({ project, position, trigger, onClose, onDelete }: {
  project: Project;
  position: { x: number; y: number };
  trigger: HTMLButtonElement;
  onClose: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const portalTarget = trigger.closest('[role="dialog"][aria-modal="true"]') ?? document.body;
  useEffect(() => {
    const element = ref.current;
    if (element) {
      const bounds = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - bounds.width - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - bounds.height - 8))}px`;
      element.querySelector<HTMLButtonElement>("button")?.focus();
    }
    const outside = (event: globalThis.MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener("mousedown", outside);
    return () => {
      document.removeEventListener("mousedown", outside);
      if (trigger.isConnected && (document.activeElement === document.body || element?.contains(document.activeElement))) trigger.focus();
    };
  }, [onClose, trigger, position.x, position.y]);
  return createPortal(<div className="conversation-menu project-menu" role="menu" aria-label={`${project.name}的项目操作`} ref={ref} style={{ left: Math.max(8, Math.min(position.x, window.innerWidth - 198)), top: Math.max(8, Math.min(position.y, window.innerHeight - 64)) }} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === "Tab") { onClose(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }}><button role="menuitem" tabIndex={-1} className="danger" onClick={onDelete}><Trash2 size={15} />删除项目</button></div>, portalTarget);
}

function ChatPane({ conversation, configured, workspaceAvailable, onError, onUpdate }: {
  conversation: Conversation;
  configured: boolean;
  workspaceAvailable: boolean;
  onError: (message: string) => void;
  onUpdate: () => void;
}) {
  const { agent, isReady } = useAgent({ agentId: "assistant" });
  const running = agent.isRunning;
  const canSend = configured && workspaceAvailable;
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
        className: "workspace-input", autoFocus: canSend,
        textArea: { disabled: !canSend, "aria-label": "发送给 Agent 的消息" },
        sendButton: { ...(!canSend && !running ? { disabled: true } : {}), "aria-label": running ? "停止生成" : "发送消息" },
        addMenuButton: HiddenControl, startTranscribeButton: HiddenControl,
        disclaimer: { className: "workspace-disclaimer" },
      }}
      messageView={{ userMessage: { messageRenderer: { className: "workspace-user-content" } }, assistantMessage: { thumbsUpButton: HiddenControl, thumbsDownButton: HiddenControl, readAloudButton: HiddenControl, regenerateButton: HiddenControl } }}
      labels={{
        chatInputPlaceholder: !configured ? "配置模型后即可开始对话" : !workspaceAvailable ? "设置可用工作目录后即可开始对话" : "描述你的任务…",
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
    {empty && !running && <div className="chat-empty" aria-live="polite"><span className="empty-symbol"><MessageCircle size={26} strokeWidth={1.3} /></span><h2>开始这个任务</h2><p>写下你想完成的工作，或提出一个问题。</p></div>}
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
  const [mobileViewport, setMobileViewport] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [projectDialog, setProjectDialog] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [projectPicker, setProjectPicker] = useState(false);
  const projectBrowseRef = useRef<HTMLButtonElement | null>(null);
  const [projectToConfigure, setProjectToConfigure] = useState<Project | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [queryComposing, setQueryComposing] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [editDialog, setEditDialog] = useState<EditDialog>(null);
  const [editValue, setEditValue] = useState("");
  const [menu, setMenu] = useState<{ conversation: Conversation; position: { x: number; y: number }; trigger: HTMLButtonElement } | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ project: Project; position: { x: number; y: number }; trigger: HTMLButtonElement } | null>(null);
  const [projectDelete, setProjectDelete] = useState<Project | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [projectDeleteError, setProjectDeleteError] = useState("");
  const projectDeletePending = useRef(false);
  const projectDeleteTrigger = useRef<HTMLButtonElement | null>(null);
  const projectDeleteCancel = useRef<HTMLButtonElement | null>(null);
  const projectDeleteFocus = useRef<{ conversationId?: string; trigger?: HTMLButtonElement | null } | null>(null);
  const deletedProjectIds = useRef(new Set<string>());
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"model" | "workspace">("model");
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [workspaceReadyId, setWorkspaceReadyId] = useState<string | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const initialized = useRef(false);
  const active = conversations.find((conversation) => conversation.id === activeId);
  const selectedProject = projects.find((project) => project.id === (active?.project_id ?? currentProject));
  const mobileDrawerOpen = mobileViewport && sidebarOpen;

  const notify = useCallback((message: string) => setToast(message), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeProjectMenu = useCallback(() => setProjectMenu(null), []);
  const refresh = useCallback(async () => {
    try {
      const [nextProjects, nextConversations, nextHealth] = await Promise.all([
        api<Project[]>("projects"), api<Conversation[]>("conversations"), api<Health>("health"),
      ]);
      setProjects(nextProjects.filter((project) => !deletedProjectIds.current.has(project.id)));
      setConversations(nextConversations.map((conversation) => conversation.project_id && deletedProjectIds.current.has(conversation.project_id) ? { ...conversation, project_id: null } : conversation));
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

  useEffect(() => {
    if (projectDelete || !projectDeleteFocus.current) return;
    const destination = projectDeleteFocus.current;
    projectDeleteFocus.current = null;
    // Wait until the confirmation has unmounted and moved rows are committed.
    requestAnimationFrame(() => {
      const conversationButton = destination.conversationId ? document.querySelector<HTMLButtonElement>(`[data-conversation-id="${CSS.escape(destination.conversationId)}"] .conversation-select`) : null;
      const candidates = [conversationButton, destination.trigger, ...document.querySelectorAll<HTMLButtonElement>('.projects-heading button,.nav-action[aria-label="新建任务"],button[aria-label="展开侧栏"]')];
      candidates.find((button) => button?.isConnected && !button.disabled && button.getClientRects().length > 0 && !button.closest('[inert],dialog:not([open])'))?.focus();
    });
  }, [projectDelete]);

  useLayoutEffect(() => {
    // Disabling the clicked submit button can move focus to document.body.
    // Restore it only after an unsuccessful request has re-enabled the controls,
    // so the dialog receives the next Tab event and retains its keyboard scope.
    if (projectDelete && projectDeleteError && !deletingProject) projectDeleteCancel.current?.focus();
  }, [projectDelete, projectDeleteError, deletingProject]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const updateViewport = () => {
      setMobileViewport(media.matches);
      if (!media.matches) setSidebarOpen(false);
    };
    updateViewport();
    media.addEventListener("change", updateViewport);
    return () => media.removeEventListener("change", updateViewport);
  }, []);

  useEffect(() => {
    if (!mobileDrawerOpen) return;
    const sidebar = sidebarRef.current;
    sidebar?.querySelector<HTMLButtonElement>('button[aria-label="收起侧栏"]')?.focus();
    const handleNavigationKey = (event: KeyboardEvent) => {
      // Dialogs and portalled menus own their keyboard scope while they are open.
      if (document.querySelector("dialog[open]") || (event.target instanceof Element && event.target.closest('[role="menu"]'))) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); setSidebarOpen(false); return;
      }
      if (event.key !== "Tab" || !sidebar) return;
      const items = Array.from(sidebar.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'))
        .filter((item) => item.getClientRects().length > 0 && !item.closest("[inert]"));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first) { event.preventDefault(); sidebar.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", handleNavigationKey);
    return () => {
      document.removeEventListener("keydown", handleNavigationKey);
      const trigger = sidebarTriggerRef.current;
      if (trigger?.isConnected && trigger.getClientRects().length > 0) trigger.focus();
    };
  }, [mobileDrawerOpen]);

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
    setQueryComposing(false);
  }, []);

  const createConversation = useCallback(async (projectId: string | null) => {
    const conversation = await api<Conversation>("conversations", { method: "POST", body: JSON.stringify({ project_id: projectId }) });
    setConversations((previous) => [conversation, ...previous.filter((item) => item.id !== conversation.id)]);
    openConversation(conversation);
  }, [openConversation]);

  const createTask = useCallback(async (projectId?: string | null) => {
    if (creating) return;
    setCreating(true);
    try {
      await createConversation(projectId === undefined ? currentProject : projectId);
    } catch (error) { notify((error as Error).message); }
    finally { setCreating(false); }
  }, [creating, currentProject, createConversation, notify]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (settingsOpen || (document.querySelector("dialog[open]") && !searchOpen)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setQueryComposing(false); setSearchOpen((previous) => !previous); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n" && !projectDialog && !editDialog && !searchOpen) { event.preventDefault(); void createTask(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [createTask, projectDialog, editDialog, searchOpen, settingsOpen]);

  useEffect(() => {
    if (!searchOpen || queryComposing) return;
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
    setResults([]);
    setSearching(true);
    setSearchError("");
    const timer = setTimeout(async () => {
      try {
        const data = await api<SearchResult[]>(`search?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        if (!controller.signal.aborted) setResults(data);
      } catch (error) {
        if (!controller.signal.aborted && (error as Error).name !== "AbortError") setSearchError("搜索暂时不可用，请稍后重试");
      } finally { if (!controller.signal.aborted) setSearching(false); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, queryComposing, searchOpen, conversations, projects]);

  const pinned = useMemo(() => conversations.filter((conversation) => conversation.pinned), [conversations]);
  const ungrouped = useMemo(() => conversations.filter((conversation) => !conversation.project_id && !conversation.pinned), [conversations]);

  async function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectName.trim() || !projectPath.trim() || creating || projectPicker) return;
    setCreating(true); setFormError("");
    try {
      const project = await api<Project>("projects", { method: "POST", body: JSON.stringify({ name: projectName.trim(), workspace_path: projectPath.trim() }) });
      setProjects((previous) => [...previous, project]);
      setCurrentProject(project.id); setActiveId(null);
      try {
        await createConversation(project.id);
        notify("项目已创建，已进入新会话");
      } catch (error) {
        notify(`项目已创建，但新会话创建失败：${(error as Error).message}。请点击“新建任务”重试。`);
      }
      setProjectDialog(false); setProjectName(""); setProjectPath("");
    } catch (error) { setFormError((error as Error).message); }
    finally { setCreating(false); }
  }

  async function patchConversation(conversation: Conversation, patch: Partial<Pick<Conversation, "title" | "pinned" | "project_id">>) {
    const updated = await api<Conversation>(`conversations/${conversation.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    setConversations((previous) => previous.map((item) => item.id === updated.id ? updated : item));
    if (activeId === updated.id) setCurrentProject(updated.project_id);
  }

  async function submitProjectDirectory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectToConfigure || !projectPath.trim() || creating || projectPicker) return;
    setCreating(true); setFormError("");
    try {
      const updated = await api<Project>(`projects/${projectToConfigure.id}`, { method: "PATCH", body: JSON.stringify({ workspace_path: projectPath.trim() }) });
      setProjects((previous) => previous.map((project) => project.id === updated.id ? updated : project));
      setProjectToConfigure(null); setWorkspaceRevision((value) => value + 1);
      notify("项目目录已保存，后续任务使用新目录，已有文件不搬迁。");
    } catch (error) { setFormError((error as Error).message); }
    finally { setCreating(false); }
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
    setProjectMenu(null);
    const bounds = event.currentTarget.getBoundingClientRect();
    setMenu({ conversation, position: { x: bounds.right - 185, y: bounds.bottom + 5 }, trigger: event.currentTarget });
  }

  function showProjectMenu(event: MouseEvent<HTMLButtonElement>, project: Project) {
    event.stopPropagation();
    setMenu(null);
    const bounds = event.currentTarget.getBoundingClientRect();
    setProjectMenu({ project, position: { x: bounds.right - 185, y: bounds.bottom + 5 }, trigger: event.currentTarget });
  }

  function cancelProjectDelete() {
    if (projectDeletePending.current) return;
    projectDeleteFocus.current = { trigger: projectDeleteTrigger.current };
    setProjectDelete(null); setProjectDeleteError("");
  }

  async function submitProjectDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectDelete || projectDeletePending.current) return;
    const project = projectDelete;
    projectDeletePending.current = true;
    setDeletingProject(true); setProjectDeleteError("");
    try {
      await api<void>(`projects/${project.id}`, { method: "DELETE" });
      deletedProjectIds.current.add(project.id);
      const moved = conversations.filter((conversation) => conversation.project_id === project.id);
      const activeMoved = moved.find((conversation) => conversation.id === activeId);
      setProjects((previous) => previous.filter((item) => item.id !== project.id));
      setConversations((previous) => previous.map((conversation) => conversation.project_id === project.id ? { ...conversation, project_id: null } : conversation));
      setCollapsedProjects((previous) => { const next = new Set(previous); next.delete(project.id); return next; });
      if (currentProject === project.id || activeMoved) setCurrentProject(null);
      if (activeMoved) { setWorkspaceReadyId(null); setWorkspaceRevision((value) => value + 1); }
      if (projectToConfigure?.id === project.id) { setProjectToConfigure(null); setProjectPicker(false); }
      setMenu(null); setProjectMenu(null); setSearchOpen(false); setQueryComposing(false); setResults([]); setEditDialog(null);
      projectDeleteFocus.current = { conversationId: activeMoved?.id ?? moved[0]?.id };
      setProjectDelete(null);
      notify("项目已删除，会话已移至未分组，磁盘文件已保留。");
    } catch (error) { setProjectDeleteError((error as Error).message); }
    finally { projectDeletePending.current = false; setDeletingProject(false); }
  }

  function conversationRow(conversation: Conversation, indented = false) {
    return <div key={conversation.id} data-conversation-id={conversation.id} className={`conversation-row ${activeId === conversation.id ? "is-active" : ""} ${indented ? "indented" : ""}`}>
      <button className="conversation-select" onClick={() => openConversation(conversation)} title={conversation.title} aria-current={activeId === conversation.id ? "page" : undefined}>
        {conversation.pinned ? <Pin size={14} /> : <MessageCircle size={14} />}<span>{conversation.title}</span><time>{relativeTime(conversation.updated_at)}</time>
      </button>
      <button className="conversation-options" onClick={(event) => showMenu(event, conversation)} aria-haspopup="menu" aria-expanded={menu?.conversation.id === conversation.id} aria-label={`${conversation.title}的更多操作`}><MoreHorizontal size={17} /></button>
    </div>;
  }

  const beginProject = () => { setProjectName(""); setProjectPath(""); setFormError(""); setProjectDialog(true); };
  const openSettings = (section: "model" | "workspace" = "model") => {
    settingsReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSidebarOpen(false); setMenu(null); setProjectMenu(null); setSettingsSection(section); setSettingsOpen(true);
  };
  const closeSettings = () => {
    setSettingsOpen(false);
    requestAnimationFrame(() => {
      const trigger = settingsReturnFocusRef.current;
      if (trigger?.getClientRects().length && !trigger.closest("[inert]")) trigger.focus();
      else if (sidebarTriggerRef.current?.getClientRects().length) sidebarTriggerRef.current.focus();
      else settingsTriggerRef.current?.focus();
    });
  };
  const workspaceAvailability = useCallback((available: boolean) => { setWorkspaceReadyId(available ? activeId : null); }, [activeId]);
  const workspaceSaved = useCallback(async () => { setWorkspaceRevision((value) => value + 1); await refresh(); }, [refresh]);

  return <CopilotKitProvider runtimeUrl="/api/copilotkit" agentId="assistant" enableInspector={false} showIntelligenceIndicator={false}>
    <div className="workspace-shell" hidden={settingsOpen} inert={settingsOpen}>
      {mobileDrawerOpen && <button tabIndex={-1} className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="关闭侧栏" />}
      <aside ref={sidebarRef} className={`sidebar ${sidebarOpen ? "sidebar-mobile-open" : ""}`} role={mobileDrawerOpen ? "dialog" : undefined} aria-modal={mobileDrawerOpen || undefined} aria-label="工作空间导航" tabIndex={mobileViewport ? -1 : undefined} inert={mobileViewport && !sidebarOpen}>
        <div className="sidebar-brand"><button className="brand-home" onClick={() => { setActiveId(null); setCurrentProject(null); setSidebarOpen(false); }}><Mark small /><span>拾序<span className="brand-subtitle">Shixu Work</span></span></button><button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="收起侧栏"><PanelLeftClose size={18} /></button></div>
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
                <button className="project-toggle" aria-expanded={!collapsed} onClick={() => { setCurrentProject(project.id); setActiveId(null); setCollapsedProjects((previous) => { const next = new Set(previous); if (next.has(project.id)) next.delete(project.id); else next.add(project.id); return next; }); }}>
                  {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<Folder size={16} /><span>{project.name}</span>
                </button><button className="project-add" onClick={() => void createTask(project.id)} disabled={creating || deletingProject} title="在此项目中新建任务" aria-label={`在${project.name}中新建任务`}><Plus size={15} /></button><button className="project-options" onClick={(event) => showProjectMenu(event, project)} aria-label={`${project.name}的项目操作`} aria-haspopup="menu" aria-expanded={projectMenu?.project.id === project.id} disabled={deletingProject}><MoreHorizontal size={17} /></button>
              </div>
              {!collapsed && <div className="project-conversations">{items.length ? items.map((conversation) => conversationRow(conversation, true)) : <p className="project-empty">暂无任务</p>}</div>}
            </div>;
          }) : <button className="first-project" onClick={beginProject}><FolderPlus size={17} /><span>创建第一个项目</span><Plus size={13} /></button>}
          <div className="list-heading recent-heading"><span>未分组会话</span><span className="count-badge">{ungrouped.length}</span></div>
          {ungrouped.length ? ungrouped.map((conversation) => conversationRow(conversation)) : <p className="list-empty">每个想法都可以成为一个任务</p>}
        </div>
        <div className="sidebar-footer"><span className="user-avatar">拾</span><span className="user-info">个人工作空间<span>Shixu Work</span></span><button className="icon-button" ref={settingsTriggerRef} aria-label="设置" title="设置" onClick={() => openSettings()}><Settings2 size={17} /></button></div>
      </aside>
      <main className="main-panel" inert={mobileDrawerOpen}>
        <header className="workspace-header"><div className="header-title"><button className="icon-button mobile-only" ref={sidebarTriggerRef} onClick={() => setSidebarOpen(true)} aria-label="展开侧栏" aria-haspopup="dialog" aria-expanded={mobileDrawerOpen}><PanelLeftOpen size={19} /></button><Folder size={17} className="header-folder" /><span>{active?.title ?? selectedProject?.name ?? "工作空间"}</span>{active && <button className="icon-button header-more" onClick={(event) => showMenu(event, active)} aria-haspopup="menu" aria-expanded={menu?.conversation.id === active.id} aria-label="当前任务的更多操作"><MoreHorizontal size={18} /></button>}</div><div className="header-meta">{selectedProject && active && <span className="header-project">{selectedProject.name}</span>}<button className="icon-button header-help" onClick={() => setHelpOpen(true)} aria-label="帮助"><CircleHelp size={17} /></button></div></header>
        {loadError && <div className="connection-banner"><span><LoaderCircle size={15} />无法连接后端，请确认服务已启动</span><button onClick={() => void refresh()}>重试</button></div>}
        {!loadError && health && !health.model_configured && <div className="setup-banner"><span><KeyRound size={15} /><span>尚未连接模型，配置后即可开始对话。</span></span><button onClick={() => openSettings()}>配置模型<ArrowRight size={13} /></button></div>}
        {active ? <><WorkspaceAccess key={active.id} conversationId={active.id} revision={`${active.project_id ?? "default"}:${selectedProject?.workspace_path ?? ""}:${workspaceRevision}`} onAvailability={workspaceAvailability} onProjectSaved={workspaceSaved} onDefaultSettings={() => openSettings("workspace")} /><ChatPane conversation={active} configured={!!health?.model_configured} workspaceAvailable={workspaceReadyId === active.id} onError={notify} onUpdate={refresh} /></> : <div className="welcome-view">
          <div className="welcome-content">
            <span className="welcome-symbol" aria-hidden="true">{selectedProject ? <Folder size={28} strokeWidth={1.4} /> : <MessageCircle size={28} strokeWidth={1.4} />}</span>
            <h1>{selectedProject ? selectedProject.name : "开始你的工作"}</h1>
            <p>{selectedProject ? "在这个项目中创建任务，和 Agent 一起推进工作。" : "新建一个任务，和 Agent 一起梳理问题、推进工作。"}</p>
            <>{selectedProject && <div className="project-workspace-summary"><span>{selectedProject.workspace_path ?? "项目工作目录未设置"}</span><button className="text-button" onClick={() => { setProjectToConfigure(selectedProject); setProjectPath(selectedProject.workspace_path ?? ""); setFormError(""); }}>{selectedProject.workspace_path ? "修改项目目录" : "设置项目目录"}</button></div>}</><div className="welcome-actions"><button className="primary-button" onClick={() => void createTask()} disabled={creating || loadError}>{creating ? <LoaderCircle size={17} className="spin" /> : <Plus size={17} />}新建任务</button><button className="secondary-button" onClick={beginProject}><FolderPlus size={16} />创建项目</button></div>
          </div>
        </div>}
      </main>
      {toast && <div className="toast" role="status"><span>{toast}</span><button className="icon-button" onClick={() => setToast(null)} aria-label="关闭提示"><X size={15} /></button></div>}
      {menu && <ConversationMenu {...menu} onClose={closeMenu} onAction={(action, conversation) => void menuAction(action, conversation)} />}
      {projectMenu && <ProjectMenu {...projectMenu} onClose={closeProjectMenu} onDelete={() => { projectDeleteTrigger.current = projectMenu.trigger; setProjectDeleteError(""); setProjectDelete(projectMenu.project); setProjectMenu(null); }} />}
      {projectDelete && <Dialog title="删除项目" onClose={cancelProjectDelete}><form onSubmit={submitProjectDelete} aria-busy={deletingProject}><p className="dialog-description">删除「{projectDelete.name}」后，项目中的会话会移至未分组，消息、置顶状态和外部路径授权继续保留。</p><p className="project-delete-consequence">后续任务将使用默认工作目录。项目的磁盘目录和文件保持不变，不会删除或搬迁。</p>{projectDeleteError && <p className="form-error" role="alert">{projectDeleteError}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" ref={projectDeleteCancel} autoFocus onClick={cancelProjectDelete} disabled={deletingProject}>取消</button><button type="submit" className="primary-button danger-button" disabled={deletingProject}>{deletingProject && <LoaderCircle size={15} className="spin" />}删除项目</button></div></form></Dialog>}
      {projectDialog && <Dialog title="创建项目" onClose={() => { if (!creating) { setProjectPicker(false); setProjectDialog(false); } }}><form onSubmit={submitProject}><p className="dialog-description">为项目选择保存和处理文件的目录。</p><label htmlFor="project-name">项目名称</label><input autoFocus id="project-name" className="form-input" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="例如：产品研究、个人学习" maxLength={80} required /><div className="project-directory-field"><label htmlFor="project-workspace-path">项目工作目录</label><div className="path-field"><input id="project-workspace-path" className="form-input path-input" value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="选择目录或输入绝对路径" required autoComplete="off" spellCheck={false} disabled={creating || projectPicker} /><button type="button" className="secondary-button" aria-label="浏览项目工作目录" onClick={(event) => { projectBrowseRef.current = event.currentTarget; setFormError(""); setProjectPicker(true); }} disabled={creating || projectPicker}><FolderOpen size={16} />浏览</button></div></div>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => { setProjectPicker(false); setProjectDialog(false); }} disabled={creating}>取消</button><button type="submit" className="primary-button" disabled={creating || projectPicker || !projectName.trim() || !projectPath.trim()}>{creating && <LoaderCircle size={15} className="spin" />}创建项目</button></div></form></Dialog>}
      {editDialog && <Dialog title={editDialog.mode === "rename" ? "重命名会话" : "移动到项目"} onClose={() => { if (!creating) setEditDialog(null); }}><form onSubmit={submitEdit}><p className="dialog-description">{editDialog.mode === "rename" ? "一个清晰的名字，让你更容易找回这段对话。" : "后续任务将使用目标项目的工作目录；会话历史保留，已有文件不会搬迁。"}</p><label htmlFor="edit-value">{editDialog.mode === "rename" ? "会话名称" : "目标项目"}</label>{editDialog.mode === "rename" ? <input autoFocus id="edit-value" className="form-input" value={editValue} onChange={(event) => setEditValue(event.target.value)} maxLength={120} required /> : <select autoFocus id="edit-value" className="form-input" value={editValue} onChange={(event) => setEditValue(event.target.value)}><option value="">未分组会话</option>{projects.map((project) => <option key={project.id} value={project.id} disabled={!project.workspace_path}>{project.name}{!project.workspace_path ? "（未设置目录）" : ""}</option>)}</select>}{editDialog.mode === "move" && <p className="move-directory-preview">后续工作目录：<code>{editValue ? projects.find((project) => project.id === editValue)?.workspace_path ?? "未设置" : "默认工作目录"}</code></p>}{formError && <p className="form-error" role="alert">{formError}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setEditDialog(null)} disabled={creating}>取消</button><button type="submit" className="primary-button" disabled={creating || (editDialog.mode === "rename" && !editValue.trim())}>{creating && <LoaderCircle size={15} className="spin" />}保存</button></div></form></Dialog>}
      {projectToConfigure && <Dialog title="设置项目目录" onClose={() => { if (!creating) { setProjectPicker(false); setProjectToConfigure(null); } }}><form onSubmit={submitProjectDirectory}><p className="dialog-description">后续任务使用新目录，已有文件不会自动搬迁。</p><label htmlFor="existing-project-path">项目工作目录</label><div className="path-field"><input id="existing-project-path" className="form-input path-input" value={projectPath} onChange={(event) => setProjectPath(event.target.value)} required autoComplete="off" spellCheck={false} disabled={creating || projectPicker} /><button type="button" className="secondary-button" aria-label="浏览项目工作目录" onClick={(event) => { projectBrowseRef.current = event.currentTarget; setFormError(""); setProjectPicker(true); }} disabled={creating || projectPicker}><FolderOpen size={16} />浏览</button></div>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => { setProjectPicker(false); setProjectToConfigure(null); }} disabled={creating}>取消</button><button type="submit" className="primary-button" disabled={creating || projectPicker || !projectPath.trim()}>{creating && <LoaderCircle size={15} className="spin" />}保存项目目录</button></div></form></Dialog>}{projectPicker && (projectDialog || projectToConfigure) && <DirectoryPicker title="选择项目工作目录" initialPath={projectPath} returnFocusRef={projectBrowseRef} onError={(message) => { setFormError(message); setProjectPicker(false); }} onClose={() => setProjectPicker(false)} onSelect={(path) => { setProjectPath(path); setProjectPicker(false); setFormError(""); }} />}{searchOpen && <Dialog title="搜索会话" className="search-dialog" onClose={() => { setSearchOpen(false); setQueryComposing(false); }}><div className="search-input-wrap"><Search size={20} /><input autoFocus aria-label="搜索会话标题或消息内容" placeholder="搜索会话标题或消息内容…" value={query} onCompositionStart={() => { setQueryComposing(true); setResults([]); setSearching(true); setSearchError(""); }} onCompositionEnd={(event) => { setQuery(event.currentTarget.value); setQueryComposing(false); }} onChange={(event) => { setQuery(event.target.value); setResults([]); setSearching(true); setSearchError(""); }} />{searching && <LoaderCircle size={17} className="spin" />}</div><div className="search-caption">{query.trim() ? "搜索结果" : "最近的会话"}<span>{!searching && `${results.length} 个会话`}</span></div><div className="search-results" aria-busy={searching}>{searchError ? <p className="search-empty" role="alert">{searchError}</p> : results.length ? results.map((result) => <button className="search-result" key={result.id} onClick={() => { openConversation(result); if (!conversations.some((conversation) => conversation.id === result.id)) void refresh(); }}><MessageCircle size={18} /><span className="search-result-content"><strong>{result.title}</strong>{result.snippet && <span>{result.snippet}</span>}<small>{result.project_name ?? "未分组会话"} · {relativeTime(result.updated_at)}</small></span><CornerDownLeft size={14} /></button>) : <div className="search-empty"><Search size={28} strokeWidth={1.2} /><p>{searching ? "正在搜索…" : query.trim() ? "没有找到匹配的会话" : "还没有会话记录"}</p><span>{!searching && (query.trim() ? "试试另一个关键词" : "新建一个任务，开始你的第一段对话")}</span></div>}</div><div className="search-bottom"><span><kbd>Esc</kbd>关闭</span><span>标题与消息内容</span></div></Dialog>}
      {helpOpen && <Dialog title="使用拾序" onClose={() => setHelpOpen(false)}><div className="help-content"><p>这是一个单用户的本地 Web Demo。新建任务后，右侧即可开始对话；项目同时绑定独立的工作目录。</p><div className="help-block"><KeyRound size={19} /><div><strong>连接模型</strong><p>点击左下角“设置”，在“模型配置”中选择 DeepSeek 或 OpenAI 兼容服务，填写接口地址、模型名称和密钥。</p><small>测试连接会发送一次简短请求；保存配置后，下一次对话即可使用新模型，无需重启服务。</small></div></div><div className="help-block"><FileText size={19} /><div><strong>对话自动保存</strong><p>刷新页面或重新启动服务后，可以从左侧继续已有会话。用搜索找到标题或消息中的关键词。</p></div></div><div className="help-block"><Folder size={19} /><div><strong>工作目录与外部授权</strong><p>未分组会话使用设置中的默认工作目录；项目会话使用项目目录。点击会话顶部“目录与授权”，可以查看真实路径，并为当前会话添加文件或目录的只读、读写授权。</p><small>授权保留到撤销为止；撤销不会删除文件。新文件默认保存在当前工作目录，读取外部资料不会改变默认保存位置。删除文件和执行命令始终禁止。</small></div></div><div className="help-shortcuts"><span><kbd>⌘ / Ctrl K</kbd>搜索会话</span><span><kbd>Enter</kbd>发送消息</span><span><kbd>Shift Enter</kbd>消息换行</span></div></div></Dialog>}
    </div>
    {settingsOpen && (settingsSection === "model" ? <ModelSettings onBack={closeSettings} onSaved={refresh} onWorkspace={() => setSettingsSection("workspace")} /> : <WorkspaceSettings onBack={closeSettings} onModel={() => setSettingsSection("model")} onSaved={workspaceSaved} />)}
  </CopilotKitProvider>;
}
