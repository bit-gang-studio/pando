//! Pull requests, through GitHub's `gh` CLI when it's installed and signed in.
//! Pando stores no tokens. Without `gh`, everything else works as before.

use crate::cmd::{gh, gh_path, git, git_opt};
use crate::error::Result;
use crate::repo::Repo;
use crate::worktree::{self, CreateWorktree, Created};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Checks {
    Passing,
    Failing,
    Pending,
    /// No checks run on it.
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub draft: bool,
    /// The PR's branch on its own repo.
    pub head: String,
    /// The branch lives on someone's fork.
    pub from_fork: bool,
    pub url: String,
    pub checks: Checks,
    /// "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", or empty.
    pub review: String,
    pub updated_at: String,
}

/// Why there's no list, so the app can stay quiet or say what to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PullRequests {
    Ok {
        prs: Vec<PullRequest>,
    },
    /// `gh` isn't installed.
    NoGh,
    /// `gh` is installed but not signed in.
    SignedOut,
    /// The repo isn't on GitHub, or `gh` can't see it.
    NotGitHub,
}

/// Open pull requests for this repo, newest activity first.
pub fn list(repo: &Repo) -> Result<PullRequests> {
    let Some(bin) = gh_path() else {
        return Ok(PullRequests::NoGh);
    };
    let (code, out, err) = gh(
        &bin,
        &repo.root,
        [
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "number,title,author,isDraft,headRefName,isCrossRepository,url,statusCheckRollup,reviewDecision,updatedAt",
        ],
    )?;
    if code != 0 {
        let e = err.to_lowercase();
        if e.contains("auth login") || e.contains("not logged") || e.contains("authentication") {
            return Ok(PullRequests::SignedOut);
        }
        return Ok(PullRequests::NotGitHub);
    }
    Ok(PullRequests::Ok { prs: parse(&out) })
}

/// Parse `gh pr list --json ...` output. Missing or odd fields never fail.
pub fn parse(json: &str) -> Vec<PullRequest> {
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(json)
    else {
        return vec![];
    };
    let s = |v: &serde_json::Value, k: &str| {
        v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
    };
    let mut prs: Vec<PullRequest> = items
        .iter()
        .filter_map(|v| {
            Some(PullRequest {
                number: v.get("number")?.as_u64()?,
                title: s(v, "title"),
                // A deleted account shows as null: GitHub calls it "ghost".
                author: v
                    .get("author")
                    .and_then(|a| a.get("login"))
                    .and_then(|l| l.as_str())
                    .map(|l| l.trim_start_matches("app/").to_string())
                    .unwrap_or_else(|| "ghost".into()),
                draft: v.get("isDraft").and_then(|d| d.as_bool()).unwrap_or(false),
                head: s(v, "headRefName"),
                from_fork: v
                    .get("isCrossRepository")
                    .and_then(|d| d.as_bool())
                    .unwrap_or(false),
                url: s(v, "url"),
                checks: checks(v.get("statusCheckRollup")),
                review: s(v, "reviewDecision"),
                updated_at: s(v, "updatedAt"),
            })
        })
        .collect();
    prs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    prs
}

/// One answer for many checks: any failure fails, anything unfinished is pending.
fn checks(rollup: Option<&serde_json::Value>) -> Checks {
    let Some(serde_json::Value::Array(items)) = rollup else {
        return Checks::None;
    };
    if items.is_empty() {
        return Checks::None;
    }
    let mut pending = false;
    for c in items {
        // Check runs have status + conclusion; old-style statuses have state.
        let conclusion = c.get("conclusion").and_then(|x| x.as_str()).unwrap_or("");
        let status = c.get("status").and_then(|x| x.as_str()).unwrap_or("");
        let state = c.get("state").and_then(|x| x.as_str()).unwrap_or("");
        let word = [conclusion, state]
            .into_iter()
            .find(|w| !w.is_empty())
            .unwrap_or("");
        match word {
            "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED"
            | "STARTUP_FAILURE" => return Checks::Failing,
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => {}
            _ => pending = true,
        }
        if !status.is_empty() && status != "COMPLETED" {
            pending = true;
        }
    }
    if pending {
        Checks::Pending
    } else {
        Checks::Passing
    }
}

