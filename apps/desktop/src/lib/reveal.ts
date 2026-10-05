import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "./api";
import { toastError } from "../ui/Toast";

const platform = navigator.userAgent.includes("Mac") ? "mac" : navigator.userAgent.includes("Windows") ? "windows" : "linux";

/// The file manager's own name for it.
export const REVEAL_LABEL = platform === "mac" ? "Show in Finder" : platform === "windows" ? "Show in Explorer" : "Show in folder";
export const reveal = (path: string) => revealItemInDir(path);

let terminal: Promise<string | null> | null = null;
/// The terminal "Open in …" uses (e.g. "Terminal", "iTerm"), or null if none.
export function useTerminalName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    terminal ??= api.terminalName().catch(() => null);
    terminal.then((n) => setName(n ?? null));
  }, []);
  return name;
}
export const openTerminal = (path: string) => api.openTerminal(path).catch(toastError);

const EDITOR = "pando.editor";
let editors: Promise<string[]> | null = null;
/// The code editors installed here, the one used last first. Empty if none.
export function useEditors(): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    editors ??= api.editorNames().then((n) => n ?? []).catch(() => []);
    editors.then((n) => {
      let last: string | null = null;
      try { last = localStorage.getItem(EDITOR); } catch { /* ignore */ }
      setNames(last && n.includes(last) ? [last, ...n.filter((x) => x !== last)] : n);
    });
  }, []);
  return names;
}
/// Open a folder in an editor, and prefer that editor from now on.
export function openEditor(name: string, path: string) {
  try { localStorage.setItem(EDITOR, name); } catch { /* ignore */ }
  return api.openEditor(name, path).catch(toastError);
}
