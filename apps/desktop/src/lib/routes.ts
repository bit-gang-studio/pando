// Every screen has an address so it can be opened in any window.

export type Route =
  | { kind: "repos" }
  /// `land`: just opened from the Repositories page, so start on the base branch.
  | { kind: "repo"; root: string; land?: boolean }
  | { kind: "worktree"; root: string; path: string }
  | { kind: "commit"; root: string; id: string }
  | { kind: "branch"; root: string; name: string };

export function toHash(r: Route): string {
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
  switch (r.kind) {
    case "repos": return "#/repos";
    case "repo": return `#/repo?${q(r.land ? { root: r.root, land: "1" } : { root: r.root })}`;
    case "worktree": return `#/worktree?${q({ root: r.root, path: r.path })}`;
    case "commit": return `#/commit?${q({ root: r.root, id: r.id })}`;
    case "branch": return `#/branch?${q({ root: r.root, name: r.name })}`;
  }
}

export function fromHash(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#/, "").split("?");
  const p = new URLSearchParams(query);
  const root = p.get("root");
  switch (path) {
    case "/repo": return root ? { kind: "repo", root, ...(p.get("land") ? { land: true } : {}) } : { kind: "repos" };
    case "/worktree": return root && p.get("path") ? { kind: "worktree", root, path: p.get("path")! } : { kind: "repos" };
    case "/branch": return root && p.get("name") ? { kind: "branch", root, name: p.get("name")! } : { kind: "repos" };
    case "/commit": return root && p.get("id") ? { kind: "commit", root, id: p.get("id")! } : { kind: "repos" };
    default: return { kind: "repos" };
  }
}

export function navigate(r: Route) {
  window.location.hash = toHash(r);
}
