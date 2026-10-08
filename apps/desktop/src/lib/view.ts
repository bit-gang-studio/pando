import { useEffect, useState } from "react";

/// What the centre of a repository window shows. Chosen in the header,
/// remembered, and shared by every screen of that window.
export type CenterView = "commits" | "overview" | "files";
const KEY = "pando.view";
const listeners = new Set<(v: CenterView) => void>();

export function getCenterView(): CenterView {
  try { const v = localStorage.getItem(KEY); return v === "files" || v === "overview" ? v : "commits"; } catch { return "commits"; }
}

export function setCenterView(v: CenterView) {
  try { localStorage.setItem(KEY, v); } catch { /* not remembered, still switched */ }
  for (const l of listeners) l(v);
}

export function useCenterView(): CenterView {
  const [v, set] = useState<CenterView>(getCenterView);
  useEffect(() => { listeners.add(set); return () => { listeners.delete(set); }; }, []);
  return v;
}
