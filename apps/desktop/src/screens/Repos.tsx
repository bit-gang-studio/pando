import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, changed, repoName, type Overview, type UserConfig } from "../lib/api";
import { navigate } from "../lib/routes";
import { openInNewWindow, wantsNewWindow } from "../lib/windows";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import { NewWindowIcon } from "../ui/icons";
import { confirm } from "../ui/Confirm";
import { MoreButton } from "../ui/MoreButton";
import { ErrorState, Loading } from "../ui/State";
import { toastError, withToast } from "../ui/Toast";
import { errorParts } from "../lib/errors";
import { openEditor, openTerminal, reveal, REVEAL_LABEL, useEditors, useTerminalName } from "../lib/reveal";
import { CloneDialog, loadRemoteRepos } from "../dialogs/CloneDialog";

export function Repos() {
  const [cfg, setCfg] = useState<UserConfig | null>(null);
  const [summaries, setSummaries] = useState<Record<string, Overview>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [cloning, setCloning] = useState(false);
  const term = useTerminalName();
  const editors = useEditors();
  // Start fetching your GitHub repos now, so Clone repository opens fast.
  useEffect(() => { const t = setTimeout(() => { loadRemoteRepos(); }, 1500); return () => clearTimeout(t); }, []);
  const [listError, setListError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const c = await api.reposList();
      setCfg(c);
      setListError(null);
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
      setListError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(() => { if (document.hasFocus()) refresh(); }, 15000);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  async function addRepo() {
    const picked = await open({ directory: true, multiple: false, title: "Add a repository" });
    if (typeof picked !== "string") return;
    const c = await withToast("Adding repository…", `Added ${repoName(picked)}`, () => api.reposAdd(picked));
    if (c) { setCfg(c); refresh(); }
  }

  async function removeRepo(root: string) {
    const r = await confirm({ title: "Remove repository", body: `Remove ${repoName(root)} from Pando? Nothing on disk changes.`, action: "Remove from Pando" });
    if (!r.ok) return;
    const c = await withToast("Removing…", `Removed ${repoName(root)} from Pando`, () => api.reposRemove(root));
    if (c) setCfg(c);
  }

  const repoMenu = (e: React.MouseEvent, root: string) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: "Open in new window", onClick: () => openInNewWindow({ kind: "repo", root }).catch(toastError) },
      { label: "Copy path", onClick: () => navigator.clipboard.writeText(root) },
      { label: REVEAL_LABEL, onClick: () => reveal(root).catch(toastError) },
      ...(term ? [{ label: `Open in ${term}`, onClick: () => openTerminal(root) }] : []),
      ...editors.map((e) => ({ label: `Open in ${e}`, onClick: () => { openEditor(e, root); } })),
      { divider: true },
      { label: "Remove from Pando", onClick: () => removeRepo(root), danger: true },
    ] });
  };

  if (!cfg && listError) return <ErrorState title="Couldn't read your repository list" error={listError} onRetry={refresh} />;
  if (!cfg) return <Loading />;

  return (
    <main className="flex min-w-0 grow flex-col gap-3 overflow-auto p-6">
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {cloning && <CloneDialog repos={cfg.repos} onClose={() => setCloning(false)} onCloned={(c) => { setCfg(c); refresh(); }} />}
      <div className="flex items-baseline gap-3">
        <h1 className="text-title font-semibold">Repositories</h1>
        <span className="text-body text-stone-500">{cfg ? cfg.repos.length : "…"}</span>
        <div className="grow" />
        <button onClick={() => setCloning(true)} className="h-7 rounded-md border border-stone-300 bg-white px-3 text-body hover:bg-stone-100 dark:border-stone-600 dark:bg-stone-700">Clone repository</button>
        <button onClick={addRepo} className="h-7 rounded-md bg-teal-700 px-3 text-body font-medium text-white hover:bg-teal-800">Add repository</button>
      </div>
      {cfg && cfg.repos.length === 0 && (
        <div className="rounded-lg border border-dashed border-stone-400 p-10 text-center">
          <div className="mb-1 font-medium">No repositories yet</div>
          <div className="mb-4 text-stone-500">Add one to see its branches and worktrees.</div>
          <div className="flex justify-center gap-2">
            <button onClick={() => setCloning(true)} className="h-8 rounded-lg border border-stone-300 bg-white px-3 dark:border-stone-600 dark:bg-stone-700">Clone repository</button>
            <button onClick={addRepo} className="h-8 rounded-lg bg-teal-700 px-3.5 font-medium text-white hover:bg-teal-800">Add repository</button>
          </div>
        </div>
      )}
      {cfg && cfg.repos.length > 0 && (
        <table className="w-full border-collapse text-body">
          <thead>
            <tr className="text-left text-label font-semibold tracking-wider text-stone-500">
              <th className="w-[220px] px-2 py-1.5 font-semibold">NAME</th>
              <th className="px-2 py-1.5 font-semibold">PATH</th>
              <th className="w-[110px] px-2 py-1.5 text-right font-semibold">WORKTREES</th>
              <th className="w-[130px] px-2 py-1.5 text-right font-semibold">CHANGES</th>
              <th className="w-[76px] px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {cfg.repos.map((root) => {
              const route = { kind: "repo" as const, root };
              const o = summaries[root];
              const wts = o ? o.branches.filter((b) => b.worktree).length + o.detached.length : null;
              const dirty = o ? o.branches.reduce((n, b) => n + changed(b.status), 0) + o.detached.reduce((n, d) => n + changed(d.status), 0) : null;
              return (
                <tr
                  key={root}
                  onClick={(e) => (wantsNewWindow(e) ? openInNewWindow(route).catch(toastError) : navigate(route))}
                  onContextMenu={(e) => repoMenu(e, root)}
                  className="cursor-pointer border-t border-stone-200 hover:bg-white dark:border-stone-700 dark:hover:bg-stone-800"
                >
                  <td className="px-2 py-2 font-mono font-medium">{repoName(root)}</td>
                  <td className="max-w-0 truncate px-2 py-2 text-stone-500" title={root}>{root}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{wts ?? (errors[root] ? "!" : "…")}</td>
                  <td title={errors[root] ? errorParts(errors[root]).message : undefined} className={`px-2 py-2 text-right tabular-nums ${errors[root] ? "text-red-700" : dirty ? "text-amber-700" : "text-stone-500"}`}>
                    {errors[root] ? "can't read" : dirty === null ? "…" : dirty === 0 ? "clean" : `${dirty} changed`}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-right">
                    <button onClick={(e) => { e.stopPropagation(); openInNewWindow(route).catch(toastError); }} title="Open in new window" aria-label={`Open ${repoName(root)} in new window`} className="inline-flex items-center rounded px-2 py-1 text-stone-400 hover:bg-stone-200 hover:text-stone-800 dark:hover:bg-stone-700 dark:hover:text-stone-100"><NewWindowIcon /></button>
                    <MoreButton onOpen={(e) => repoMenu(e, root)} label={`Actions for ${repoName(root)}`} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {cfg && cfg.repos.length > 0 && <div className="px-1 text-body text-stone-500">⌘-click a row to open it in a new window.</div>}
    </main>
  );
}
