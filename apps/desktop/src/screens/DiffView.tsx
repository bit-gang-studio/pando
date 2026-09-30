import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffLine, FileDiff, Hunk } from "../lib/api";
import { highlightLines, langFor, type Tok } from "../lib/highlight";
import { Loading } from "../ui/State";

type Props = {
  diff: FileDiff | null;
  loading: boolean;
  mode: "unified" | "split";
  onMode: (m: "unified" | "split") => void;
  onHunk: (hunk: Hunk, reverse: boolean) => void;
  /// Stage (or unstage) only the picked lines of a hunk; indexes into hunk.lines.
  onLines?: (hunk: Hunk, lines: number[], reverse: boolean) => void;
  readOnly?: boolean;
};

/// Above this, skip syntax highlighting: it would block the window for seconds.
const HIGHLIGHT_MAX = 5000;
/// Fixed row heights, so only the rows in view need to exist.
const LINE_H = 20;
const BAR_H = 30;

type Row = { hunk: Hunk; hi: number; li: number; line: DiffLine; toks: Tok[] };
type Side = { line: DiffLine; toks: Tok[] };
type Pair = { left?: Side; right?: Side; hunk: Hunk; hi: number };
/// One thing drawn in the list: a hunk header or a line (or a pair of lines in split mode).
type Item<T> = { kind: "bar"; hunk: Hunk; hi: number } | { kind: "row"; row: T };
/// Picked lines, as "hunkIndex:lineIndex".
type Picks = Set<string>;

export function DiffView({ diff, loading, mode, onMode, onHunk, onLines, readOnly }: Props) {
  const [tokens, setTokens] = useState<{ old: Tok[][]; new: Tok[][] } | null>(null);
  const [picks, setPicks] = useState<Picks>(new Set());
  const anchor = useRef<{ hi: number; li: number } | null>(null);
  useEffect(() => { setPicks(new Set()); anchor.current = null; }, [diff]);

  const sides = useMemo(() => {
    if (!diff) return null;
    const oldL: string[] = [], newL: string[] = [];
    for (const h of diff.hunks) for (const l of h.lines) {
      if (l.kind !== "add") oldL.push(l.text);
      if (l.kind !== "del") newL.push(l.text);
    }
    return { oldL, newL };
  }, [diff]);

  useEffect(() => {
    setTokens(null);
    if (!diff || !sides || sides.oldL.length + sides.newL.length > HIGHLIGHT_MAX * 2) return;
    const lang = langFor(diff.path);
    let live = true;
    Promise.all([highlightLines(sides.oldL, lang), highlightLines(sides.newL, lang)]).then(([o, n]) => { if (live) setTokens({ old: o, new: n }); });
    return () => { live = false; };
  }, [diff, sides]);

  const rows = useMemo(() => {
    if (!diff) return [];
    // Map each line to its token row by side index.
    let oi = 0, ni = 0;
    const out: Row[] = [];
    for (const [hi, h] of diff.hunks.entries()) {
      for (const [li, l] of h.lines.entries()) {
        const toks = (l.kind === "del" ? tokens?.old[oi] : tokens?.new[ni]) ?? [{ content: l.text }];
        if (l.kind !== "add") oi++;
        if (l.kind !== "del") ni++;
        out.push({ hunk: h, hi, li, line: l, toks });
      }
    }
    return out;
  }, [diff, tokens]);

  if (loading && !diff) return <Loading />;
  if (!diff) return <Empty>Select a file to see its changes.</Empty>;
  if (diff.binary) return <Empty>Binary file.</Empty>;
  if (diff.hunks.length === 0) return <Empty>No changes.</Empty>;

  const hunkAction = readOnly ? undefined : onHunk;
  // Line picking: unified view, a file git already tracks, and somewhere to send it.
  const canPick = !readOnly && !!onLines && !diff.new_file && mode === "unified";
  const pick = (r: Row, shift: boolean) => {
    if (r.line.kind === "context") return;
    setPicks((prev) => {
      const next = new Set(prev);
      const a = anchor.current;
      if (shift && a && a.hi === r.hi) {
        const [lo, hi] = a.li < r.li ? [a.li, r.li] : [r.li, a.li];
        for (let i = lo; i <= hi; i++) if (r.hunk.lines[i].kind !== "context") next.add(`${r.hi}:${i}`);
      } else {
        const k = `${r.hi}:${r.li}`;
        if (next.has(k)) next.delete(k); else next.add(k);
        anchor.current = { hi: r.hi, li: r.li };
      }
      return next;
    });
  };
  const pickedIn = (hi: number) => [...picks].filter((k) => k.startsWith(`${hi}:`)).map((k) => Number(k.split(":")[1])).sort((a, b) => a - b);
  const bar = { pickedIn, clear: (hi: number) => setPicks((p) => new Set([...p].filter((k) => !k.startsWith(`${hi}:`)))), stage: (h: Hunk, hi: number) => onLines?.(h, pickedIn(hi), diff.staged) };
  return (
    <div className="flex min-h-0 min-w-0 grow flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-stone-300 px-4 dark:border-stone-700">
        <span className="min-w-0 truncate font-mono text-body font-medium" title={diff.path}>{diff.path}</span>
        <span className="shrink-0 whitespace-nowrap font-mono text-label text-stone-500">+{diff.added} −{diff.deleted} · {diff.hunks.length} {diff.hunks.length === 1 ? "hunk" : "hunks"}</span>
        <div className="grow" />
        <div className="flex overflow-hidden rounded-md border border-stone-300 dark:border-stone-600">
          {(["unified", "split"] as const).map((m) => (
            <button key={m} onClick={() => onMode(m)} className={`h-6.5 px-2.5 text-body capitalize ${mode === m ? "bg-stone-200 dark:bg-stone-600" : "bg-white dark:bg-stone-700"}`}>{m}</button>
          ))}
        </div>
      </div>
      {mode === "unified"
        ? <Windowed key={diff.path} items={withBars(rows)} render={(r) => <UnifiedRow r={r} picked={picks.has(`${r.hi}:${r.li}`)} onPick={canPick ? pick : undefined} />} diff={diff} onHunk={hunkAction} lines={canPick ? bar : undefined} />
        : <Windowed key={diff.path} items={withBars(pairUp(rows))} render={(p) => <SplitRow p={p} />} diff={diff} onHunk={hunkAction} />}
    </div>
  );
}

