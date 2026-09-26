import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { repoName } from "./api";
import { toHash, type Route } from "./routes";

export function titleFor(r: Route): string {
  switch (r.kind) {
    case "repos": return "Pando";
    case "repo": return repoName(r.root);
    case "settings": return `${repoName(r.root)} · settings`;
    case "worktree": return `${repoName(r.root)} · ${r.path.split(/[\\/]/).pop()}`;
    case "commit": return `${repoName(r.root)} · ${r.id.slice(0, 7)}`;
  }
}

/// Open `route` in a new window. Same app, different address.
export async function openInNewWindow(route: Route) {
  const label = `pando-${Date.now().toString(36)}`;
  const w = new WebviewWindow(label, {
    url: `index.html${toHash(route)}`,
    title: titleFor(route),
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    zoomHotkeysEnabled: true,
  });
  await new Promise<void>((resolve, reject) => {
    w.once("tauri://created", () => resolve());
    w.once("tauri://error", (e) => reject(e.payload));
  });
}

export function setWindowTitle(route: Route) {
  getCurrentWindow().setTitle(titleFor(route)).catch(() => {});
}

/// ⌘-click or ctrl-click means "in a new window".
export function wantsNewWindow(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey || e.ctrlKey;
}
