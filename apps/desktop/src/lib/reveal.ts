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
