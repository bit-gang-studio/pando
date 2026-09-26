import { useEffect, useState } from "react";
import { api, type UserConfig } from "./lib/api";
import { fromHash, navigate, type Route } from "./lib/routes";
import { openInNewWindow, setWindowTitle } from "./lib/windows";
import { Detail } from "./screens/Detail";
import { RepoScreen } from "./screens/RepoScreen";
import { Repos } from "./screens/Repos";
import { Settings } from "./screens/Settings";
import { Header } from "./ui/Header";

export default function App() {
  const [route, setRoute] = useState<Route>(() => fromHash(window.location.hash));
  const [userConfig, setUserConfig] = useState<UserConfig>({ repos: [], editor: null });
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    const ZOOM_KEY = "pando.zoom";
    const apply = (z: number) => { (document.documentElement.style as unknown as { zoom: string }).zoom = String(z); try { localStorage.setItem(ZOOM_KEY, String(z)); } catch { /* ignore */ } };
    let zoom = 1;
    try { zoom = Number(localStorage.getItem(ZOOM_KEY)) || 1; } catch { /* ignore */ }
    apply(zoom);
    const onZoomKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); openInNewWindow(fromHash(window.location.hash)).catch((err) => setFatal(String(err))); return; }
      if (e.key === "=" || e.key === "+") { e.preventDefault(); zoom = Math.min(2, Math.round((zoom + 0.1) * 10) / 10); apply(zoom); }
      else if (e.key === "-") { e.preventDefault(); zoom = Math.max(0.6, Math.round((zoom - 0.1) * 10) / 10); apply(zoom); }
      else if (e.key === "0") { e.preventDefault(); zoom = 1; apply(zoom); }
    };
    window.addEventListener("keydown", onZoomKey);
    const onHash = () => setRoute(fromHash(window.location.hash));
    const onErr = (e: ErrorEvent) => setFatal(e.message);
    const onRej = (e: PromiseRejectionEvent) => setFatal(String(e.reason));
    window.addEventListener("hashchange", onHash);
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    api.reposList().then(setUserConfig).catch(() => {});
    return () => { window.removeEventListener("keydown", onZoomKey); window.removeEventListener("hashchange", onHash); window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onRej); };
  }, []);

  useEffect(() => { setWindowTitle(route); setFatal(null); }, [route]);

  const gear = route.kind === "repo" || route.kind === "commit" ? (
    <button onClick={() => navigate({ kind: "settings", root: route.root })} aria-label="Repository settings" title="Repository settings" className="rounded-md px-2.5 py-1 hover:bg-stone-100 dark:hover:bg-stone-700">⚙</button>
  ) : null;

  return (
    <div className="flex h-screen flex-col text-[13px]">
      <Header route={route} right={gear} />
      {fatal && (
        <div className="flex items-center gap-3 bg-red-100 px-4 py-2 text-xs text-red-900 dark:bg-red-900/40 dark:text-red-100">
          <span className="font-medium">Error:</span><span className="truncate">{fatal}</span>
          <div className="grow" />
          <button onClick={() => setFatal(null)} className="underline">dismiss</button>
        </div>
      )}
      <div className="flex min-h-0 min-w-0 grow bg-stone-100 dark:bg-stone-900">
        {route.kind === "repos" && <Repos onError={setFatal} />}
        {route.kind === "repo" && <RepoScreen key={route.root} root={route.root} commit={null} onError={setFatal} />}
        {route.kind === "commit" && <RepoScreen key={route.root} root={route.root} commit={route.id} onError={setFatal} />}
        {route.kind === "worktree" && <Detail root={route.root} path={route.path} onBack={() => navigate({ kind: "repo", root: route.root })} onChanged={() => {}} />}
        {route.kind === "settings" && <Settings root={route.root} userConfig={userConfig} onUserConfig={setUserConfig} />}
      </div>
    </div>
  );
}
