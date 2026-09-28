import { useCallback, useEffect, useState } from "react";
import { api, type PullRequest } from "./api";

/// The local branch a PR checks out into: its own name, or pr/<n> from a fork.
export const prBranch = (pr: PullRequest) => (pr.from_fork ? `pr/${pr.number}` : pr.head);

/// Open PRs for a repo, via gh. Loads on open and every 5 minutes while the
/// window is in use. `null` means no gh, signed out, or not on GitHub.
export function usePullRequests(root: string) {
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const load = useCallback(() => {
    api.prsList(root).then((r) => setPrs(r?.state === "ok" ? r.prs : null)).catch(() => setPrs(null));
  }, [root]);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.hasFocus()) load(); }, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [load]);
  // Look up a PR by the local branch it would use, or its head branch.
  const byBranch: Record<string, PullRequest> = {};
  for (const pr of prs ?? []) { byBranch[prBranch(pr)] = pr; if (!pr.from_fork) byBranch[`origin/${pr.head}`] = pr; }
  return { prs, byBranch, reload: load };
}
