import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir } from "@tauri-apps/api/path";
import { api, type RemoteRepo, type UserConfig } from "../lib/api";
import { ErrorLine, Loading } from "../ui/State";

const LAST = "pando.cloneParent";

/// Your GitHub repos, fetched once per session. The Repositories page starts
/// this early so the dialog usually opens straight onto the list.
let cached: Promise<RemoteRepo[] | null> | null = null;
export function loadRemoteRepos(): Promise<RemoteRepo[] | null> {
  cached ??= api.remoteRepos().then((r) => r ?? null).catch(() => { cached = null; return null; });
  return cached;
}

/// "owner/repo" or a git URL: something we can clone as typed.
const looksClonable = (s: string) => /^[\w.-]+\/[\w.-]+$/.test(s) || /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(s);
/// Mirrors core's clone_folder_name for the preview.
const folderName = (s: string) => s.trim().replace(/[/\\]+$/, "").replace(/\.git$/, "").split(/[/:\\]/).pop() ?? "";

/// Where most of your repos already live: the usual first choice.
function commonParent(repos: string[]): string | null {
  const count = new Map<string, number>();
  for (const r of repos) {
    const p = r.replace(/[/\\][^/\\]+$/, "");
    count.set(p, (count.get(p) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export function CloneDialog({ repos, onClose, onCloned }: { repos: string[]; onClose: () => void; onCloned: (c: UserConfig) => void }) {
  const [list, setList] = useState<RemoteRepo[] | null | "loading">("loading");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadRemoteRepos().then(setList);
    let last: string | null = null;
    try { last = localStorage.getItem(LAST); } catch { /* ignore */ }
    const fallback = commonParent(repos);
    if (last || fallback) setParent((last || fallback)!);
    else homeDir().then(setParent).catch(() => {});
    searchRef.current?.focus();
  }, [repos]);

  const q = query.trim();
  const shown = useMemo(() => {
    if (!Array.isArray(list)) return [];
    const needle = q.toLowerCase();
    return (needle ? list.filter((r) => r.name.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle)) : list).slice(0, 200);
  }, [list, q]);

  const source = picked ?? (looksClonable(q) ? q : null);
  const name = source ? folderName(source) : "";
  const sep = parent.includes("\\") ? "\\" : "/";
  const dest = source && parent ? `${parent.replace(/[/\\]+$/, "")}${sep}${name}` : "";
  const exists = !!name && repos.some((r) => r === dest);
  const canClone = !!source && !!parent && !!name && !busy && !exists;

  async function choose() {
    const d = await open({ directory: true, multiple: false, title: "Clone into", defaultPath: parent || undefined });
    if (typeof d === "string") setParent(d);
  }

  async function clone() {
    if (!canClone || !source) return;
    setBusy(true);
    setError(null);
    try {
      const c = await api.repoClone(source, parent);
      try { localStorage.setItem(LAST, parent); } catch { /* ignore */ }
      onCloned(c);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" aria-labelledby="clone-title" className="flex w-[640px] flex-col overflow-hidden rounded-xl border border-stone-300 bg-white text-body shadow-xl dark:border-stone-700 dark:bg-stone-800">
        <div className="border-b border-stone-300 px-5 py-4 dark:border-stone-700">
          <h2 id="clone-title" className="text-title font-semibold">Clone repository</h2>
        </div>
        <div className="flex flex-col gap-3 p-5">
          <input ref={searchRef} value={query} onChange={(e) => { setQuery(e.target.value); setPicked(null); }} onKeyDown={(e) => { if (e.key === "Enter") clone(); }}
            placeholder={Array.isArray(list) ? "Search your repos, or paste a URL" : "Paste a URL or owner/repo"} spellCheck={false}
            className="h-8 shrink-0 rounded-md border border-stone-300 bg-white px-2 font-mono focus:border-teal-700 focus:outline-none dark:border-stone-600 dark:bg-stone-700" />
          <div className="flex h-64 shrink-0 flex-col overflow-y-auto rounded-md border border-stone-200 dark:border-stone-700">
            {list === "loading" && <Loading label="Loading your repos…" />}
            {list === null && <div className="p-3 text-stone-500">Sign in to GitHub's gh tool to see your repos here. You can still paste any URL.</div>}
            {Array.isArray(list) && shown.length === 0 && <div className="p-3 text-stone-500">{looksClonable(q) ? <>Clone <span className="font-mono">{q}</span> as typed.</> : "No match."}</div>}
            {shown.map((r) => (
              <button key={r.name} onClick={() => setPicked(r.name)} data-selected={picked === r.name}
                className={`flex w-full flex-col items-start px-3 py-1.5 text-left ${picked === r.name ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}>
                <span className="flex w-full items-center gap-2"><span className="truncate font-mono">{r.name}</span>{r.private && <span className="shrink-0 rounded bg-stone-200 px-1.5 text-label text-stone-600 dark:bg-stone-700 dark:text-stone-300">private</span>}</span>
                {r.description && <span className="w-full truncate text-label text-stone-500">{r.description}</span>}
              </button>
            ))}
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="font-medium text-stone-600 dark:text-stone-300">Location</span>
            <div className="flex gap-2">
              <input value={parent} onChange={(e) => setParent(e.target.value)} spellCheck={false} className="h-8 min-w-0 grow rounded-md border border-stone-300 bg-white px-2 font-mono dark:border-stone-600 dark:bg-stone-700" />
              <button onClick={choose} className="h-8 rounded-lg border border-stone-300 bg-white px-3 dark:border-stone-600 dark:bg-stone-700">Choose…</button>
            </div>
            {dest && <span className={`selectable truncate font-mono text-label ${exists ? "text-red-700" : "text-stone-500"}`} title={dest}>{exists ? `${dest} is already in Pando` : `Clones to ${dest}`}</span>}
          </label>
          {error && <ErrorLine error={error} />}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-stone-300 bg-stone-50 px-5 py-3.5 dark:border-stone-700 dark:bg-stone-900/40">
          <span className="grow text-stone-500">Runs git clone.</span>
          <button onClick={onClose} disabled={busy} className="h-8 rounded-lg border border-stone-300 bg-white px-3 dark:border-stone-600 dark:bg-stone-700">Cancel</button>
          <button onClick={clone} disabled={!canClone} className="h-8 rounded-lg bg-teal-700 px-3.5 font-medium text-white hover:bg-teal-800 disabled:opacity-50">{busy ? "Cloning…" : "Clone"}</button>
        </div>
      </div>
    </div>
  );
}
