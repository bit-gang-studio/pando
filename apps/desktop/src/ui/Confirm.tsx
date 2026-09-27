import { useEffect, useRef, useState } from "react";

export type ConfirmOptions = {
  title: string;
  body: React.ReactNode;
  /// Label for the action button, a verb: "Remove worktree", "Delete branch".
  action: string;
  /// Red action button. Cancel gets focus so Enter never destroys by accident.
  danger?: boolean;
  /// Optional extra choice, e.g. "Also delete origin/feat/x".
  checkbox?: { label: string; checked?: boolean };
};
export type ConfirmResult = { ok: boolean; checked: boolean };

type Pending = ConfirmOptions & { resolve: (r: ConfirmResult) => void };
let show: ((p: Pending) => void) | null = null;

/// Ask the user to confirm. Resolves when they choose.
export function confirm(opts: ConfirmOptions): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    if (show) show({ ...opts, resolve });
    else resolve({ ok: window.confirm(`${opts.title}\n\n${typeof opts.body === "string" ? opts.body : ""}`), checked: !!opts.checkbox?.checked });
  });
}

/// Mount once near the root of each window.
export function ConfirmHost() {
  const [p, setP] = useState<Pending | null>(null);
  const [checked, setChecked] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    show = (next) => { setChecked(!!next.checkbox?.checked); setP(next); };
    return () => { show = null; };
  }, []);

  useEffect(() => {
    if (!p) return;
    (p.danger ? cancelRef : actionRef).current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); done(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  function done(ok: boolean) {
    if (!p) return;
    p.resolve({ ok, checked });
    setP(null);
  }

  if (!p) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) done(false); }}>
      <div role="alertdialog" aria-labelledby="confirm-title" className="flex w-[420px] flex-col gap-3 rounded-xl border border-stone-300 bg-white p-5 text-[13px] shadow-xl dark:border-stone-700 dark:bg-stone-800">
        <h2 id="confirm-title" className="text-base font-semibold">{p.title}</h2>
        <div className="text-stone-600 dark:text-stone-300">{p.body}</div>
        {p.checkbox && (
          <label className="flex items-center gap-2"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {p.checkbox.label}</label>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <button ref={cancelRef} onClick={() => done(false)} className="h-8 rounded-lg border border-stone-300 bg-white px-3 focus:outline-none focus:ring-2 focus:ring-teal-600 dark:border-stone-600 dark:bg-stone-700">Cancel</button>
          <button ref={actionRef} onClick={() => done(true)} className={`h-8 rounded-lg px-3.5 font-medium text-white focus:outline-none focus:ring-2 focus:ring-offset-1 ${p.danger ? "bg-red-700 hover:bg-red-800 focus:ring-red-600" : "bg-teal-700 hover:bg-teal-800 focus:ring-teal-600"}`}>{p.action}</button>
        </div>
      </div>
    </div>
  );
}
