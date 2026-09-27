import { useEffect, useState } from "react";

import { fromHash, type Route } from "./lib/routes";
import { openInNewWindow, setWindowTitle } from "./lib/windows";
import { installZoom } from "./lib/zoom";
import { RepoScreen } from "./screens/RepoScreen";
import { Repos } from "./screens/Repos";
import { Header } from "./ui/Header";
import { ConfirmHost } from "./ui/Confirm";

export default function App() {
  const [route, setRoute] = useState<Route>(() => fromHash(window.location.hash));
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => installZoom(), []);

  useEffect(() => {
    const onNewWindowKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); openInNewWindow(fromHash(window.location.hash)).catch((err) => setFatal(String(err))); }
    };
    window.addEventListener("keydown", onNewWindowKey);
    const onHash = () => setRoute(fromHash(window.location.hash));
    const onErr = (e: ErrorEvent) => setFatal(e.message);
    const onRej = (e: PromiseRejectionEvent) => setFatal(String(e.reason));
    window.addEventListener("hashchange", onHash);
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => { window.removeEventListener("keydown", onNewWindowKey); window.removeEventListener("hashchange", onHash); window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onRej); };
  }, []);

  useEffect(() => { setWindowTitle(route); setFatal(null); }, [route]);

  return (
    <div className="flex h-screen flex-col text-[13px]">
      <Header route={route} />
      <ConfirmHost />
      {fatal && (
        <div className="flex items-center gap-3 bg-red-100 px-4 py-2 text-xs text-red-900 dark:bg-red-900/40 dark:text-red-100">
          <span className="font-medium">Error:</span><span className="selectable truncate">{fatal}</span>
          <div className="grow" />
          <button onClick={() => setFatal(null)} className="underline">dismiss</button>
        </div>
      )}
      <div className="flex min-h-0 min-w-0 grow bg-stone-100 dark:bg-stone-900">
        {route.kind === "repos" && <Repos onError={setFatal} />}
        {route.kind !== "repos" && (
          // One instance per repo, so switching worktree or commit keeps the sidebar mounted.
          <RepoScreen
            key={route.root}
            root={route.root}
            commit={route.kind === "commit" ? route.id : null}
            worktree={route.kind === "worktree" ? route.path : null}
            onError={setFatal}
          />
        )}
      </div>
    </div>
  );
}
