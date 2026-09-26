import { useCallback, useEffect, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { api, repoName, type UserConfig } from "./lib/api";
import { Detail } from "./screens/Detail";
import { Overview } from "./screens/Overview";
import { Settings } from "./screens/Settings";

const LAST_REPO_KEY = "pando.lastRepo";
type Screen = { kind: "list" } | { kind: "detail"; path: string } | { kind: "settings" };

export default function App() {
  const [userConfig, setUserConfig] = useState<UserConfig>({ repos: [], editor: null });
  const [repo, setRepo] = useState<string | null>(() => { try { return localStorage.getItem(LAST_REPO_KEY); } catch { return null; } });
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [version, setVersion] = useState("");
  const [fatal, setFatal] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const loadRepos = useCallback(async () => {
    const cfg = await api.reposList();
    setUserConfig(cfg);
    setRepo((r) => (r && cfg.repos.includes(r) ? r : cfg.repos[0] ?? null));
  }, []);

  useEffect(() => { try { if (repo) localStorage.setItem(LAST_REPO_KEY, repo); } catch { /* ignore */ } }, [repo]);

  useEffect(() => {
    api.version().then(setVersion);
    loadRepos();
    const onErr = (e: ErrorEvent) => setFatal(e.message);
    const onRej = (e: PromiseRejectionEvent) => setFatal(String(e.reason));
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => { window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onRej); };
  }, [loadRepos]);

  async function addRepo() {
    const picked = await open({ directory: true, multiple: false, title: "Add a repository" });
    if (typeof picked !== "string") return;
    try {
      const cfg = await api.reposAdd(picked);
      setUserConfig(cfg);
      const added = cfg.repos.find((r) => !userConfig.repos.includes(r)) ?? cfg.repos[cfg.repos.length - 1];
      setRepo(added);
      setScreen({ kind: "list" });
    } catch (e) {
      setFatal(String(e));
    }
  }

  async function removeRepo(root: string) {
    if (!(await ask(`Remove ${repoName(root)} from Pando? Nothing on disk changes.`, { title: "Remove repository" }))) return;
    const cfg = await api.reposRemove(root);
    setUserConfig(cfg);
    if (repo === root) setRepo(cfg.repos[0] ?? null);
    setScreen({ kind: "list" });
  }

  function pick(root: string) {
    setRepo(root);
    setScreen({ kind: "list" });
  }

  return (
    <div className="flex h-screen flex-col text-[13px]">
      <header className="flex h-11 shrink-0 items-stretch gap-1 border-b border-stone-300 bg-white px-3 dark:border-stone-700 dark:bg-stone-800">
        <div className="mr-3 flex items-center gap-2">
          <span className="h-[18px] w-[18px] rounded bg-teal-700" />
          <span className="text-sm font-semibold">Pando</span>
          <span className="text-xs text-stone-400">v{version}</span>
        </div>
        <div role="tablist" className="flex items-end gap-1 overflow-x-auto">
          {userConfig.repos.map((r) => (
            <div
              key={r}
              role="tab"
              aria-selected={r === repo}
              onClick={() => pick(r)}
              title={r}
              className={`group flex h-8 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 pl-3 pr-1.5 font-mono text-xs ${r === repo ? "border-stone-300 bg-stone-100 font-medium dark:border-stone-600 dark:bg-stone-700" : "border-transparent text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-700"}`}
            >
              <span>{repoName(r)}</span>
              <button
                onClick={(e) => { e.stopPropagation(); removeRepo(r); }}
                aria-label={`Remove ${repoName(r)} from Pando`}
                title="Remove from Pando"
                className={`h-5 w-5 rounded text-stone-400 hover:bg-stone-300 hover:text-stone-800 dark:hover:bg-stone-600 dark:hover:text-stone-100 ${r === repo ? "" : "invisible group-hover:visible"}`}
              >
                ×
              </button>
            </div>
          ))}
          <button onClick={addRepo} title="Add repository" className="h-8 rounded-t-md px-3 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-700">+</button>
        </div>
        <div className="grow" />
        {repo && (
          <button onClick={() => setScreen(screen.kind === "settings" ? { kind: "list" } : { kind: "settings" })} aria-label="Repository settings" title="Repository settings" className={`my-1.5 rounded-md px-2.5 ${screen.kind === "settings" ? "bg-stone-200 dark:bg-stone-600" : "hover:bg-stone-100 dark:hover:bg-stone-700"}`}>
            ⚙
          </button>
        )}
      </header>

      {fatal && (
        <div className="flex items-center gap-3 bg-red-100 px-4 py-2 text-xs text-red-900 dark:bg-red-900/40 dark:text-red-100">
          <span className="font-medium">Error:</span><span className="truncate">{fatal}</span>
          <div className="grow" />
          <button onClick={() => setFatal(null)} className="underline">dismiss</button>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 grow bg-stone-100 dark:bg-stone-900">
        {!repo ? (
          <main className="flex grow items-center justify-center p-6">
            <div className="rounded-lg border border-dashed border-stone-400 p-10 text-center">
              <div className="mb-1 font-medium">No repositories yet</div>
              <div className="mb-4 text-stone-500">Add one to see its branches and worktrees.</div>
              <button onClick={addRepo} className="h-8 rounded-lg bg-teal-700 px-3.5 font-medium text-white hover:bg-teal-800">Add repository</button>
            </div>
          </main>
        ) : screen.kind === "detail" ? (
          <Detail root={repo} path={screen.path} onBack={() => { setScreen({ kind: "list" }); bump(); }} onChanged={bump} />
        ) : screen.kind === "settings" ? (
          <Settings root={repo} userConfig={userConfig} onUserConfig={setUserConfig} />
        ) : (
          <Overview key={`${repo}-${tick}`} root={repo} onOpenDetail={(path) => setScreen({ kind: "detail", path })} onError={setFatal} />
        )}
      </div>
    </div>
  );
}
