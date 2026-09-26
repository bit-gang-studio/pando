import { changed, type Row } from "../lib/api";

export type ViewId = "all" | "attention" | "ready" | "stale";

export const VIEWS: { id: ViewId; label: string }[] = [
  { id: "all", label: "All workspaces" },
  { id: "attention", label: "Needs attention" },
  { id: "ready", label: "Ready to land" },
  { id: "stale", label: "Stale" },
];

const STALE_DAYS = 14;

export function matches(view: ViewId, r: Row): boolean {
  const dirty = changed(r.status) > 0;
  const behind = (r.branch?.behind ?? 0) > 0;
  const ahead = (r.branch?.ahead ?? 0) > 0;
  const broken = !!r.workspace.prunable || (r.status?.conflicts ?? 0) > 0;
  const idleDays = r.last_commit_at ? (Date.now() / 1000 - r.last_commit_at) / 86400 : 0;
  switch (view) {
    case "all":
      return true;
    case "attention":
      return dirty || behind || broken;
    case "ready":
      return !dirty && ahead && r.workspace.kind === "linked";
    case "stale":
      return r.workspace.kind === "linked" && !dirty && idleDays > STALE_DAYS;
  }
}
