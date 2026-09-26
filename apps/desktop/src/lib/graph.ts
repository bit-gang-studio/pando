// Lane layout for a commit list, newest first. Same idea as `git log --graph`.

import type { LogEntry } from "./api";

export type Link = { from: number; to: number };
export type GraphRow = {
  lane: number;
  /// Lanes that pass straight through this row (excluding the commit's own lane).
  through: number[];
  /// Lines from this commit down to its parents' lanes in the next row.
  down: Link[];
  /// Lanes from the row above that end at this commit (merges into it).
  into: number[];
  lanes: number;
};

export function layoutGraph(entries: LogEntry[]): GraphRow[] {
  const rows: GraphRow[] = [];
  let active: (string | null)[] = []; // lane -> commit id expected next
  for (const e of entries) {
    // Lanes waiting for this commit.
    const waiting: number[] = [];
    active.forEach((id, i) => { if (id === e.id) waiting.push(i); });
    let lane: number;
    if (waiting.length === 0) {
      lane = active.indexOf(null);
      if (lane === -1) { lane = active.length; active.push(null); }
    } else {
      lane = waiting[0];
    }
    const into = waiting.slice(1);
    for (const i of into) active[i] = null;

    const through: number[] = [];
    active.forEach((id, i) => { if (id !== null && i !== lane) through.push(i); });

    const down: Link[] = [];
    const [first, ...rest] = e.parents;
    if (first) {
      const existing = active.findIndex((id, i) => id === first && i !== lane);
      if (existing !== -1) { down.push({ from: lane, to: existing }); active[lane] = null; }
      else { active[lane] = first; down.push({ from: lane, to: lane }); }
    } else {
      active[lane] = null;
    }
    for (const p of rest) {
      let j = active.indexOf(p);
      if (j === -1) { j = active.indexOf(null); if (j === -1) { j = active.length; active.push(null); } active[j] = p; }
      down.push({ from: lane, to: j });
    }
    while (active.length && active[active.length - 1] === null) active.pop();
    rows.push({ lane, through, down, into, lanes: Math.max(active.length, lane + 1, ...through.map((t) => t + 1), ...down.map((d) => d.to + 1)) });
  }
  return rows;
}

export const LANE_W = 14;
export const ROW_H = 28;
export const COLORS = ["#0E6B63", "#B45309", "#1D4ED8", "#7C3AED", "#BE185D", "#15803D", "#0891B2", "#A16207"];
export const colorFor = (lane: number) => COLORS[lane % COLORS.length];
