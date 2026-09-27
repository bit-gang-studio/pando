import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { Loading } from "./State";

const isMac = navigator.userAgent.includes("Mac");
const SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

/// One check in flight per set of folders, even if the effect runs twice.
const inflight = new Map<string, Promise<string[]>>();
function checkOnce(roots: string[]): Promise<string[]> {
  const key = roots.join("\0");
  let p = inflight.get(key);
  if (!p) {
    p = api.accessCheck(roots).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/// Runs one folder-access check before anything else, so macOS asks once and
/// no git starts until it's answered. Shows how to fix it if access is denied.
export function AccessGate({ root, children }: { root: string | null; children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "ok" | string[]>("checking");

  const check = useCallback(async () => {
    setState("checking");
    try {
      const roots = new Set((await api.reposList()).repos);
      if (root) roots.add(root);
      const denied = (await checkOnce([...roots].sort())) ?? [];
      setState(denied.length ? denied : "ok");
    } catch {
      // The repo list itself failed: the Repositories screen shows that error.
      setState("ok");
    }
  }, [root]);

  useEffect(() => { check(); }, [check]);

  if (state === "checking") return <Loading />;
  if (state === "ok") return <>{children}</>;
  return (
    <div className="flex grow items-center justify-center p-6">
      <div className="flex max-w-md flex-col gap-3 text-body">
        <h1 className="text-title font-semibold">Pando can't read your repositories</h1>
        <p className="text-stone-600 dark:text-stone-300">
          {isMac ? "macOS is blocking access to:" : "Your system is blocking access to:"}
        </p>
        <ul className="selectable flex flex-col gap-0.5 font-mono text-stone-700 dark:text-stone-200">
          {state.map((p) => <li key={p} className="truncate" title={p}>{p}</li>)}
        </ul>
        {isMac && <p className="text-stone-600 dark:text-stone-300">Open System Settings → Privacy &amp; Security → Files and Folders, turn on the folder for Pando, then try again.</p>}
        <div className="flex gap-2">
          {isMac && <button onClick={() => openUrl(SETTINGS)} className="h-8 rounded-lg bg-teal-700 px-3.5 font-medium text-white hover:bg-teal-800">Open System Settings</button>}
          <button onClick={check} className="h-8 rounded-lg border border-stone-300 bg-white px-3 dark:border-stone-600 dark:bg-stone-700">Try again</button>
        </div>
      </div>
    </div>
  );
}
