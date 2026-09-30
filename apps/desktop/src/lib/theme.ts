import { getCurrentWindow } from "@tauri-apps/api/window";

/// Light, dark, or auto (follow the Mac). Remembered on this machine only.
export type Theme = "system" | "light" | "dark";
const KEY = "pando.theme";
/// Click order. Auto is the default, so the first click gives Light.
export const THEMES: Theme[] = ["light", "dark", "system"];

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch { return "system"; }
}

/// The window's theme is what the page sees as prefers-color-scheme,
/// so every existing dark: style follows it.
export function applyTheme(t: Theme) {
  getCurrentWindow().setTheme(t === "system" ? null : t).catch(() => {});
}

export function setTheme(t: Theme) {
  try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
  applyTheme(t);
}

/// Apply on start, and follow changes made in other windows.
export function installTheme(): () => void {
  applyTheme(getTheme());
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) applyTheme(getTheme()); };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
