import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";

/// Roots with a working file watcher. Without one, screens poll instead.
const watched = new Set<string>();

/// Ask the app to watch a repo and its worktree folders.
export function watchRepo(root: string, worktrees: string[]) {
  api.watchRepo(root, worktrees).then(() => watched.add(root)).catch(() => watched.delete(root));
}

/// Call `refresh` now, when files in the repo change, when the window gets focus,
/// and on a timer: every 5s without a watcher, every 60s with one as a backstop.
/// Overlapping calls are merged, so a burst of changes runs at most two refreshes.
export function useRepoRefresh(root: string, refresh: () => Promise<void>) {
  const fn = useRef(refresh);
  fn.current = refresh;
  useEffect(() => {
    let running = false, again = false, last = 0;
    const run = async () => {
      if (running) { again = true; return; }
      running = true;
      try { await fn.current(); } finally {
        running = false;
        last = Date.now();
        if (again) { again = false; run(); }
      }
    };
    run();
    const t = setInterval(() => {
      if (!document.hasFocus()) return;
      if (!watched.has(root) || Date.now() - last > 60_000) run();
    }, 5000);
    const unlisten = listen<string>("repo-changed", (e) => { if (e.payload === root) run(); });
    window.addEventListener("focus", run);
    return () => { clearInterval(t); unlisten.then((u) => u()); window.removeEventListener("focus", run); };
  }, [root, refresh]);
}
