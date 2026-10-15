"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Check, CheckCircle2, CircleHelp, Cpu, Folder, KeyRound, LoaderCircle, Plug, RefreshCw, Settings2 } from "lucide-react";
import { Dialog } from "./dialog";

type Provider = "deepseek" | "openai";
type ModelConfig = {
  provider: Provider;
  model: string;
  base_url: string;
  max_output_tokens: number;
  api_key_configured: boolean;
  source: "environment" | "saved";
};
type ModelForm = Pick<ModelConfig, "provider" | "model" | "base_url"> & { max_output_tokens: string };
type Feedback = { kind: "success" | "error"; message: string } | null;

const defaults: Record<Provider, ModelForm> = {
  deepseek: { provider: "deepseek", model: "deepseek-flash", base_url: "https://api.deepseek.com", max_output_tokens: "1024" },
  openai: { provider: "openai", model: "gpt-4.1-mini", base_url: "https://api.openai.com/v1", max_output_tokens: "1024" },
};

const providerName = (provider: Provider) => provider === "deepseek" ? "DeepSeek" : "OpenAI 兼容";
const toForm = (config: ModelConfig): ModelForm => ({ provider: config.provider, model: config.model, base_url: config.base_url, max_output_tokens: String(config.max_output_tokens) });
const normalizedBase = (base: string) => base.trim().replace(/\/+$/, "");

function ProviderIcon({ provider, large = false }: { provider: Provider; large?: boolean }) {
  return <span className={`provider-symbol${large ? " provider-symbol-large" : ""}`} aria-hidden="true"><img src={`/model-providers/${provider}.svg`} alt="" width={large ? 28 : 22} height={large ? 28 : 22} /></span>;
}

