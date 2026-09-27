import { useEffect, useState } from "react";
import { errorParts } from "../lib/errors";
import { Spinner } from "./State";

type Item = { id: number; kind: "busy" | "ok" | "error"; text: string; detail?: string };
let items: Item[] = [];
let listener: ((i: Item[]) => void) | null = null;
let next = 1;
const emit = () => listener?.([...items]);
const drop = (id: number) => { items = items.filter((i) => i.id !== id); emit(); };
const put = (it: Item) => {
  items = items.some((i) => i.id === it.id) ? items.map((i) => (i.id === it.id ? it : i)) : [...items, it];
  emit();
  if (it.kind === "ok") setTimeout(() => drop(it.id), 2500);
};

/// Show an error until dismissed. Same message twice shows once.
export function toastError(e: unknown) {
  const { message, detail } = errorParts(e);
  if (items.some((i) => i.kind === "error" && i.text === message)) return;
  put({ id: next++, kind: "error", text: message, detail: detail !== message ? detail : undefined });
}

/// Run an action with feedback: "Pushing…" while it runs, then "Pushed" or the error.
export async function withToast<T>(doing: string, done: string, fn: () => Promise<T>): Promise<T | undefined> {
  const id = next++;
  // Only show "doing" if it takes a moment.
  const t = setTimeout(() => put({ id, kind: "busy", text: doing }), 250);
  try {
    const r = await fn();
    clearTimeout(t);
    put({ id, kind: "ok", text: done });
    return r;
  } catch (e) {
    clearTimeout(t);
    drop(id);
    toastError(e);
    return undefined;
  }
}

/// Mount once near the root of each window.
export function ToastHost() {
  const [list, setList] = useState<Item[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { listener = setList; return () => { listener = null; }; }, []);
  if (list.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2">
      {list.map((i) => (
        <div key={i.id} role={i.kind === "error" ? "alert" : "status"} className={`pointer-events-auto flex flex-col gap-1 rounded-lg border px-3 py-2 text-body shadow-lg ${i.kind === "error" ? "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100" : "border-stone-300 bg-white text-stone-800 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100"}`}>
          <div className="flex items-start gap-2">
            {i.kind === "busy" ? <span className="mt-1"><Spinner /></span> : i.kind === "ok" ? <span className="text-teal-700">✓</span> : <span className="font-semibold">✕</span>}
            <span className="selectable min-w-0 grow break-words">{i.text}</span>
            {i.kind === "error" && i.detail && <button onClick={() => setOpen(open === i.id ? null : i.id)} className="shrink-0 text-label underline">{open === i.id ? "Hide" : "Details"}</button>}
            {i.kind !== "busy" && <button onClick={() => drop(i.id)} aria-label="Dismiss" className="shrink-0 px-1 opacity-60 hover:opacity-100">×</button>}
          </div>
          {open === i.id && i.detail && <pre className="selectable max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white/60 p-2 font-mono text-label dark:bg-black/30">{i.detail}</pre>}
        </div>
      ))}
    </div>
  );
}
