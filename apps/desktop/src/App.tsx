import { useEffect, useState } from "react";

import { fromHash, type Route } from "./lib/routes";
import { openInNewWindow, setWindowTitle } from "./lib/windows";
import { installZoom } from "./lib/zoom";
import { RepoScreen } from "./screens/RepoScreen";
import { Repos } from "./screens/Repos";
import { Header } from "./ui/Header";
import { ConfirmHost } from "./ui/Confirm";
import { ToastHost, toastError } from "./ui/Toast";
import { UpdateNotice } from "./ui/UpdateNotice";
import { AccessGate } from "./ui/AccessGate";

export default function App() {
  const [route, setRoute] = useState<Route>(() => fromHash(window.location.hash));

  useEffect(() => installZoom(), []);

  useEffect(() => {
    const onNewWindowKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); openInNewWindow(fromHash(window.location.hash)).catch(toastError); }
    };
    window.addEventListener("keydown", onNewWindowKey);
    const onHash = () => setRoute(fromHash(window.location.hash));
    const onErr = (e: ErrorEvent) => toastError(e.message);
    const onRej = (e: PromiseRejectionEvent) => toastError(e.reason);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => { window.removeEventListener("keydown", onNewWindowKey); window.removeEventListener("hashchange", onHash); window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onRej); };
  }, []);

  useEffect(() => { setWindowTitle(route); }, [route]);

  return (
    <div className="flex h-screen flex-col text-body">
      <Header route={route} />
      <ConfirmHost />
      <ToastHost />
      <UpdateNotice />
      <div className="flex min-h-0 min-w-0 grow bg-stone-100 dark:bg-stone-900">
        <AccessGate root={route.kind === "repos" ? null : route.root}>
        {route.kind === "repos" && <Repos />}
        {route.kind !== "repos" && (
          // One instance per repo, so switching worktree or commit keeps the sidebar mounted.
          <RepoScreen
            key={route.root}
            root={route.root}
            commit={route.kind === "commit" ? route.id : null}
            worktree={route.kind === "worktree" ? route.path : null}
            branch={route.kind === "branch" ? route.name : null}
          />
        )}
        </AccessGate>
      </div>
    </div>
  );
}
