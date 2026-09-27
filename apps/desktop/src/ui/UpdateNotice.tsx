import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toastError } from "./Toast";

const EVERY = 6 * 60 * 60 * 1000;

/// "Pando x.y is available" with Update and restart. Main window only, never in dev.
export function UpdateNotice() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    if (import.meta.env.DEV || getCurrentWindow().label !== "main") return;
    const look = () => check().then((u) => { if (u) setUpdate(u); }).catch(() => { /* offline: try later */ });
    look();
    const t = setInterval(look, EVERY);
    return () => clearInterval(t);
  }, []);

  async function install() {
    if (!update) return;
    let total = 0, got = 0;
    setProgress(0);
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        if (e.event === "Progress") { got += e.data.chunkLength; if (total) setProgress(Math.round((got / total) * 100)); }
      });
      await relaunch();
    } catch (e) {
      setProgress(null);
      toastError(e);
    }
  }

  if (!update) return null;
  return (
    <div role="status" className="fixed bottom-4 left-4 z-50 flex items-center gap-3 rounded-lg border border-stone-300 bg-white px-3 py-2 text-body shadow-lg dark:border-stone-600 dark:bg-stone-800">
      <span>Pando {update.version} is available.</span>
      {progress === null ? (
        <>
          <button onClick={install} className="h-7 rounded-md bg-teal-700 px-2.5 font-medium text-white hover:bg-teal-800">Update and restart</button>
          <button onClick={() => setUpdate(null)} className="h-7 px-1 text-stone-500 hover:text-stone-800 dark:hover:text-stone-200">Later</button>
        </>
      ) : (
        <span className="text-stone-500">Downloading… {progress}%</span>
      )}
    </div>
  );
}
