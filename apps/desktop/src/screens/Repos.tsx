import { useCallback, useEffect, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { api, changed, repoName, type Overview, type UserConfig } from "../lib/api";
import { navigate } from "../lib/routes";
import { openInNewWindow, wantsNewWindow } from "../lib/windows";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";

type Props = { onError: (m: string) => void };

export function Repos({ onError }: Props) {
  const [cfg, setCfg] = useState<UserConfig | null>(null);
  const [summaries, setSummaries] = useState<Record<string, Overview>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const c = await api.reposList();
      setCfg(c);
      await Promise.all(c.repos.map(async (root) => {
        try {
          const o = await api.overview(root);
          setSummaries((m) => ({ ...m, [root]: o }));
          setErrors((m) => { const { [root]: _, ...rest } = m; return rest; });
        } catch (e) {
          setErrors((m) => ({ ...m, [root]: String(e) }));
        }
      }));
    } catch (e) {
      onError(String(e));
    }
  }, [onError]);

  useEffect(() => {
    refresh();
    const t = setInterval(() => { if (document.hasFocus()) refresh(); }, 6000);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  async function addRepo() {
    const picked = await open({ directory: true, multiple: false, title: "Add a repository" });
    if (typeof picked !== "string") return;
    try {
      const c = await api.reposAdd(picked);
      const added = c.repos.find((r) => !(cfg?.repos ?? []).includes(r)) ?? c.repos[c.repos.length - 1];
      setCfg(c);
      navigate({ kind: "repo", root: added });
    } catch (e) {
      onError(String(e));
    }
  }

  async function removeRepo(root: string) {
    if (!(await ask(`Remove ${repoName(root)} from Pando? Nothing on disk changes.`, { title: "Remove repository" }))) return;
    setCfg(await api.reposRemove(root));
  }

  function summary(root: string): string {
    const o = summaries[root];
    if (!o) return errors[root] ? "can't read this repo" : "…";
    const wts = o.branches.filter((b) => b.worktree).length + o.detached.length;
    const dirty = o.branches.reduce((n, b) => n + changed(b.status), 0) + o.detached.reduce((n, d) => n + changed(d.status), 0);
    return `${wts} ${wts === 1 ? "worktree" : "worktrees"} · ${dirty ? `${dirty} changed` : "clean"}`;
  }

  return (
    <main className="flex min-w-0 grow flex-col gap-3 overflow-auto p-6">
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      <div className="flex items-baseline gap-3">
        <h1 className="text-base font-semibold">Repositories</h1>
        <span className="text-xs text-stone-500">{cfg ? cfg.repos.length : "…"}</span>
        <div className="grow" />
        <button onClick={addRepo} className="h-7 rounded-md bg-teal-700 px-3 text-xs font-medium text-white hover:bg-teal-800">Add repository</button>
      </div>
      {cfg && cfg.repos.length === 0 && (
        <div className="rounded-lg border border-dashed border-stone-400 p-10 text-center">
          <div className="mb-1 font-medium">No repositories yet</div>
          <div className="mb-4 text-stone-500">Add one to see its branches and worktrees.</div>
          <button onClick={addRepo} className="h-8 rounded-lg bg-teal-700 px-3.5 font-medium text-white hover:bg-teal-800">Add repository</button>
        </div>
      )}
      {cfg?.repos.map((root) => {
        const route = { kind: "repo" as const, root };
        return (
          <div
            key={root}
            onClick={(e) => (wantsNewWindow(e) ? openInNewWindow(route).catch((err) => onError(String(err))) : navigate(route))}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: [
              { label: "Open", onClick: () => navigate(route) },
              { label: "Open in new window", onClick: () => openInNewWindow(route).catch((err) => onError(String(err))) },
              { label: "Open in editor", onClick: () => api.openInEditor(root) },
              { label: "Remove from Pando", onClick: () => removeRepo(root), danger: true },
            ] }); }}
            className={`flex cursor-pointer items-center gap-3 rounded-lg border bg-white px-4 py-3 hover:border-stone-400 dark:bg-stone-800 ${errors[root] ? "border-red-300" : "border-stone-300 dark:border-stone-700"}`}
          >
            <div className="min-w-0">
              <div className="font-mono text-[13px] font-medium">{repoName(root)}</div>
              <div className="truncate text-xs text-stone-500" title={root}>{root}</div>
            </div>
            <div className="grow" />
            <span className={`text-xs ${errors[root] ? "text-red-700" : "text-stone-500"}`}>{summary(root)}</span>
            <span className="text-stone-400">›</span>
          </div>
        );
      })}
      {cfg && cfg.repos.length > 0 && <div className="px-1 text-xs text-stone-500">⌘-click a repository to open it in a new window.</div>}
    </main>
  );
}