/// Put a hunk header before the first row of each hunk.
function withBars<T extends { hi: number; hunk: Hunk }>(rows: T[]): Item<T>[] {
  const out: Item<T>[] = [];
  let last = -1;
  for (const r of rows) {
    if (r.hi !== last) { out.push({ kind: "bar", hunk: r.hunk, hi: r.hi }); last = r.hi; }
    out.push({ kind: "row", row: r });
  }
  return out;
}

/// Draw only the items in view. Everything above and below is empty space of the right height.
type LineActions = { pickedIn: (hi: number) => number[]; clear: (hi: number) => void; stage: (h: Hunk, hi: number) => void };

function Windowed<T>({ items, render, diff, onHunk, lines }: { items: Item<T>[]; render: (row: T) => React.ReactNode; diff: FileDiff; onHunk?: (h: Hunk, r: boolean) => void; lines?: LineActions }) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 800 });
  const offsets = useMemo(() => {
    const o = new Array<number>(items.length + 1);
    o[0] = 0;
    for (let i = 0; i < items.length; i++) o[i + 1] = o[i] + (items[i].kind === "bar" ? BAR_H : LINE_H);
    return o;
  }, [items]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setView({ top: el.scrollTop, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // First item whose bottom is below `y`.
  const find = (y: number) => {
    let lo = 0, hi = items.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (offsets[m + 1] <= y) lo = m + 1; else hi = m; }
    return lo;
  };
  const margin = 600;
  const start = find(Math.max(0, view.top - margin));
  const end = Math.min(items.length, find(view.top + view.height + margin) + 1);
  return (
    <div ref={ref} onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })} className="selectable min-h-0 grow overflow-auto font-mono text-body leading-5">
      <div style={{ paddingTop: offsets[start], paddingBottom: offsets[items.length] - offsets[end] }}>
        {items.slice(start, end).map((it, k) => (
          <div key={start + k}>{it.kind === "bar" ? <HunkBar hunk={it.hunk} hi={it.hi} diff={diff} onHunk={onHunk} lines={lines} /> : render(it.row)}</div>
        ))}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex grow items-center justify-center text-body text-stone-500">{children}</div>;
}

