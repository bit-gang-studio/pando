import { useEffect, useState } from "react";
import { errorParts } from "../lib/errors";

/// Centered "Loading…" that waits a moment, so fast loads never flash.
export function Loading({ label = "Loading…" }: { label?: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { const t = setTimeout(() => setShown(true), 150); return () => clearTimeout(t); }, []);
  return (
    <div className="flex grow items-center justify-center gap-2 p-4 text-body text-stone-500">
      {shown && <><Spinner />{label}</>}
    </div>
  );
}

export function Spinner() {
  return <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600 dark:border-stone-600 dark:border-t-stone-300" />;
}

/// A failed load, in place, with Retry.
export function ErrorState({ error, onRetry, title = "Couldn't load this" }: { error: unknown; onRetry?: () => void; title?: string }) {
  const { message, detail } = errorParts(error);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex grow items-center justify-center p-4">
      <div className="flex max-w-md flex-col items-center gap-2 text-center text-body">
        <span className="font-medium text-stone-800 dark:text-stone-100">{title}</span>
        <span className="selectable text-red-700 dark:text-red-400">{message}</span>
        <div className="flex gap-2">
          {onRetry && <button onClick={onRetry} className="h-7 rounded-md border border-stone-300 bg-white px-2.5 hover:bg-stone-100 dark:border-stone-600 dark:bg-stone-700">Retry</button>}
          {detail !== message && <button onClick={() => setOpen((v) => !v)} className="h-7 px-1 text-stone-500 hover:text-stone-800 dark:hover:text-stone-200">{open ? "Hide details" : "Details"}</button>}
        </div>
        {open && <pre className="selectable max-h-48 w-full overflow-auto whitespace-pre-wrap rounded bg-stone-100 p-2 text-left font-mono text-label dark:bg-stone-900">{detail}</pre>}
      </div>
    </div>
  );
}

/// An error inside a dialog or panel: one readable line, full git output under Details.
export function ErrorLine({ error, className = "" }: { error: unknown; className?: string }) {
  const { message, detail } = errorParts(error);
  const [open, setOpen] = useState(false);
  return (
    <div className={`flex flex-col gap-1 rounded-md border border-red-300 bg-red-50 p-2 text-body text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200 ${className}`}>
      <div className="flex items-start gap-2">
        <span className="selectable min-w-0 grow">{message}</span>
        {detail !== message && <button onClick={() => setOpen((v) => !v)} className="shrink-0 text-label underline">{open ? "Hide" : "Details"}</button>}
      </div>
      {open && <pre className="selectable max-h-48 overflow-auto whitespace-pre-wrap font-mono text-label">{detail}</pre>}
    </div>
  );
}
