import { useEffect, useRef, useState } from "react";
import { useLayer } from "../lib/keys";
import { ErrorLine } from "../ui/State";

type Props = {
  title: string;
  /// What this will do, in a sentence.
  body: React.ReactNode;
  action: string;
  /// The message to start from. Resolves once it's known.
  initial: Promise<string>;
  /// Do it. A failure stays in the dialog with what was typed.
  onSubmit: (message: string) => Promise<void>;
  onClose: () => void;
};

/// A commit message: summary and description, like the commit box.
export function MessageDialog({ title, body, action, initial, onSubmit, onClose }: Props) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    initial.then((m) => {
      if (!live) return;
      const [first, ...rest] = m.split("\n");
      setSummary(first ?? "");
      setDescription(rest.join("\n").trim());
    }).catch((e) => { if (live) setError(String(e)); }).finally(() => { if (live) { setLoaded(true); requestAnimationFrame(() => ref.current?.select()); } });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const can = loaded && !busy && summary.trim().length > 0;
  async function submit() {
    if (!can) return;
    setBusy(true);
    setError(null);
    try { await onSubmit(description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim()); onClose(); }
    catch (e) { setError(String(e)); setBusy(false); }
  }

  const isTop = useLayer("overlay", busy ? null : onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && isTop()) { e.preventDefault(); submit(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const field = "rounded-md border border-stone-300 bg-white px-2 text-body focus:border-teal-700 focus:outline-none disabled:opacity-50 dark:border-stone-600 dark:bg-stone-700";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" aria-labelledby="msg-title" className="flex max-h-[90vh] w-[560px] flex-col overflow-hidden rounded-xl border border-stone-300 bg-white text-body shadow-xl dark:border-stone-700 dark:bg-stone-800">
        <div className="flex flex-col gap-1 border-b border-stone-300 px-5 py-4 dark:border-stone-700">
          <h2 id="msg-title" className="text-title font-semibold">{title}</h2>
          <span className="text-stone-500">{body}</span>
        </div>
        <div className="flex flex-col gap-2 p-5">
          {error && <ErrorLine error={error} />}
          <input ref={ref} value={summary} onChange={(e) => setSummary(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) submit(); }} disabled={!loaded} placeholder="Summary" aria-label="Summary" spellCheck={false} className={`h-8 ${field}`} />
          <textarea rows={8} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!loaded} placeholder="Description (optional)" aria-label="Description" className={`resize-none py-2 ${field}`} />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-stone-300 px-5 py-3 dark:border-stone-700">
          <button onClick={onClose} disabled={busy} className="h-8 rounded-lg border border-stone-300 bg-white px-3 hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600">Cancel</button>
          <button onClick={submit} disabled={!can} className="h-8 rounded-lg bg-teal-700 px-3.5 font-medium text-white hover:bg-teal-800 disabled:opacity-40">{busy ? "Working…" : action}<span className="ml-2 opacity-70">⌘↵</span></button>
        </div>
      </div>
    </div>
  );
}
