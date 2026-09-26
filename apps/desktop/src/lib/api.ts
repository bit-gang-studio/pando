import { invoke } from "@tauri-apps/api/core";

export type WorkspaceKind = "main" | "linked";

export type Workspace = {
  path: string;
  kind: WorkspaceKind;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: string | null;
  prunable: string | null;
};

export type Branch = {
  name: string;
  tip: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  checked_out_in: string | null;
};

export type Summary = {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
};

export type Row = {
  workspace: Workspace;
  branch: Branch | null;
  port: number | null;
  status: Summary | null;
  last_commit_at: number | null;
};

export type Repo = {
  root: string;
  common_git_dir: string;
  default_branch: string | null;
  bare: boolean;
};

export type Board = {
  repo: Repo;
  rows: Row[];
  ports: Record<string, number>;
};

export type UserConfig = { repos: string[]; editor: string | null };

export type RepoConfig = {
  workspace: { location: string; base: string | null };
  hooks: { post_create: string[]; pre_land: string[]; post_land: string[] };
  runtime: { port: { env: string; start: number } | null; share: string[] };
  land: { strategy: string; delete_branch: boolean; remove_worktree: boolean };
  agents: Record<string, { command: string }>;
};

export type CreateDefaults = {
  config: RepoConfig;
  default_branch: string | null;
  next_port: number | null;
  branches: Branch[];
};

export type CreateWorkspace = {
  branch: string;
  base: string | null;
  path: string | null;
  existing_branch: boolean;
  run_hooks: boolean;
};

export type HookResult = { command: string; exit_code: number | null; stdout: string; stderr: string };

export type Created = { workspace: Workspace; port: number | null; hooks: HookResult[] };

export const api = {
  version: () => invoke<string>("version"),
  reposList: () => invoke<UserConfig>("repos_list"),
  reposAdd: (path: string) => invoke<UserConfig>("repos_add", { path }),
  reposRemove: (path: string) => invoke<UserConfig>("repos_remove", { path }),
  boardLoad: (root: string) => invoke<Board>("board_load", { root }),
  branchesList: (root: string) => invoke<Branch[]>("branches_list", { root }),
  createDefaults: (root: string) => invoke<CreateDefaults>("create_defaults", { root }),
  workspacePathPreview: (root: string, branch: string) =>
    invoke<string>("workspace_path_preview", { root, branch }),
  workspaceCreate: (root: string, req: CreateWorkspace) =>
    invoke<Created>("workspace_create", { root, req }),
  workspaceRemove: (root: string, path: string, force: boolean) =>
    invoke<void>("workspace_remove", { root, path, force }),
  openInEditor: (path: string) => invoke<void>("open_in_editor", { path }),
};

export function changed(s: Summary | null): number {
  return s ? s.staged + s.unstaged + s.untracked + s.conflicts : 0;
}

export function repoName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

export function ago(unix: number | null): string {
  if (!unix) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