/// Check out a pull request into its own worktree, next to the repo.
/// A PR from this repo uses its branch name and tracks it; a PR from a fork
/// gets a local `pr/<number>` branch. If the branch already has a worktree,
/// that worktree is returned.
pub fn add_worktree(repo: &Repo, pr: &PullRequest) -> Result<Created> {
    let local = if pr.from_fork {
        format!("pr/{}", pr.number)
    } else {
        pr.head.clone()
    };
    if let Some(w) = worktree::list(repo)?
        .into_iter()
        .find(|w| w.branch.as_deref() == Some(local.as_str()))
    {
        return Ok(Created { worktree: w });
    }
    let exists = git_opt(
        &repo.root,
        [
            "rev-parse",
            "--verify",
            "-q",
            &format!("refs/heads/{local}"),
        ],
    )
    .is_some();
    if pr.from_fork {
        // GitHub keeps every PR at refs/pull/<n>/head on the base repo.
        git(
            &repo.root,
            [
                "fetch",
                "-q",
                "origin",
                &format!("+refs/pull/{}/head:refs/heads/{local}", pr.number),
            ],
        )?;
    } else {
        git(&repo.root, ["fetch", "-q", "origin", &pr.head])?;
        if !exists {
            crate::branch::track_remote(repo, &format!("origin/{}", pr.head), &local)?;
        }
    }
    worktree::create(
        repo,
        &CreateWorktree {
            branch: local,
            base: None,
            path: None,
            existing_branch: true,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_add_up() {
        let c = |j: &str| checks(Some(&serde_json::from_str(j).unwrap()));
        assert_eq!(checks(None), Checks::None);
        assert_eq!(c("[]"), Checks::None);
        assert_eq!(
            c(r#"[{"status":"COMPLETED","conclusion":"SUCCESS"},{"state":"SUCCESS"}]"#),
            Checks::Passing
        );
        assert_eq!(
            c(
                r#"[{"status":"COMPLETED","conclusion":"SKIPPED"},{"status":"COMPLETED","conclusion":"NEUTRAL"}]"#
            ),
            Checks::Passing
        );
        assert_eq!(
            c(
                r#"[{"status":"IN_PROGRESS","conclusion":""},{"status":"COMPLETED","conclusion":"SUCCESS"}]"#
            ),
            Checks::Pending
        );
        assert_eq!(c(r#"[{"state":"PENDING"}]"#), Checks::Pending);
        // A failure wins even while others are still running.
        assert_eq!(
            c(r#"[{"status":"QUEUED"},{"status":"COMPLETED","conclusion":"FAILURE"}]"#),
            Checks::Failing
        );
        assert_eq!(c(r#"[{"state":"ERROR"}]"#), Checks::Failing);
        assert_eq!(
            c(r#"[{"status":"COMPLETED","conclusion":"TIMED_OUT"}]"#),
            Checks::Failing
        );
        assert_eq!(
            c(r#"[{}]"#),
            Checks::Pending,
            "unknown shape isn't called passing"
        );
    }

    #[test]
    fn parse_tolerates_odd_input() {
        assert!(parse("").is_empty());
        assert!(parse("not json").is_empty());
        assert!(parse("{}").is_empty());
        let prs = parse(
            r#"[
          {"number": 2, "title": "<b>x</b> & \"quotes\"", "author": null, "isDraft": true,
           "headRefName": "feat/ü", "isCrossRepository": true, "url": "u", "updatedAt": "2026-09-02"},
          {"number": 1, "author": {"login": "app/renovate"}, "updatedAt": "2026-09-01"},
          {"title": "no number is skipped"}
        ]"#,
        );
        assert_eq!(prs.len(), 2);
        assert_eq!(prs[0].number, 2, "newest first");
        assert_eq!(prs[0].author, "ghost");
        assert!(prs[0].draft && prs[0].from_fork);
        assert_eq!(prs[1].author, "renovate");
        assert_eq!(prs[1].checks, Checks::None);
    }
}
