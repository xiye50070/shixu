"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Dialog({ children, title, onClose, className = "" }: {
  children: ReactNode;
  title: string;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = ref.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) {
      element.showModal();
      // React's autoFocus runs before the native dialog joins the top layer.
      // Focus the first editable field after showModal makes it interactive.
      element.querySelector<HTMLElement>('input:not([disabled]),select:not([disabled]),textarea:not([disabled])')?.focus();
    }
    return () => {
      element?.close();
      if (trigger?.isConnected && trigger.getClientRects().length > 0 && !trigger.closest('dialog:not([open]),[inert]')) trigger.focus();
      else {
        const fallback = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label="展开侧栏"],.nav-action[aria-label="新建任务"]'))
          .find((button) => button.getClientRects().length > 0 && !button.closest("[inert]"));
        fallback?.focus();
      }
    };
  }, []);
  return (
    <dialog ref={ref} className={`dialog ${className}`} aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const element = event.currentTarget;
        const controls = Array.from(element.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]'))
          .filter((control) => control.tabIndex >= 0 && control.getClientRects().length > 0 && !control.closest("[inert]"));
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) { event.preventDefault(); element.focus(); return; }
        if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog-surface">
        <div className="dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
        {children}
      </div>
    </dialog>
  );
}