function HunkBar({ hunk, hi, diff, onHunk, lines }: { hunk: Hunk; hi: number; diff: FileDiff; onHunk?: (h: Hunk, r: boolean) => void; lines?: LineActions }) {
  const n = lines?.pickedIn(hi).length ?? 0;
  const small = "h-5.5 rounded border border-stone-300 bg-white px-2 font-sans text-label dark:border-stone-600 dark:bg-stone-700";
  return (
    <div style={{ height: BAR_H }} className="box-border flex items-center gap-3 overflow-hidden border-y border-stone-200 bg-stone-100 px-4 text-stone-500 dark:border-stone-700 dark:bg-stone-800">
      <span className="truncate">{hunk.header}</span>
      <div className="grow" />
      {lines && n === 0 && <span className="shrink-0 font-sans text-label text-stone-400">Click line numbers to pick lines</span>}
      {lines && n > 0 && (
        <>
          <button onClick={() => lines.clear(hi)} className="h-5.5 shrink-0 px-1 font-sans text-label text-stone-500 hover:text-stone-800 dark:hover:text-stone-200">Clear</button>
          <button onClick={() => lines.stage(hunk, hi)} className={`${small} border-teal-700 text-teal-700`}>
            {diff.staged ? "Unstage" : "Stage"} {n} {n === 1 ? "line" : "lines"}
          </button>
        </>
      )}
      {!diff.new_file && onHunk && n === 0 && (
        <button onClick={() => onHunk(hunk, diff.staged)} className="h-5.5 rounded border border-stone-300 bg-white px-2 font-sans text-label dark:border-stone-600 dark:bg-stone-700">
          {diff.staged ? "Unstage hunk" : "Stage hunk"}
        </button>
      )}
    </div>
  );
}

function Code({ toks }: { toks: Tok[] }) {
  return <span className="whitespace-pre">{toks.map((t, i) => <span key={i} style={t.color ? { color: t.color } : undefined}>{t.content}</span>)}</span>;
}

const bg = { add: "bg-teal-50 dark:bg-teal-900/30", del: "bg-red-50 dark:bg-red-900/30", context: "" } as const;
const num = "select-none pr-2 text-right text-stone-400";

function UnifiedRow({ r, picked = false, onPick }: { r: Row; picked?: boolean; onPick?: (r: Row, shift: boolean) => void }) {
  const pickable = !!onPick && r.line.kind !== "context";
  // Both number cells pick the line; only the first is announced as the checkbox.
  const click = pickable ? { onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); onPick!(r, e.shiftKey); }, title: "Click to pick this line; shift-click for a range" } : {};
  const cls = pickable ? `${num} cursor-pointer hover:bg-teal-100 dark:hover:bg-teal-900/50` : num;
  const sign = r.line.kind === "add" ? "added" : "removed";
  return (
    <div style={{ height: LINE_H }} className={`grid grid-cols-[48px_48px_16px_1fr] ${bg[r.line.kind]} ${picked ? "shadow-[inset_4px_0_0_#0f766e] brightness-95 dark:brightness-125" : ""}`}>
      <span {...click} className={cls} {...(pickable ? { role: "checkbox", "aria-checked": picked, "aria-label": `Pick ${sign} line: ${r.line.text.trim().slice(0, 60)}` } : {})}>{r.line.old_no ?? ""}</span>
      <span {...click} className={cls} aria-hidden={pickable || undefined}>{r.line.new_no ?? ""}</span>
      <span className="select-none text-center text-stone-400">{r.line.kind === "add" ? "+" : r.line.kind === "del" ? "−" : ""}</span>
      <span className="pr-4"><Code toks={r.toks} />{r.line.no_newline && <span className="ml-2 text-label text-stone-400">⏎ missing</span>}</span>
    </div>
  );
}

/// Pair dels with the adds that follow them.
function pairUp(rows: Row[]): Pair[] {
  const pairs: Pair[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.line.kind === "context") { pairs.push({ left: r, right: r, hunk: r.hunk, hi: r.hi }); i++; continue; }
    const dels: Row[] = [], adds: Row[] = [];
    while (i < rows.length && rows[i].line.kind === "del" && rows[i].hi === r.hi) dels.push(rows[i++]);
    while (i < rows.length && rows[i].line.kind === "add" && rows[i].hi === r.hi) adds.push(rows[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) pairs.push({ left: dels[k], right: adds[k], hunk: r.hunk, hi: r.hi });
  }
  return pairs;
}

function SplitRow({ p }: { p: Pair }) {
  const cell = (s: Side | undefined, side: "l" | "r") => (
    <div className={`grid min-w-0 grid-cols-[44px_1fr] ${s ? bg[s.line.kind] : "bg-stone-50 dark:bg-stone-800/40"}`}>
      <span className={num}>{s ? (side === "l" ? s.line.old_no : s.line.new_no) ?? "" : ""}</span>
      <span className="overflow-hidden pr-3">{s && <Code toks={s.toks} />}</span>
    </div>
  );
  return (
    <div style={{ height: LINE_H }} className="grid grid-cols-2 divide-x divide-stone-200 dark:divide-stone-700">
      {cell(p.left, "l")}
      {cell(p.right, "r")}
    </div>
  );
}
