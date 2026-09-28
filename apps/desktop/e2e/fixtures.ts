// Builders for fake core data. Shapes come from src/lib/api.ts, so a type
// change in the app breaks these at compile time, not silently at runtime.
import type {
  BranchRow, CommitDiff, Detail, FileDiff, Log, LogEntry, Overview, RemoteBranch, Summary, Worktree,
} from "../src/lib/api";

export const ROOT = "/Users/me/code/proj";
export const NOW = Math.floor(Date.now() / 1000);
const repo = { root: ROOT, common_git_dir: `${ROOT}/.git`, default_branch: "main", bare: false };

let n = 0;
/// Fake ids that differ in their first 7 characters, like real ones.
export const sha = () => (((++n) * 2654435761) >>> 0).toString(16).padStart(8, "0") + n.toString(16).padStart(32, "0");

export const clean: Summary = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
export const dirty = (unstaged = 2): Summary => ({ ...clean, unstaged });

export function wt(path: string, branch: string | null, extra: Partial<Worktree> = {}): Worktree {
  return { path, kind: path === ROOT ? "main" : "linked", head: sha(), branch, detached: branch === null, bare: false, locked: null, prunable: null, ...extra };
}

export function row(name: string, opts: { worktree?: Worktree | null; status?: Summary | null; ahead?: number; upstream?: string | null; merged?: boolean; up?: [number, number] } = {}): BranchRow {
  const worktree = opts.worktree === undefined ? null : opts.worktree;
  return {
    branch: {
      name, tip: sha(), upstream: opts.upstream ?? null, ahead: opts.up?.[0] ?? 0, behind: opts.up?.[1] ?? 0, checked_out_in: worktree?.path ?? null,
      last_commit: { id: sha(), summary: `Work on ${name}`, author: "Sam", time: NOW - 3600 },
    },
    worktree,
    is_main_worktree: worktree?.path === ROOT,
    status: worktree ? opts.status ?? clean : null,
    ahead_of_base: opts.ahead ?? 0,
    stale: false,
    merged: opts.merged ?? false,
  };
}

export function remote(name: string): RemoteBranch {
  const short = name.replace(/^origin\//, "");
  return { name, remote: "origin", short, tip: sha(), tracked: false, last_commit: { id: sha(), summary: "remote work", author: "Ana", time: NOW - 7200 } };
}

export function overview(parts: Partial<Overview> = {}): Overview {
  return {
    repo, base: "main",
    branches: [row("main", { worktree: wt(ROOT, "main") })],
    detached: [], remote_only: [], status_loaded: true,
    ...parts,
  };
}

export function log(count: number, refsOnFirst: string[] = ["main"]): Log {
  const entries: LogEntry[] = [];
  const ids = Array.from({ length: count }, sha);
  for (let i = 0; i < count; i++) {
    entries.push({ id: ids[i], parents: i + 1 < count ? [ids[i + 1]] : [], author: "Sam", time: NOW - i * 60, summary: `Commit number ${i}`, refs: i === 0 ? refsOnFirst : [], is_head: i === 0 });
  }
  return { entries, truncated: false };
}

export function commitDiff(files: string[] = ["src/app.ts"]): CommitDiff {
  return { commit: { id: sha(), summary: "Commit number 0", author: "Sam", time: NOW }, message: "Commit number 0\n\nBody.", files: files.map((path) => ({ path, added: 3, deleted: 1 })) };
}

export function fileDiff(path: string, lines: number): FileDiff {
  const out = [];
  for (let i = 1; i <= lines; i++) {
    const kind = i % 7 === 0 ? "del" : i % 7 === 1 ? "add" : "context";
    out.push({ kind, old_no: kind === "add" ? null : i, new_no: kind === "del" ? null : i, text: `line ${i} of ${path}`, no_newline: false } as const);
  }
  return { path, staged: false, binary: false, new_file: false, added: 0, deleted: 0, hunks: [{ header: `@@ -1,${lines} +1,${lines} @@`, old_start: 1, old_count: lines, new_start: 1, new_count: lines, lines: out }] };
}

export function detail(path: string, branch: string, files: Detail["files"] = []): Detail {
  return { repo, worktree: wt(path, branch), branch: row(branch).branch, files, ahead: [], base_branch: "main", head_summary: "last", operation: null };
}

/// A typical repo: main, two worktrees (one dirty), two plain branches, a stash, a remote branch.
export function typical() {
  return {
    repos_list: { repos: [ROOT] },
    overview_load: overview({
      branches: [
        row("main", { worktree: wt(ROOT, "main"), upstream: "origin/main" }),
        row("feat/login", { worktree: wt(`${ROOT}-feat-login`, "feat/login"), status: dirty(3), ahead: 2 }),
        row("fix/typo", { worktree: wt(`${ROOT}-fix-typo`, "fix/typo"), ahead: 1 }),
        row("spike/old", { ahead: 4 }),
        row("docs/readme"),
      ],
      remote_only: [remote("origin/feat/remote-only")],
    }),
    log_list: log(30),
    stash_list: [{ index: 0, message: "On main: half done", branch: "main", time: NOW - 100 }],
    commit_diff: commitDiff(),
    commit_file_diff: fileDiff("src/app.ts", 12),
    detail_load: detail(`${ROOT}-feat-login`, "feat/login", [{ path: "a.ts", orig_path: null, staged: null, unstaged: "M", untracked: false, conflicted: false }]),
    diff_file: fileDiff("a.ts", 5),
    watch_repo: null,
    backups_list: [],
    access_check: [],
  };
}

export const repoUrl = (root = ROOT) => `/#/repo?root=${encodeURIComponent(root)}`;
