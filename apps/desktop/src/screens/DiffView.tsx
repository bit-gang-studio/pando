import { useEffect, useMemo, useState } from "react";
import type { DiffLine, FileDiff, Hunk } from "../lib/api";
import { highlightLines, langFor, type Tok } from "../lib/highlight";

type Props = {
  diff: FileDiff | null;
  loading: boolean;
  mode: "unified" | "split";
  onMode: (m: "unified" | "split") => void;
  onHunk: (hunk: Hunk, reverse: boolean) => void;
  readOnly?: boolean;
};

const MAX_LINES = 4000;

export function DiffView({ diff, loading, mode, onMode, onHunk, readOnly }: Props) {
  const [tokens, setTokens] = useState<{ old: Tok[][]; new: Tok[][] } | null>(null);
  const [showAll, setShowAll] = useState(false);

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
    setShowAll(false);
    if (!diff || !sides) return;
    const lang = langFor(diff.path);
    let live = true;
    Promise.all([highlightLines(sides.oldL, lang), highlightLines(sides.newL, lang)]).then(([o, n]) => { if (live) setTokens({ old: o, new: n }); });
    return () => { live = false; };
  }, [diff, sides]);

  if (loading && !diff) return <Empty>Loading…</Empty>;
  if (!diff) return <Empty>Select a file to see its changes.</Empty>;
  if (diff.binary) return <Empty>Binary file.</Empty>;
  if (diff.hunks.length === 0) return <Empty>No changes.</Empty>;

  const total = diff.hunks.reduce((n, h) => n + h.lines.length, 0);
  const capped = total > MAX_LINES && !showAll;

  // Map each line to its token row by side index.
  let oi = 0, ni = 0;
  const rows: { hunk: Hunk; hi: number; line: DiffLine; toks: Tok[] }[] = [];
  for (const [hi, h] of diff.hunks.entries()) {
    for (const l of h.lines) {
      let toks: Tok[];
      if (l.kind === "del") toks = tokens?.old[oi] ?? [{ content: l.text }];
      else toks = tokens?.new[ni] ?? [{ content: l.text }];
      if (l.kind !== "add") oi++;
      if (l.kind !== "del") ni++;
      rows.push({ hunk: h, hi, line: l, toks });
    }
  }
  const shown = capped ? rows.slice(0, MAX_LINES) : rows;

  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-stone-300 px-4 dark:border-stone-700">
        <span className="font-mono text-xs font-medium">{diff.path}</span>
        <span className="font-mono text-[11px] text-stone-500">+{diff.added} −{diff.deleted} · {diff.hunks.length} {diff.hunks.length === 1 ? "hunk" : "hunks"}</span>
        <div className="grow" />
        <div className="flex overflow-hidden rounded-md border border-stone-300 dark:border-stone-600">
          {(["unified", "split"] as const).map((m) => (
            <button key={m} onClick={() => onMode(m)} className={`h-6.5 px-2.5 text-xs capitalize ${mode === m ? "bg-stone-200 dark:bg-stone-600" : "bg-white dark:bg-stone-700"}`}>{m}</button>
          ))}
        </div>
      </div>
      <div className="selectable min-h-0 grow overflow-auto font-mono text-[12px] leading-5">
        {mode === "unified" ? <Unified rows={shown} diff={diff} onHunk={readOnly ? undefined : onHunk} /> : <Split rows={shown} diff={diff} onHunk={readOnly ? undefined : onHunk} />}
        {capped && (
          <button onClick={() => setShowAll(true)} className="m-3 rounded-md border border-stone-300 bg-white px-3 py-1.5 font-sans text-xs dark:border-stone-600 dark:bg-stone-700">
            Show all {total} lines
          </button>
        )}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex grow items-center justify-center text-xs text-stone-500">{children}</div>;
}

function HunkBar({ hunk, diff, onHunk }: { hunk: Hunk; diff: FileDiff; onHunk?: (h: Hunk, r: boolean) => void }) {
  return (
    <div className="flex items-center gap-3 border-y border-stone-200 bg-stone-100 px-4 py-1 text-stone-500 dark:border-stone-700 dark:bg-stone-800/80">
      <span className="truncate">{hunk.header}</span>
      <div className="grow" />
      {!diff.new_file && onHunk && (
        <button onClick={() => onHunk(hunk, diff.staged)} className="h-5.5 rounded border border-stone-300 bg-white px-2 font-sans text-[11px] dark:border-stone-600 dark:bg-stone-700">
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

function Unified({ rows, diff, onHunk }: { rows: { hunk: Hunk; hi: number; line: DiffLine; toks: Tok[] }[]; diff: FileDiff; onHunk?: (h: Hunk, r: boolean) => void }) {
  let lastHi = -1;
  return (
    <div>
      {rows.map((r, i) => {
        const bar = r.hi !== lastHi;
        lastHi = r.hi;
        return (
          <div key={i}>
            {bar && <HunkBar hunk={r.hunk} diff={diff} onHunk={onHunk} />}
            <div className={`grid grid-cols-[48px_48px_16px_1fr] ${bg[r.line.kind]}`}>
              <span className={num}>{r.line.old_no ?? ""}</span>
              <span className={num}>{r.line.new_no ?? ""}</span>
              <span className="select-none text-center text-stone-400">{r.line.kind === "add" ? "+" : r.line.kind === "del" ? "−" : ""}</span>
              <span className="pr-4"><Code toks={r.toks} />{r.line.no_newline && <span className="ml-2 text-[10px] text-stone-400">⏎ missing</span>}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Split({ rows, diff, onHunk }: { rows: { hunk: Hunk; hi: number; line: DiffLine; toks: Tok[] }[]; diff: FileDiff; onHunk?: (h: Hunk, r: boolean) => void }) {
  // Pair dels with the adds that follow them.
  type Pair = { left?: { line: DiffLine; toks: Tok[] }; right?: { line: DiffLine; toks: Tok[] }; hunk: Hunk; hi: number };
  const pairs: Pair[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.line.kind === "context") { pairs.push({ left: r, right: r, hunk: r.hunk, hi: r.hi }); i++; continue; }
    const dels: typeof rows = [], adds: typeof rows = [];
    while (i < rows.length && rows[i].line.kind === "del" && rows[i].hi === r.hi) dels.push(rows[i++]);
    while (i < rows.length && rows[i].line.kind === "add" && rows[i].hi === r.hi) adds.push(rows[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) pairs.push({ left: dels[k], right: adds[k], hunk: r.hunk, hi: r.hi });
  }
  let lastHi = -1;
  const cell = (s: { line: DiffLine; toks: Tok[] } | undefined, side: "l" | "r") => (
    <div className={`grid min-w-0 grid-cols-[44px_1fr] ${s ? bg[s.line.kind] : "bg-stone-50 dark:bg-stone-800/40"}`}>
      <span className={num}>{s ? (side === "l" ? s.line.old_no : s.line.new_no) ?? "" : ""}</span>
      <span className="overflow-hidden pr-3">{s && <Code toks={s.toks} />}</span>
    </div>
  );
  return (
    <div>
      {pairs.map((p, idx) => {
        const bar = p.hi !== lastHi;
        lastHi = p.hi;
        return (
          <div key={idx}>
            {bar && <HunkBar hunk={p.hunk} diff={diff} onHunk={onHunk} />}
            <div className="grid grid-cols-2 divide-x divide-stone-200 dark:divide-stone-700">
              {cell(p.left, "l")}
              {cell(p.right, "r")}
            </div>
          </div>
        );
      })}
    </div>
  );
}
