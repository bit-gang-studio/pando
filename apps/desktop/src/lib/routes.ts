// Every screen has an address so it can be opened in any window.

export type Route =
  | { kind: "repos" }
  | { kind: "repo"; root: string }
  | { kind: "worktree"; root: string; path: string }
  | { kind: "settings"; root: string };

export function toHash(r: Route): string {
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
  switch (r.kind) {
    case "repos": return "#/repos";
    case "repo": return `#/repo?${q({ root: r.root })}`;
    case "worktree": return `#/worktree?${q({ root: r.root, path: r.path })}`;
    case "settings": return `#/settings?${q({ root: r.root })}`;
  }
}

export function fromHash(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#/, "").split("?");
  const p = new URLSearchParams(query);
  const root = p.get("root");
  switch (path) {
    case "/repo": return root ? { kind: "repo", root } : { kind: "repos" };
    case "/worktree": return root && p.get("path") ? { kind: "worktree", root, path: p.get("path")! } : { kind: "repos" };
    case "/settings": return root ? { kind: "settings", root } : { kind: "repos" };
    default: return { kind: "repos" };
  }
}

export function navigate(r: Route) {
  window.location.hash = toHash(r);
}
