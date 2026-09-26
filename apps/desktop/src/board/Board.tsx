import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, repoName, type Board as BoardData, type UserConfig } from "../lib/api";
import { Branches } from "../branches/Branches";
import { Detail } from "../detail/Detail";
import { Settings } from "../settings/Settings";
import { NewWorktreeDialog } from "./NewWorktreeDialog";
import { RightRail } from "./RightRail";
import { WorktreeRow } from "./WorktreeRow";
import { matches, VIEWS, type ViewId } from "./views";

const REFRESH_MS = 4000;

export function Board() {
  const [repos, setRepos] = useState<string[]>([]);
  const [boards, setBoards] = useState<Record<string, BoardData>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [view, setView] = useState<ViewId>("all");
  const [scope, setScope] = useState<string | null>(null);
  const [version, setVersion] = useState("");
  const [creating, setCreating] = useState<false | { branch?: string }>(false);
  const [screen, setScreen] = useState<"worktrees" | "branches" | "settings">("worktrees");
  const [detail, setDetail] = useState<{ root: string; path: string } | null>(null);
  const [userConfig, setUserConfig] = useState<UserConfig>({ repos: [], editor: null });

  const refresh = useCallback(async () => {
    const cfg = await api.reposList();
    setUserConfig(cfg);
    setRepos(cfg.repos);
    await Promise.all(
      cfg.repos.map(async (root) => {
        try {
          const b = await api.boardLoad(root);
          setBoards((m) => ({ ...m, [root]: b }));
          setErrors((m) => { const { [root]: _, ...rest } = m; return rest; });
        } catch (e) {
          setErrors((m) => ({ ...m, [root]: String(e) }));
        }
      }),
    );
  }, []);

  useEffect(() => {
    api.version().then(setVersion);
    refresh();
    const t = setInterval(() => { if (document.hasFocus()) refresh(); }, REFRESH_MS);
    const onFocus = () => refresh();
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); setCreating({}); }
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("keydown", onKey);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); window.removeEventListener("keydown", onKey); };
  }, [refresh]);

  async function addRepo() {
    const picked = await open({ directory: true, multiple: false, title: "Add a repository" });
    if (typeof picked !== "string") return;
    try {
      await api.reposAdd(picked);
      await refresh();
    } catch (e) {
      alert(String(e));
    }
  }

  async function removeRepo(root: string) {
    if (!(await ask(`Stop tracking ${repoName(root)}? Nothing on disk changes.`, { title: "Remove repository" }))) return;
    await api.reposRemove(root);
    setBoards((m) => { const { [root]: _, ...rest } = m; return rest; });
    if (scope === root) setScope(null);
    await refresh();
  }

  async function removeWorktree(root: string, path: string, branch: string | null) {
    const b = boards[root];
    const row = b?.rows.find((r) => r.worktree.path === path);
    const dirty = row?.status ? row.status.staged + row.status.unstaged + row.status.untracked + row.status.conflicts : 0;
    const msg = dirty > 0
      ? `${branch ?? path} has ${dirty} uncommitted changes. Remove anyway? The branch is kept and a backup ref is written.`
      : `Remove the worktree for ${branch ?? path}? The branch is kept and a backup ref is written.`;
    if (!(await ask(msg, { title: "Remove worktree", kind: "warning" }))) return;
    try {
      await api.worktreeRemove(root, path, dirty > 0);
      await refresh();
    } catch (e) {
      alert(String(e));
    }
  }

  const visible = useMemo(
    () => repos.filter((r) => !scope || r === scope).map((r) => boards[r]).filter((b): b is BoardData => !!b),
    [repos, boards, scope],
  );
  const counts = useMemo(() => {
    const all = Object.values(boards).flatMap((b) => b.rows);
    return Object.fromEntries(VIEWS.map((v) => [v.id, all.filter((r) => matches(v.id, r)).length])) as Record<ViewId, number>;
  }, [boards]);

  const total = visible.reduce((n, b) => n + b.rows.filter((r) => matches(view, r)).length, 0);

  return (
    <div className="flex h-screen flex-col text-[13px]">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-stone-300 bg-white px-4 dark:border-stone-700 dark:bg-stone-800">
        <div className="flex w-[216px] items-center gap-2">
          <span className="h-[22px] w-[22px] rounded-md bg-teal-700" />
          <span className="text-sm font-semibold">Pando</span>
          <span className="text-xs text-stone-400">v{version}</span>
        </div>
        <div className="grow" />
        <button onClick={addRepo} className="h-8 rounded-lg border border-stone-300 bg-white px-3 dark:border-stone-600 dark:bg-stone-700">
          Add repository
        </button>
        <button onClick={() => setCreating({})} disabled={repos.length === 0} className="h-8 rounded-lg bg-teal-700 px-3.5 font-medium text-white hover:bg-teal-800 disabled:opacity-50">
          New worktree<span className="ml-2 text-xs opacity-70">⌘N</span>
        </button>
      </header>
      {creating && (
        <NewWorktreeDialog repos={repos} initialRepo={scope} initialBranch={creating.branch ?? null} onClose={() => setCreating(false)} onCreated={refresh} />
      )}

      <div className="flex min-h-0 min-w-0 grow">
        <aside className="flex w-[232px] shrink-0 flex-col gap-5 border-r border-stone-300 bg-stone-200/70 p-3 dark:border-stone-700 dark:bg-stone-900">
          <nav className="flex flex-col gap-0.5">
            <div className="px-2 pb-1 text-[11px] font-semibold tracking-wider text-stone-500">VIEWS</div>
            {VIEWS.map((v) => (
              <button key={v.id} onClick={() => setView(v.id)} className={`flex justify-between rounded-md px-2 py-1.5 text-left ${view === v.id ? "bg-white font-medium dark:bg-stone-700" : "hover:bg-white/60 dark:hover:bg-stone-800"}`}>
                <span>{v.label}</span>
                <span className={v.id === "attention" && counts[v.id] > 0 ? "font-medium text-amber-700" : "text-stone-500"}>{counts[v.id] ?? 0}</span>
              </button>
            ))}
          </nav>
          <nav className="flex flex-col gap-0.5">
            <div className="px-2 pb-1 text-[11px] font-semibold tracking-wider text-stone-500">REPOSITORIES</div>
            <button onClick={() => { setScope(null); setScreen("worktrees"); }} className={`rounded-md px-2 py-1.5 text-left ${scope === null ? "bg-white font-medium dark:bg-stone-700" : "hover:bg-white/60 dark:hover:bg-stone-800"}`}>All</button>
            {repos.map((r) => (
              <div key={r} className={`flex flex-col rounded-md ${scope === r ? "bg-white dark:bg-stone-700" : ""}`}>
                <button onClick={() => { setScope(r); if (scope !== r) setScreen("worktrees"); }} className={`flex justify-between rounded-md px-2 py-1.5 text-left ${scope === r ? "font-medium" : "hover:bg-white/60 dark:hover:bg-stone-800"}`}>
                  <span className="truncate font-mono text-xs">{repoName(r)}</span>
                  <span className="text-stone-500">{boards[r]?.rows.length ?? (errors[r] ? "!" : "…")}</span>
                </button>
                {scope === r && (
                  <>
                    <button onClick={() => setScreen("worktrees")} className={`px-2 py-1 pl-5 text-left text-xs ${screen === "worktrees" ? "text-teal-700 font-medium" : "text-stone-600 dark:text-stone-300"}`}>Worktrees</button>
                    <button onClick={() => setScreen("branches")} className={`px-2 py-1 pl-5 text-left text-xs ${screen === "branches" ? "text-teal-700 font-medium" : "text-stone-600 dark:text-stone-300"}`}>Branches</button>
                    <button onClick={() => setScreen("settings")} className={`px-2 py-1 pb-1.5 pl-5 text-left text-xs ${screen === "settings" ? "text-teal-700 font-medium" : "text-stone-600 dark:text-stone-300"}`}>Settings</button>
                  </>
                )}
              </div>
            ))}
            <button onClick={addRepo} className="mt-1 rounded-md border border-dashed border-stone-400 px-2 py-1.5 text-left text-stone-500 hover:bg-white/60 dark:hover:bg-stone-800">
              + Add repository
            </button>
          </nav>
        </aside>

        {detail ? (
          <Detail root={detail.root} path={detail.path} onBack={() => setDetail(null)} onChanged={refresh} />
        ) : screen === "settings" && scope ? (
          <Settings root={scope} userConfig={userConfig} onUserConfig={setUserConfig} />
        ) : screen === "branches" && scope ? (
          <Branches root={scope} onOpenAsWorktree={(branch) => setCreating({ branch })} onChanged={refresh} />
        ) : (
        <>
        <main className="flex min-w-0 grow flex-col gap-4 overflow-auto p-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold">{VIEWS.find((v) => v.id === view)?.label}</h1>
            <span className="text-stone-500">{total} across {visible.length} {visible.length === 1 ? "repository" : "repositories"}</span>
          </div>

          {repos.length === 0 && (
            <div className="rounded-lg border border-dashed border-stone-400 p-10 text-center">
              <div className="mb-1 font-medium">No repositories yet</div>
              <div className="mb-4 text-stone-500">Add one to see its worktrees as worktrees.</div>
              <button onClick={addRepo} className="h-8 rounded-lg bg-teal-700 px-3.5 font-medium text-white hover:bg-teal-800">Add repository</button>
            </div>
          )}

          {visible.map((b) => {
            const rows = b.rows.filter((r) => matches(view, r));
            if (rows.length === 0 && view !== "all") return null;
            return (
              <section key={b.repo.root} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 px-1">
                  <span className="font-mono text-xs font-medium">{repoName(b.repo.root)}</span>
                  <span className="truncate text-xs text-stone-500">{b.repo.root}</span>
                  <div className="grow" />
                  <button onClick={() => removeRepo(b.repo.root)} className="text-xs text-stone-500 hover:text-red-700">remove</button>
                </div>
                {rows.map((r) => (
                  <WorktreeRow
                    key={r.worktree.path}
                    row={r}
                    onReview={() => setDetail({ root: b.repo.root, path: r.worktree.path })}
                    onOpen={() => api.openInEditor(r.worktree.path).catch((e) => alert(String(e)))}
                    onRemove={() => removeWorktree(b.repo.root, r.worktree.path, r.worktree.branch)}
                  />
                ))}
                {rows.length === 0 && <div className="px-1 text-xs text-stone-500">Only the main worktree. <button onClick={() => { setScope(b.repo.root); setCreating({}); }} className="text-teal-700 underline">New worktree</button></div>}
              </section>
            );
          })}
          {Object.entries(errors).map(([root, e]) => (
            <div key={root} className="rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">
              <span className="font-mono">{repoName(root)}</span>: {e}
            </div>
          ))}
        </main>

        <RightRail boards={visible} />
        </>
        )}
      </div>
    </div>
  );
}