async function modelApi<T>(method: "GET" | "PUT" | "POST", body?: object): Promise<T> {
  const response = await fetch(`/api/backend/settings/model${method === "POST" ? "/test" : ""}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  let result: { detail?: unknown } = {};
  try { result = await response.json(); } catch { /* A stopped backend may return a non-JSON response. */ }
  if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "模型服务暂时不可用，请稍后重试。");
  return result as T;
}

export function ModelSettings({ onBack, onSaved, onWorkspace }: { onBack: () => void; onSaved: () => void | Promise<void>; onWorkspace?: () => void }) {
  const [saved, setSaved] = useState<ModelConfig | null>(null);
  const [form, setForm] = useState<ModelForm>(defaults.deepseek);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState<"test" | "save" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [leaveForWorkspace, setLeaveForWorkspace] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    setLoading(true); setLoadError("");
    try {
      const config = await modelApi<ModelConfig>("GET");
      if (!mounted.current) return;
      setSaved(config); setForm(toForm(config)); setApiKey("");
    } catch (error) { if (mounted.current) setLoadError((error as Error).message); }
    finally { if (mounted.current) setLoading(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    headingRef.current?.focus();
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  const canKeepKey = !!saved?.api_key_configured && saved.provider === form.provider && normalizedBase(saved.base_url) === normalizedBase(form.base_url);
  const dirty = !!saved && (apiKey.length > 0 || JSON.stringify(form) !== JSON.stringify(toForm(saved)));

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  function exit() { setApiKey(""); if (leaveForWorkspace && onWorkspace) onWorkspace(); else onBack(); }
  function requestBack() { setLeaveForWorkspace(false); if (dirty) setDiscardOpen(true); else { setApiKey(""); onBack(); } }
  function requestWorkspace() { setLeaveForWorkspace(true); if (dirty) setDiscardOpen(true); else { setApiKey(""); onWorkspace?.(); } }
  function changeProvider(provider: Provider) {
    if (provider === form.provider) return;
    setForm(saved?.provider === provider ? toForm(saved) : { ...defaults[provider] });
    setApiKey(""); setFeedback(null);
  }
  function updateField(field: "model" | "base_url" | "max_output_tokens", value: string) {
    setForm((previous) => ({ ...previous, [field]: value })); setFeedback(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>, action: "test" | "save") {
    event.preventDefault();
    if (pending) return;
    setPending(action); setFeedback(null);
    const body = {
      provider: form.provider,
      model: form.model.trim(),
      base_url: form.base_url.trim(),
      max_output_tokens: Number(form.max_output_tokens),
      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
    };
    try {
      if (action === "test") {
        const result = await modelApi<{ ok: boolean; message: string }>("POST", body);
        if (mounted.current) setFeedback({ kind: "success", message: result.message || "连接成功，模型已响应。" });
      } else {
        const config = await modelApi<ModelConfig>("PUT", body);
        if (!mounted.current) return;
        setSaved(config); setForm(toForm(config)); setApiKey("");
        setFeedback({ kind: "success", message: "配置已保存，下一次对话将使用此模型。" });
        await onSaved();
      }
    } catch (error) { if (mounted.current) setFeedback({ kind: "error", message: (error as Error).message }); }
    finally { if (mounted.current) setPending(null); }
  }

  return <div className="settings-shell" data-testid="model-settings">
    <aside className="settings-sidebar" aria-label="配置导航">
      <div className="settings-brand"><span className="settings-brand-icon"><Settings2 size={20} /></span><span>工作空间配置</span></div>
      <button className="settings-back" onClick={requestBack} disabled={!!pending}><ArrowLeft size={17} />返回工作区</button>
      <p className="settings-nav-heading">基础设置</p>
      <nav><button className="settings-nav-item" aria-current="page"><Cpu size={18} />模型配置</button>{onWorkspace && <button className="settings-nav-item" onClick={requestWorkspace} disabled={!!pending}><Folder size={18} />工作目录</button>}</nav>
      <div className="settings-sidebar-bottom"><span className="user-avatar">拾</span><span>拾序<span>Shixu Work</span></span></div>
    </aside>
    <main className="settings-main">
      <header className="settings-topbar"><span>配置</span><button className="icon-button" aria-label="模型配置帮助" title="模型配置帮助" onClick={() => setHelpOpen(true)}><CircleHelp size={18} /></button></header>
      <div className="settings-scroll">
        <div className="settings-content">
          <div className="settings-page-heading"><div><h1 ref={headingRef} tabIndex={-1}>模型配置</h1><p>连接模型服务，让 Agent 开始工作。</p></div>{saved && <span className={`model-config-status ${saved.api_key_configured ? "is-ready" : ""}`}><span />{saved.api_key_configured ? `当前使用 ${providerName(saved.provider)}` : "尚未连接模型"}</span>}</div>
          {loading ? <div className="model-settings-card settings-load-state" role="status"><LoaderCircle className="spin" size={22} /><span>正在加载模型配置…</span></div> : loadError ? <div className="model-settings-card settings-load-state"><p role="alert">{loadError}</p><button className="secondary-button" onClick={() => void load()}><RefreshCw size={16} />重新加载</button></div> : <div className="model-settings-card">
            <div className="model-provider-list"><h2>模型服务</h2>{(["deepseek", "openai"] as const).map((provider) => <button key={provider} className={`model-provider-option ${form.provider === provider ? "is-selected" : ""}`} aria-label={providerName(provider)} aria-pressed={form.provider === provider} onClick={() => changeProvider(provider)} disabled={!!pending}><ProviderIcon provider={provider} /><span><strong>{providerName(provider)}</strong></span>{form.provider === provider && <Check size={16} />}</button>)}</div>
            <form className="model-config-form" onSubmit={(event) => { const submitter = (event.nativeEvent as SubmitEvent).submitter; void submit(event, submitter?.getAttribute("value") === "test" ? "test" : "save"); }} aria-busy={!!pending}>
              <div className="model-form-heading"><ProviderIcon provider={form.provider} large /><div><h2>{providerName(form.provider)}</h2><p>{form.provider === "deepseek" ? "使用你的 DeepSeek API 账户。" : "连接 OpenAI 或提供兼容接口的模型服务。"}</p></div></div>
              <fieldset disabled={!!pending}>
                <div className="model-field"><label htmlFor="model-name">模型名称</label><input className="form-input" id="model-name" value={form.model} onChange={(event) => updateField("model", event.target.value)} placeholder={defaults[form.provider].model} maxLength={200} autoComplete="off" spellCheck={false} required /><p className="field-hint">填写服务商提供的模型 ID。</p></div>
                <div className="model-field"><label htmlFor="model-base-url">Base URL</label><input className="form-input" id="model-base-url" type="url" value={form.base_url} onChange={(event) => updateField("base_url", event.target.value)} placeholder={defaults[form.provider].base_url} maxLength={2048} autoComplete="off" spellCheck={false} required /></div>
                <div className="model-field"><div className="model-field-label"><label htmlFor="model-api-key">API Key</label>{canKeepKey && <span><KeyRound size={12} />已配置</span>}</div><input className="form-input" id="model-api-key" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setFeedback(null); }} placeholder={canKeepKey ? "已保存，留空保留现有密钥" : "输入 API Key"} autoComplete="new-password" spellCheck={false} required={!canKeepKey} aria-describedby="model-key-hint" /><p className="field-hint" id="model-key-hint">{canKeepKey ? "填写新密钥可替换现有密钥。" : "密钥保存在本机后端，保存后不会回显。"}</p></div>
                <div className="model-field model-token-field"><label htmlFor="model-max-tokens">最大输出 Token</label><input className="form-input" id="model-max-tokens" type="number" min={1} max={16384} step={1} value={form.max_output_tokens} onChange={(event) => updateField("max_output_tokens", event.target.value)} required /><p className="field-hint">控制单次回复的最大长度。</p></div>
              </fieldset>
              {feedback && <div className={`model-feedback ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.kind === "success" ? <CheckCircle2 size={16} /> : <CircleHelp size={16} />}<span>{feedback.message}</span></div>}
              <div className="model-form-actions"><button className="secondary-button" type="submit" value="test" disabled={!!pending}>{pending === "test" ? <LoaderCircle size={16} className="spin" /> : <Plug size={16} />}测试连接</button><button className="primary-button" type="submit" value="save" disabled={!!pending || !dirty}>{pending === "save" && <LoaderCircle size={16} className="spin" />}保存配置</button></div>
            </form>
          </div>}
        </div>
      </div>
    </main>
    {discardOpen && <Dialog title="放弃未保存的更改？" onClose={() => setDiscardOpen(false)}><p className="dialog-description">离开后，本次填写的配置将不会保存。</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setDiscardOpen(false)}>继续编辑</button><button className="primary-button" onClick={exit}>放弃更改</button></div></Dialog>}
    {helpOpen && <Dialog title="配置模型" onClose={() => setHelpOpen(false)}><div className="help-content"><p>选择模型服务，填写模型名称、接口地址和 API Key。这里保存的是整个工作空间使用的一套配置。</p><div className="help-block"><Plug size={19} /><div><strong>先测试，再保存</strong><p>“测试连接”会发送一次简短请求，可能产生少量用量；测试通过后点击“保存配置”，新的对话请求就会使用这个模型。</p></div></div><div className="help-block"><KeyRound size={19} /><div><strong>更新密钥</strong><p>已配置密钥时，留空会保留原密钥。更换模型服务或接口地址后，需要重新填写密钥。</p><small>DeepSeek 使用官方接口；OpenAI 兼容服务使用标准 Chat Completions 协议。</small></div></div></div></Dialog>}
  </div>;
}
