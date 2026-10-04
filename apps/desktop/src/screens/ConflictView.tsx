import { useEffect, useRef, useState } from "react";
import { api, type Choice, type ConflictFile, type Operation, type Part } from "../lib/api";
import { overlayOpen } from "../lib/keys";
import { ErrorLine, ErrorState, Loading } from "../ui/State";

type Props = {
  worktree: string;
  path: string;
  op: Operation;
  onChanged: () => void;
  /// Go to the next file that still has conflicts, if any.
  onNextFile?: () => void;
};
type Conflict = Extract<Part, { kind: "conflict" }>;

const btn = "h-6.5 shrink-0 rounded border border-stone-300 bg-white px-2 text-label hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600";
const primary = "h-6.5 shrink-0 rounded bg-teal-700 px-2.5 text-label font-medium text-white hover:bg-teal-800 disabled:opacity-40";
const CONTEXT = 3;

/// Picks made so far, per file, so leaving and coming back keeps them.
/// Tied to the file's text: if the file changes, the picks are dropped.
const drafts = new Map<string, { working: string; choices: (Choice | null)[] }>();

/// Names for the two sides, in the user's terms.
export function sideNames(op: Operation) {
  switch (op.kind) {
    case "rebase": return { ours: op.head_label, oursHint: "already there", theirs: op.incoming_label, theirsHint: "your commit" };
    case "merge": return { ours: op.head_label, oursHint: "this branch", theirs: op.incoming_label, theirsHint: "coming in" };
    default: return { ours: op.head_label || "this branch", oursHint: "this branch", theirs: op.incoming_label, theirsHint: "the commit" };
  }
}

const lines = (t: string) => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));

function result(c: Conflict, ch: Choice): string {
  switch (ch.kind) {
    case "ours": return c.ours;
    case "theirs": return c.theirs;
    case "base": return c.base ?? "";
    case "both": return c.ours && !c.ours.endsWith("\n") ? `${c.ours}\n${c.theirs}` : c.ours + c.theirs;
    case "text": return ch.text;
  }
}

