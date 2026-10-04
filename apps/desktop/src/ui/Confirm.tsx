import { useLayer } from "../lib/keys";
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
  /// Optional text field, e.g. a new branch name.
  input?: { label: string; value?: string; placeholder?: string; mono?: boolean };
  /// Optional pick-one list, e.g. which worktree to apply to.
  select?: { label: string; options: { value: string; label: string }[]; value?: string };
};
export type ConfirmResult = { ok: boolean; checked: boolean; value: string; choice: string };

type Pending = ConfirmOptions & { resolve: (r: ConfirmResult) => void };
let show: ((p: Pending) => void) | null = null;

/// Ask the user to confirm. Resolves when they choose.
export function confirm(opts: ConfirmOptions): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    if (show) show({ ...opts, resolve });
    else resolve({ ok: window.confirm(opts.title), checked: !!opts.checkbox?.checked, value: opts.input?.value ?? "", choice: opts.select?.value ?? "" });
  });
}

/// Mount once near the root of each window.
export function ConfirmHost() {
  const [p, setP] = useState<Pending | null>(null);
  const [checked, setChecked] = useState(false);
  const [value, setValue] = useState("");
  const [choice, setChoice] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    show = (next) => {
      setChecked(!!next.checkbox?.checked);
      setValue(next.input?.value ?? "");
      setChoice(next.select?.value ?? next.select?.options[0]?.value ?? "");
      setP(next);
    };
    return () => { show = null; };
  }, []);

  useEffect(() => {
    if (!p) return;
    if (p.input) inputRef.current?.focus();
    else (p.danger ? cancelRef : actionRef).current?.focus();
  });
  useLayer("overlay", () => done(false), !!p);

  function done(ok: boolean) {
    if (!p) return;
    if (ok && p.input && !value.trim()) return;
    p.resolve({ ok, checked, value: value.trim(), choice });
    setP(null);
  }

  if (!p) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) done(false); }}>
      <div role="alertdialog" aria-labelledby="confirm-title" className="flex w-[420px] flex-col gap-3 rounded-xl border border-stone-300 bg-white p-5 text-body shadow-xl dark:border-stone-700 dark:bg-stone-800">
        <h2 id="confirm-title" className="text-title font-semibold">{p.title}</h2>
        <div className="text-stone-600 dark:text-stone-300">{p.body}</div>
        {p.input && (
          <label className="flex flex-col gap-1.5">
            <span className="font-medium text-stone-600 dark:text-stone-300">{p.input.label}</span>
            <input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") done(true); }} placeholder={p.input.placeholder} spellCheck={false} className={`h-8 rounded-md border border-stone-300 bg-white px-2 focus:border-teal-700 focus:outline-none dark:border-stone-600 dark:bg-stone-700 ${p.input.mono ? "font-mono" : ""}`} />
          </label>
        )}
        {p.select && (
          <label className="flex flex-col gap-1.5">
            <span className="font-medium text-stone-600 dark:text-stone-300">{p.select.label}</span>
            <select value={choice} onChange={(e) => setChoice(e.target.value)} className="h-8 rounded-md border border-stone-300 bg-white px-2 font-mono dark:border-stone-600 dark:bg-stone-700">
              {p.select.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        )}
        {p.checkbox && (
          <label className="flex items-center gap-2"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {p.checkbox.label}</label>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <button ref={cancelRef} onClick={() => done(false)} className="h-8 rounded-lg border border-stone-300 bg-white px-3 focus:outline-none focus:ring-2 focus:ring-teal-600 dark:border-stone-600 dark:bg-stone-700">Cancel</button>
          <button ref={actionRef} onClick={() => done(true)} disabled={!!p.input && !value.trim()} className={`h-8 rounded-lg px-3.5 font-medium text-white focus:outline-none focus:ring-2 focus:ring-offset-1 ${p.danger ? "bg-red-700 hover:bg-red-800 focus:ring-red-600" : "bg-teal-700 hover:bg-teal-800 focus:ring-teal-600"} disabled:opacity-50`}>{p.action}</button>
        </div>
      </div>
    </div>
  );
}
