import { useCallback, useEffect, useMemo, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { api, repoName, type Board as BoardData, type UserConfig } from "../lib/api";
import { Branches } from "../branches/Branches";
import { CleanDialog } from "../clean/CleanDialog";
import { Detail } from "../detail/Detail";
import { LandDialog } from "../land/LandDialog";
import { Settings } from "../settings/Settings";
import { NewWorktreeDialog } from "./NewWorktreeDialog";
import { RightRail } from "./RightRail";
import { WorktreeRow } from "./WorktreeRow";
import { matches, VIEWS, type ViewId } from "./views";

const REFRESH_MS = 4000;
const LAST_REPO_KEY = "pando.lastRepo";

type Screen = "worktrees" | "branches" | "settings";

function loadLastRepo(): string | null {
  try { return localStorage.getItem(LAST_REPO_KEY); } catch { return null; }
}
function saveLastRepo(root: string | null) {
  try { if (root) localStorage.setItem(LAST_REPO_KEY, root); else localStorage.removeItem(LAST_REPO_KEY); } catch { /* ignore */ }
}

export function Board() {
  const [userConfig, setUserConfig] = useState<UserConfig>({ repos: [], editor: null });
  const [repos, setRepos] = useState<string[]>([]);
  const [boards, setBoards] = useState<Record<string, BoardData>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [repo, setRepo] = useState<string | null>(loadLastRepo());
  const [screen, setScreen] = useState<Screen>("worktrees");
  const [view, setView] = useState<ViewId>("all");
  const [detail, setDetail] = useState<string | null>(null);
  const [creating, setCreating] = useState<false | { branch?: string }>(false);
  const [landing, setLanding] = useState<{ path: string; branch: string } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [version, setVersion] = useState("");
  const [fatal, setFatal] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const refresh = useCallback(async () => {
    const cfg = await api.reposList();
    setUserConfig(cfg);
    setRepos(cfg.repos);
    setRepo((r) => (r && cfg.repos.includes(r) ? r : cfg.repos[0] ?? null));
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

  useEffect(() => { saveLastRepo(repo); }, [repo]);

  useEffect(() => {
    api.version().then(setVersion);
    refresh();
    const t = setInterval(() => { if (document.hasFocus()) refresh(); }, REFRESH_MS);
    const onFocus = () => refresh();
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); setCreating({}); }
      if (mod && e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); setCleaning(true); }
    };
    const onErr = (e: ErrorEvent) => setFatal(e.message);
    const onRej = (e: PromiseRejectionEvent) => setFatal(String(e.reason));
    window.addEventListener("focus", onFocus);
    window.addEventListener("keydown", onKey);
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, [refresh]);

  async function addRepo() {
    const picked = await open({ directory: true, multiple: false, title: "Add a repository" });
    if (typeof picked !== "string") return;
    try {
      const cfg = await api.reposAdd(picked);
      const added = cfg.repos.find((r) => !repos.includes(r)) ?? cfg.repos[cfg.repos.length - 1];
      setRepo(added);
      go("worktrees");
      await refresh();
    } catch (e) {
      setFatal(String(e));
    }
  }

  async function removeRepo(root: string) {
    if (!(await ask(`Stop tracking ${repoName(root)}? Nothing on disk changes.`, { title: "Remove repository" }))) return;
    await api.reposRemove(root);
    setBoards((m) => { const { [root]: _, ...rest } = m; return rest; });
    if (repo === root) setRepo(null);
    await refresh();
  }

  async function removeWorktree(root: string, path: string, branch: string | null) {
    const row = boards[root]?.rows.find((r) => r.worktree.path === path);
    const dirty = row?.status ? row.status.staged + row.status.unstaged + row.status.untracked + row.status.conflicts : 0;
    const msg = dirty > 0
      ? `${branch ?? path} has ${dirty} uncommitted changes. Remove anyway? The branch is kept and a backup ref is written.`
      : `Remove the worktree for ${branch ?? path}? The branch is kept and a backup ref is written.`;
    if (!(await ask(msg, { title: "Remove worktree", kind: "warning" }))) return;
    try {
      await api.worktreeRemove(root, path, dirty > 0);
      await refresh();
    } catch (e) {
      setFatal(String(e));
    }
  }

  function go(s: Screen) {
    setScreen(s);
    setDetail(null);
  }

  const board = repo ? boards[repo] : undefined;
  const rows = useMemo(() => (board ? board.rows.filter((r) => matches(view, r)) : []), [board, view]);
  const counts = useMemo(
    () => Object.fromEntries(VIEWS.map((v) => [v.id, board ? board.rows.filter((r) => matches(v.id, r)).length : 0])) as Record<ViewId, number>,
    [board],
  );

  const navBtn = (active: boolean) =>
    `flex w-full justify-between rounded-md px-2 py-1.5 text-left ${active ? "bg-white font-medium dark:bg-stone-700" : "hover:bg-white/60 dark:hover:bg-stone-800"}`;

  return (
    <div className="flex h-screen flex-col text-[13px]">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-stone-300 bg-white px-4 dark:border-stone-700 dark:bg-stone-800">
        <div className="flex items-center gap-2">
          <span className="h-[22px] w-[22px] rounded-md bg-teal-700" />
          <span className="text-sm font-semibold">Pando</span>
          <span className="text-xs text-stone-400">v{version}</span>
        </div>
        <div className="grow" />
        <button onClick={() => setCleaning(true)} disabled={!repo} className="h-8 rounded-lg border border-stone-300 bg-white px-3 disabled:opacity-50 dark:border-stone-600 dark:bg-stone-700">
          Clean up<span className="ml-2 text-xs text-stone-400">⌘⇧C</span>
        </button>
        <button onClick={() => setCreating({})} disabled={!repo} className="h-8 rounded-lg bg-teal-700 px-3.5 font-medium text-white hover:bg-teal-800 disabled:opacity-50">
          New worktree<span className="ml-2 text-xs opacity-70">⌘N</span>
        </button>
      </header>

      {fatal && (
        <div className="flex items-center gap-3 bg-red-100 px-4 py-2 text-xs text-red-900 dark:bg-red-900/40 dark:text-red-100">
          <span className="font-medium">Error:</span><span className="truncate">{fatal}</span>
          <div className="grow" />
          <button onClick={() => setFatal(null)} className="underline">dismiss</button>
        </div>
      )}
      {repo && cleaning && <CleanDialog repos={[repo]} onClose={() => setCleaning(false)} onDone={refresh} />}
      {repo && landing && (
        <LandDialog root={repo} path={landing.path} branch={landing.branch} onClose={() => setLanding(null)} onLanded={refresh} />
      )}
      {repo && creating && (
        <NewWorktreeDialog repos={repos} initialRepo={repo} initialBranch={creating.branch ?? null} onClose={() => setCreating(false)} onCreated={refresh} />
      )}

      <div className="flex min-h-0 min-w-0 grow">
        <aside className="flex w-[232px] shrink-0 flex-col gap-4 border-r border-stone-300 bg-stone-200/70 p-3 dark:border-stone-700 dark:bg-stone-900">
          <div className="relative">
            <button onClick={() => setSwitcherOpen((o) => !o)} className="flex w-full items-center gap-2 rounded-md border border-stone-300 bg-white px-2.5 py-2 text-left dark:border-stone-600 dark:bg-stone-700" aria-haspopup="listbox" aria-expanded={switcherOpen}>
              <span className="grow truncate font-mono text-xs font-medium">{repo ? repoName(repo) : "No repository"}</span>
              <span className="text-stone-400">▾</span>
            </button>
            {switcherOpen && (
              <div role="listbox" className="absolute left-0 right-0 top-full z-20 mt-1 flex flex-col gap-0.5 rounded-md border border-stone-300 bg-white p-1 shadow-lg dark:border-stone-600 dark:bg-stone-800">
                {repos.map((r) => (
                  <button key={r} role="option" aria-selected={r === repo} onClick={() => { setRepo(r); go("worktrees"); setSwitcherOpen(false); }} className={`flex items-center justify-between rounded px-2 py-1.5 text-left ${r === repo ? "bg-stone-100 font-medium dark:bg-stone-700" : "hover:bg-stone-100 dark:hover:bg-stone-700"}`}>
                    <span className="truncate font-mono text-xs">{repoName(r)}</span>
                    <span className="text-xs text-stone-500">{boards[r]?.rows.length ?? (errors[r] ? "!" : "…")}</span>
                  </button>
                ))}
                <button onClick={() => { setSwitcherOpen(false); addRepo(); }} className="rounded border-t border-stone-200 px-2 py-1.5 text-left text-stone-600 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-700">+ Add repository</button>
              </div>
            )}
          </div>

          {repo && (
            <>
              <nav className="flex flex-col gap-0.5">
                <button onClick={() => go("worktrees")} className={navBtn(screen === "worktrees" && !detail)}>
                  <span>Worktrees</span><span className="text-stone-500">{board?.rows.length ?? "…"}</span>
                </button>
                {screen === "worktrees" && !detail && (
                  <div className="flex flex-col gap-0.5 pb-1 pl-3">
                    {VIEWS.map((v) => (
                      <button key={v.id} onClick={() => setView(v.id)} className={`flex justify-between rounded-md px-2 py-1 text-left text-xs ${view === v.id ? "font-medium text-teal-700" : "text-stone-600 hover:bg-white/60 dark:text-stone-300 dark:hover:bg-stone-800"}`}>
                        <span>{v.label}</span>
                        <span className={v.id === "attention" && counts[v.id] > 0 ? "font-medium text-amber-700" : "text-stone-500"}>{counts[v.id] ?? 0}</span>
                      </button>
                    ))}
                  </div>
                )}
                <button onClick={() => go("branches")} className={navBtn(screen === "branches" && !detail)}><span>Branches</span></button>
                <button onClick={() => go("settings")} className={navBtn(screen === "settings" && !detail)}><span>Settings</span></button>
              </nav>
              <div className="grow" />
              <div className="flex flex-col gap-1 px-2 text-xs text-stone-500">
                <span className="truncate" title={repo}>{repo}</span>
                <button onClick={() => removeRepo(repo)} className="self-start hover:text-red-700">Remove from Pando</button>
              </div>
            </>
          )}
          {!repo && <div className="grow" />}
          <div className="px-2 text-xs text-stone-500">git ready</div>
        </aside>

        {!repo ? (
          <main className="flex grow items-center justify-center p-6">
            <div className="rounded-lg border border-dashed border-stone-400 p-10 text-center">
              <div className="mb-1 font-medium">No repositories yet</div>
              <div className="mb-4 text-stone-500">Add one to see its worktrees.</div>
              <button onClick={addRepo} className="h-8 rounded-lg bg-teal-700 px-3.5 font-medium text-white hover:bg-teal-800">Add repository</button>
            </div>
          </main>
        ) : detail ? (
          <Detail root={repo} path={detail} onBack={() => setDetail(null)} onChanged={refresh} />
        ) : screen === "settings" ? (
          <Settings root={repo} userConfig={userConfig} onUserConfig={setUserConfig} />
        ) : screen === "branches" ? (
          <Branches root={repo} onOpenAsWorktree={(branch) => setCreating({ branch })} onChanged={refresh} />
        ) : (
          <>
            <main className="flex min-w-0 grow flex-col gap-3 overflow-auto p-6">
              <div className="flex items-baseline gap-3">
                <h1 className="text-lg font-semibold">{VIEWS.find((v) => v.id === view)?.label}</h1>
                <span className="text-stone-500">{rows.length} of {board?.rows.length ?? 0} in {repoName(repo)}</span>
              </div>
              {errors[repo] && (
                <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">{errors[repo]}</div>
              )}
              {!board && !errors[repo] && <div className="text-xs text-stone-500">Loading…</div>}
              {rows.map((r) => (
                <WorktreeRow
                  key={r.worktree.path}
                  row={r}
                  onReview={() => setDetail(r.worktree.path)}
                  onLand={r.worktree.kind === "linked" && r.worktree.branch ? () => setLanding({ path: r.worktree.path, branch: r.worktree.branch! }) : undefined}
                  onOpen={() => api.openInEditor(r.worktree.path).catch((e) => setFatal(String(e)))}
                  onRemove={() => removeWorktree(repo, r.worktree.path, r.worktree.branch)}
                />
              ))}
              {board && rows.length === 0 && (
                <div className="px-1 text-xs text-stone-500">
                  {view === "all" ? <>Only the main worktree. <button onClick={() => setCreating({})} className="text-teal-700 underline">New worktree</button></> : "Nothing matches this view."}
                </div>
              )}
            </main>
            <RightRail boards={board ? [board] : []} />
          </>
        )}
      </div>
    </div>
  );
}