export function ConflictView({ worktree, path, op, onChanged, onNextFile }: Props) {
  const [f, setF] = useState<ConflictFile | null>(null);
  const [choices, setChoices] = useState<(Choice | null)[]>([]);
  const [cur, setCur] = useState(0);
  const [showBase, setShowBase] = useState(false);
  const [whole, setWhole] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cards = useRef<(HTMLDivElement | null)[]>([]);
  const key = `${worktree}\0${path}`;

  const load = () => api.conflictFile(worktree, path).then((x) => {
    const n = x.parts.filter((p) => p.kind === "conflict").length;
    const d = drafts.get(key);
    const kept = d && d.working === x.working && d.choices.length === n ? d.choices : Array<Choice | null>(n).fill(null);
    setF(x);
    setChoices(kept);
    setCur(Math.max(0, kept.findIndex((c) => c === null)));
    setWhole(null);
    setError(null);
  }).catch((e) => setError(String(e)));
  useEffect(() => { setF(null); load(); }, [worktree, path]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try { await fn(); drafts.delete(key); await load(); onChanged(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  const conflicts = (f?.parts.filter((p) => p.kind === "conflict") ?? []) as Conflict[];
  const names = sideNames(op);
  const undecided = choices.findIndex((c) => c === null);

  // Scroll after the render, once a picked card above has collapsed.
  const [scrollTo, setScrollTo] = useState<{ i: number } | null>(null);
  useEffect(() => { if (scrollTo) cards.current[scrollTo.i]?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [scrollTo]);
  function go(i: number) {
    setCur(i);
    setScrollTo({ i });
  }
  /// The next undecided conflict below this one, else the next file, else
  /// back up to the first undecided one here.
  function next() {
    const after = choices.findIndex((c, i) => c === null && i > cur);
    if (after >= 0) go(after);
    else if (onNextFile && op.conflicted.some((p) => p !== path)) onNextFile();
    else if (undecided >= 0 && undecided !== cur) go(undecided);
  }

  function decide(i: number, ch: Choice | null) {
    if (!f) return;
    const nextChoices = choices.map((c, j) => (j === i ? ch : c));
    setChoices(nextChoices);
    drafts.set(key, { working: f.working, choices: nextChoices });
    if (ch === null) return;
    if (nextChoices.every((c) => c !== null)) {
      run(() => api.conflictChoose(worktree, path, nextChoices as Choice[]));
      return;
    }
    const after = nextChoices.findIndex((c, j) => c === null && j > i);
    go(after >= 0 ? after : nextChoices.findIndex((c) => c === null));
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || overlayOpen()) return;
      if (document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement) return;
      if (e.key === "ArrowDown") { e.preventDefault(); next(); }
      if (e.key === "ArrowUp") { e.preventDefault(); if (cur > 0) go(cur - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!f) return error ? <ErrorState title="Couldn't load this conflict" error={error} onRetry={load} /> : <Loading />;

  const stillConflicted = op.conflicted.includes(path);
  const all = [...new Set([...op.conflicted, ...op.resolved_by_you])].sort();
  const fileNo = all.indexOf(path) + 1;
  const hasBase = conflicts.some((c) => c.base !== null);
  const nextFile = onNextFile && op.conflicted.some((p) => p !== path);

  const header = (
    <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-stone-300 px-4 dark:border-stone-700">
      <span className="min-w-0 truncate font-mono text-body font-medium" title={path}>{path}</span>
      {fileNo > 0 && all.length > 1 && <span className="shrink-0 text-label text-stone-500">File {fileNo} of {all.length}</span>}
      {stillConflicted && conflicts.length > 0 && whole === null && (
        <span className="shrink-0 text-label text-stone-500">· Conflict {cur + 1} of {conflicts.length}</span>
      )}
      {!stillConflicted && <span className="shrink-0 text-label font-medium text-teal-700 dark:text-teal-400">✓ Resolved</span>}
      <div className="grow" />
      {stillConflicted && conflicts.length > 0 && whole === null && (
        <>
          {hasBase && <label className="flex shrink-0 items-center gap-1.5 text-label"><input type="checkbox" checked={showBase} onChange={(e) => setShowBase(e.target.checked)} /> Show original</label>}
          <button onClick={() => setWhole(f.working)} disabled={busy} className={btn}>Edit whole file</button>
          <button onClick={next} disabled={busy} className={btn} title="Next conflict (⌥↓)">Next conflict ⌥↓</button>
        </>
      )}
      {!stillConflicted && <button onClick={() => run(() => api.conflictReset(worktree, path))} disabled={busy} className={btn}>Back to conflicted</button>}
      {!stillConflicted && nextFile && <button onClick={onNextFile} className={primary}>Next file →</button>}
    </div>
  );

  let body;
  if (f.binary && stillConflicted) {
    body = (
      <Centered>
        Binary file. Pick a side.
        <div className="flex gap-2">
          <button onClick={() => run(() => api.conflictTake(worktree, path, "ours"))} disabled={busy} className={btn}>Keep {names.ours}</button>
          <button onClick={() => run(() => api.conflictTake(worktree, path, "theirs"))} disabled={busy} className={btn}>Keep {names.theirs}</button>
        </div>
      </Centered>
    );
  } else if (f.deleted && stillConflicted) {
    const gone = f.deleted === "ours" ? names.ours : names.theirs;
    const kept = f.deleted === "ours" ? names.theirs : names.ours;
    const keep = f.deleted === "ours" ? "theirs" : "ours";
    body = (
      <div className="flex min-h-0 grow flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-stone-200 bg-amber-50 px-4 py-2 text-body dark:border-stone-700 dark:bg-amber-900/20">
          <span><b className="font-mono">{gone}</b> deleted this file. <b className="font-mono">{kept}</b> changed it.</span>
          <div className="grow" />
          <button onClick={() => run(() => api.conflictTake(worktree, path, keep))} disabled={busy} className={btn}>Keep the file</button>
          <button onClick={() => run(() => api.conflictTake(worktree, path, f.deleted!))} disabled={busy} className={btn}>Delete the file</button>
        </div>
        <pre className="selectable min-h-0 grow overflow-auto p-3 font-mono text-body leading-5">{f.working}</pre>
      </div>
    );
  } else if (whole !== null) {
    const markers = /^(<{7}|={7}|>{7})( |$)/m.test(whole);
    body = (
      <div className="flex min-h-0 grow flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-stone-200 bg-stone-100 px-4 py-1 text-body dark:border-stone-700 dark:bg-stone-800/80">
          <span className="font-semibold">Whole file</span>
          <span className="text-stone-500">{markers ? "Remove every conflict marker, then save." : "No markers left."}</span>
          <div className="grow" />
          <button onClick={() => setWhole(null)} disabled={busy} className={btn}>Cancel</button>
          <button onClick={() => run(() => api.conflictResolve(worktree, path, whole))} disabled={busy || markers} className={primary}>Save and mark resolved</button>
        </div>
        <textarea aria-label="Whole file" value={whole} onChange={(e) => setWhole(e.target.value)} spellCheck={false} className="min-h-0 grow resize-none bg-white p-3 font-mono text-body leading-5 focus:outline-none dark:bg-stone-800" />
      </div>
    );
  } else if (!stillConflicted || conflicts.length === 0) {
    body = (
      <div className="flex min-h-0 grow flex-col">
        {stillConflicted && (
          <div className="shrink-0 border-b border-stone-200 bg-amber-50 px-4 py-2 text-body dark:border-stone-700 dark:bg-amber-900/20">
            Git marks this file conflicted, but it has no conflict markers left.{" "}
            <button onClick={() => run(() => api.conflictResolve(worktree, path, f.working))} disabled={busy} className="font-medium text-teal-700 underline dark:text-teal-400">Mark resolved</button>
          </div>
        )}
        <pre className="selectable min-h-0 grow overflow-auto p-3 font-mono text-body leading-5">{f.working || <span className="text-stone-400">(empty or deleted)</span>}</pre>
      </div>
    );
  } else {
    let n = -1;
    body = (
      <div className="min-h-0 grow overflow-auto bg-white py-2 font-mono text-body leading-5 dark:bg-stone-800">
        {f.parts.map((p, i) => {
          if (p.kind === "text") return <TextPart key={i} text={p.text} first={i === 0} last={i === f.parts.length - 1} />;
          const k = ++n;
          return (
            <Card
              key={i}
              ref={(el) => { cards.current[k] = el; }}
              n={k + 1}
              total={conflicts.length}
              c={p}
              names={names}
              choice={choices[k]}
              current={k === cur}
              showBase={showBase}
              busy={busy}
              onFocus={() => setCur(k)}
              onChoose={(ch) => decide(k, ch)}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 grow flex-col">
      {header}
      {error && <ErrorLine error={error} className="rounded-none border-x-0 border-t-0 px-4" />}
      {body}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex grow flex-col items-center justify-center gap-2 text-body text-stone-500">{children}</div>;
}

/// Plain text between conflicts. Long runs fold to a few lines on each side.
function TextPart({ text, first, last }: { text: string; first: boolean; last: boolean }) {
  const [open, setOpen] = useState(false);
  const all = lines(text);
  const head = first ? 0 : CONTEXT;
  const tail = last ? 0 : CONTEXT;
  const hidden = all.length - head - tail;
  if (open || hidden <= 1) return <Lines lines={all} />;
  return (
    <>
      <Lines lines={all.slice(0, head)} />
      <button onClick={() => setOpen(true)} className="my-0.5 w-full bg-stone-50 px-4 py-0.5 text-left font-sans text-label text-stone-500 hover:bg-stone-100 dark:bg-stone-900/40 dark:hover:bg-stone-700">
        ⋯ {hidden} unchanged {hidden === 1 ? "line" : "lines"}
      </button>
      <Lines lines={all.slice(all.length - tail)} />
    </>
  );
}

function Lines({ lines, tone = "", other }: { lines: string[]; tone?: string; other?: Set<string> }) {
  return (
    <>
      {lines.map((l, i) => (
        <div key={i} className={`whitespace-pre-wrap break-all px-4 ${tone} ${other && !other.has(l) ? "bg-black/5 font-semibold dark:bg-white/10" : ""}`}>
          {l || " "}
        </div>
      ))}
    </>
  );
}

type CardProps = {
  n: number; total: number; c: Conflict; names: ReturnType<typeof sideNames>; choice: Choice | null;
  current: boolean; showBase: boolean; busy: boolean; onFocus: () => void; onChoose: (c: Choice | null) => void;
  ref: (el: HTMLDivElement | null) => void;
};

const CHOSEN: Record<Choice["kind"], (n: CardProps["names"]) => string> = {
  ours: (n) => `Kept ${n.ours}`, theirs: (n) => `Kept ${n.theirs}`, both: () => "Kept both", base: () => "Kept the original", text: () => "Edited",
};

/// Clicking a card makes it current, but not when the click was a pick.
function focusUnlessButton(e: React.MouseEvent, onFocus: () => void) {
  if (!(e.target as HTMLElement).closest("button, textarea")) onFocus();
}

function Card({ n, total, c, names, choice, current, showBase, busy, onFocus, onChoose, ref }: CardProps) {
  const [edit, setEdit] = useState<string | null>(null);
  const ours = lines(c.ours), theirs = lines(c.theirs);
  const ring = current ? "border-amber-500 ring-2 ring-amber-500/20" : "border-stone-300 dark:border-stone-600";

  if (choice) {
    return (
      <div ref={ref} onClick={(e) => focusUnlessButton(e, onFocus)} role="group" aria-label={`Conflict ${n} of ${total}`} className={`mx-3 my-1.5 scroll-my-3 overflow-hidden rounded-md border ${current ? "border-teal-600" : "border-teal-600/40"}`}>
        <div className="flex items-center gap-2 bg-teal-50 px-3 py-1 font-sans text-label dark:bg-teal-900/30">
          <span className="font-semibold text-teal-800 dark:text-teal-300">✓ {CHOSEN[choice.kind](names)}</span>
          <span className="text-stone-500">Conflict {n} of {total}</span>
          <div className="grow" />
          <button onClick={() => onChoose(null)} disabled={busy} className="text-teal-700 hover:underline dark:text-teal-400">Change</button>
        </div>
        <Lines lines={lines(result(c, choice))} tone="bg-teal-50/40 dark:bg-teal-900/10" />
        {result(c, choice) === "" && <div className="px-4 font-sans text-label italic text-stone-400">(nothing)</div>}
      </div>
    );
  }

  return (
    <div ref={ref} onClick={(e) => focusUnlessButton(e, onFocus)} role="group" aria-label={`Conflict ${n} of ${total}`} className={`mx-3 my-1.5 scroll-my-3 overflow-hidden rounded-md border ${ring}`}>
      <div className="flex items-center gap-2 bg-amber-50 px-3 py-1 font-sans text-label dark:bg-amber-900/30">
        <span className="font-semibold text-amber-800 dark:text-amber-200">Conflict {n} of {total}</span>
      </div>
      <Side label={names.ours} hint={names.oursHint} tone="bg-sky-50 dark:bg-sky-900/20" lines={ours} other={new Set(theirs)} />
      {showBase && c.base !== null && <Side label="Original" hint="before either change" tone="bg-stone-50 dark:bg-stone-900/40" lines={lines(c.base)} />}
      <Side label={names.theirs} hint={names.theirsHint} tone="bg-violet-50 dark:bg-violet-900/20" lines={theirs} other={new Set(ours)} />
      {edit !== null ? (
        <div className="border-t border-stone-200 p-2 dark:border-stone-700">
          <textarea autoFocus aria-label={`Edit conflict ${n}`} value={edit} onChange={(e) => setEdit(e.target.value)} spellCheck={false} rows={Math.min(16, Math.max(3, lines(edit).length + 1))} className="w-full resize-y rounded border border-stone-300 bg-white p-2 font-mono text-body leading-5 focus:border-teal-700 focus:outline-none dark:border-stone-600 dark:bg-stone-900" />
          <div className="mt-1 flex justify-end gap-2 font-sans">
            <button onClick={() => setEdit(null)} className={btn}>Cancel</button>
            <button onClick={() => { const t = edit; setEdit(null); onChoose({ kind: "text", text: t === "" || t.endsWith("\n") ? t : `${t}\n` }); }} disabled={busy} className={primary}>Use this</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 border-t border-stone-200 px-3 py-1.5 font-sans dark:border-stone-700">
          <button onClick={() => onChoose({ kind: "ours" })} disabled={busy} className={btn}>Keep {names.ours}</button>
          <button onClick={() => onChoose({ kind: "theirs" })} disabled={busy} className={btn}>Keep {names.theirs}</button>
          <button onClick={() => onChoose({ kind: "both" })} disabled={busy} className={btn}>Keep both</button>
          {showBase && c.base !== null && <button onClick={() => onChoose({ kind: "base" })} disabled={busy} className={btn}>Keep original</button>}
          <button onClick={() => setEdit(result(c, { kind: "both" }))} disabled={busy} className={btn}>Edit</button>
        </div>
      )}
    </div>
  );
}

function Side({ label, hint, tone, lines: ls, other }: { label: string; hint: string; tone: string; lines: string[]; other?: Set<string> }) {
  return (
    <div className={tone}>
      <div className="px-3 pt-1 font-sans text-label"><span className="font-semibold">{label}</span> <span className="text-stone-500">· {hint}</span></div>
      <div className="pb-1">
        {ls.length ? <Lines lines={ls} other={other} /> : <div className="px-4 font-sans text-label italic text-stone-400">(nothing)</div>}
      </div>
    </div>
  );
}
