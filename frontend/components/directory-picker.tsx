"use client";

import { useEffect, useRef, type RefObject } from "react";
import { workspaceApi } from "@/lib/workspace-api";

type NativeSelection = { path: string | null; cancelled: boolean };

export function DirectoryPicker({ title, initialPath = "", includeFiles = false, onSelect, onClose, onError, returnFocusRef }: {
  title: string;
  initialPath?: string;
  includeFiles?: boolean;
  onSelect: (path: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const options = useRef({ initial_path: initialPath || null, include_files: includeFiles, title });
  const callbacks = useRef({ onSelect, onClose, onError });
  callbacks.current = { onSelect, onClose, onError };

  useEffect(() => {
    const request = new AbortController();
    const trigger = returnFocusRef.current;
    let active = true;
    let completed = false;
    // React StrictMode replays effects. Defer dispatch so its first cleanup can
    // cancel the scheduled request before a native window is opened.
    const timer = window.setTimeout(async () => {
      try {
        const result = await workspaceApi<NativeSelection>("filesystem/pick", {
          method: "POST", body: JSON.stringify(options.current), signal: request.signal,
        });
        if (!active || request.signal.aborted) return;
        completed = true;
        if (result.cancelled) callbacks.current.onClose();
        else if (result.path) callbacks.current.onSelect(result.path);
        else callbacks.current.onError("系统未返回有效路径，请重试或手动输入。");
      } catch (failure) {
        if (active && !request.signal.aborted) {
          completed = true;
          callbacks.current.onError((failure as Error).message);
        }
      }
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
      // Closing the original form also closes the native picker process.
      request.abort();
      // A completed selection unmounts this bridge. Wait for that commit so the
      // parent has re-enabled its Browse button before restoring focus.
      if (completed) window.requestAnimationFrame(() => {
        if (trigger?.isConnected && !trigger.disabled && trigger.getClientRects().length && !trigger.closest('dialog:not([open]),[inert]')) trigger.focus();
      });
    };
  }, [returnFocusRef]);

  // NSOpenPanel supplies the selection UI. No extra browser dialog or backdrop.
  return null;
}
