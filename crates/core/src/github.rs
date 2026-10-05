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
    /// The branch it wants to merge into, e.g. "main" or the branch it's stacked on.
    #[serde(default)]
    pub base: String,
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
            "number,title,author,isDraft,headRefName,baseRefName,isCrossRepository,url,statusCheckRollup,reviewDecision,updatedAt",
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
                base: s(v, "baseRefName"),
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

/// A repo you can clone: yours, or one of your organisations'.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteRepo {
    /// "owner/name"
    pub name: String,
    pub description: String,
    pub private: bool,
    pub url: String,
    pub updated_at: String,
}

/// Your repos and your organisations' repos, newest activity first.
/// `None` without gh or when signed out; paste a URL instead.
pub fn repos() -> Result<Option<Vec<RemoteRepo>>> {
    let Some(bin) = gh_path() else {
        return Ok(None);
    };
    let here = std::env::temp_dir();
    let (code, orgs, _) = gh(&bin, &here, ["api", "user/orgs", "--jq", ".[].login"])?;
    if code != 0 {
        return Ok(None);
    }
    let owners: Vec<String> = std::iter::once(String::new())
        .chain(
            orgs.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string),
        )
        .collect();
    let mut all = Vec::new();
    for owner in owners {
        let mut args = vec!["repo", "list"];
        if !owner.is_empty() {
            args.push(&owner);
        }
        args.extend([
            "--limit",
            "1000",
            "--json",
            "nameWithOwner,description,isPrivate,updatedAt,url",
        ]);
        let (code, out, _) = gh(&bin, &here, &args)?;
        if code == 0 {
            all.extend(parse_repos(&out));
        }
    }
    all.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    all.dedup_by(|a, b| a.name == b.name);
    Ok(Some(all))
}

pub fn parse_repos(json: &str) -> Vec<RemoteRepo> {
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(json)
    else {
        return vec![];
    };
    let s = |v: &serde_json::Value, k: &str| {
        v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
    };
    items
        .iter()
        .filter(|v| v.get("nameWithOwner").and_then(|x| x.as_str()).is_some())
        .map(|v| RemoteRepo {
            name: s(v, "nameWithOwner"),
            description: s(v, "description"),
            private: v
                .get("isPrivate")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
            url: s(v, "url"),
            updated_at: s(v, "updatedAt"),
        })
        .collect()
}

/// The folder name a clone gets: "owner/repo", any https or ssh URL, with
/// or without ".git" or a trailing slash, all give "repo".
pub fn clone_folder_name(source: &str) -> Option<String> {
    let s = source.trim().trim_end_matches(['/', '\\']);
    let s = s.strip_suffix(".git").unwrap_or(s);
    // Also split on \\ so a pasted Windows folder path works.
    let last = s.rsplit(['/', ':', '\\']).next()?;
    let ok = !last.is_empty() && last != "." && last != ".." && !last.contains(['\\', '\0']);
    ok.then(|| last.to_string())
}

/// Clone `source` ("owner/repo" or any git URL) into `<parent>/<repo>`.
/// Uses gh for "owner/repo" so your GitHub login is used; git otherwise.
/// Refuses if the folder already exists. Returns the new repo's folder.
pub fn clone(source: &str, parent: &std::path::Path) -> Result<std::path::PathBuf> {
    let name = clone_folder_name(source)
        .ok_or_else(|| crate::Error::Msg(format!("Can't tell the repo name from \"{source}\"")))?;
    let dest = parent.join(&name);
    if dest.exists() {
        return Err(crate::Error::Msg(format!(
            "{} already exists. Pick another location.",
            dest.display()
        )));
    }
    if !parent.is_dir() {
        return Err(crate::Error::Msg(format!(
            "{} isn't a folder.",
            parent.display()
        )));
    }
    let dest_s = dest.to_string_lossy().into_owned();
    let is_short =
        !source.contains("://") && !source.contains('@') && source.matches('/').count() == 1;
    let result = match (is_short, gh_path()) {
        (true, Some(bin)) => {
            let (code, _, err) = gh(
                &bin,
                parent,
                ["repo", "clone", source.trim(), &dest_s, "--", "-q"],
            )?;
            if code == 0 {
                Ok(())
            } else {
                Err(crate::Error::Git {
                    cmd: format!("gh repo clone {source}"),
                    stderr: err.trim().to_string(),
                })
            }
        }
        (true, None) => git(
            parent,
            [
                "clone",
                "-q",
                &format!("https://github.com/{}.git", source.trim()),
                &dest_s,
            ],
        )
        .map(|_| ()),
        _ => git(parent, ["clone", "-q", source.trim(), &dest_s]).map(|_| ()),
    };
    if result.is_err() && dest.exists() {
        // A half-finished clone is useless; don't leave it behind.
        let _ = std::fs::remove_dir_all(&dest);
    }
    result.map(|_| dest)
}

#[cfg(test)]
mod clone_tests {
    use super::*;

    #[test]
    fn folder_names_from_every_kind_of_source() {
        for (src, want) in [
            ("bit-gang-studio/pando", Some("pando")),
            ("https://github.com/bit-gang-studio/pando", Some("pando")),
            (
                "https://github.com/bit-gang-studio/pando.git",
                Some("pando"),
            ),
            ("https://github.com/bit-gang-studio/pando/", Some("pando")),
            ("git@github.com:bit-gang-studio/pando.git", Some("pando")),
            ("ssh://git@host:22/team/my.repo.git", Some("my.repo")),
            ("  owner/name  ", Some("name")),
            ("", None),
            ("/", None),
            ("owner/..", None),
            (r"C:\repos\shop.git", Some("shop")),
            (r"C:\repos\shop\", Some("shop")),
        ] {
            assert_eq!(clone_folder_name(src).as_deref(), want, "{src:?}");
        }
    }

    #[test]
    fn repo_list_parsing_skips_junk() {
        assert!(parse_repos("nope").is_empty());
        let r =
            parse_repos(r#"[{"nameWithOwner":"a/b","isPrivate":true},{"description":"no name"}]"#);
        assert_eq!(r.len(), 1);
        assert!(r[0].private);
    }
}

// ---- creating a pull request -------------------------------------------------

/// What to start a new pull request's form with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrDraft {
    pub title: String,
    pub body: String,
    /// Commits the pull request would hold. 0 means there's nothing to open.
    pub commits: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewPullRequest {
    pub branch: String,
    /// The branch to merge into, e.g. "main" ("origin/main" is fine too).
    pub base: String,
    pub title: String,
    pub body: String,
    pub draft: bool,
}

fn msg<T>(m: impl Into<String>) -> Result<T> {
    Err(crate::Error::Msg(m.into()))
}

fn base_name(base: &str) -> &str {
    base.strip_prefix("origin/").unwrap_or(base)
}

/// "feat/add-login_page" -> "Add login page".
fn title_from_branch(branch: &str) -> String {
    let last = branch.rsplit('/').next().unwrap_or(branch);
    let words = last.replace(['-', '_'], " ");
    let words = words.trim();
    let mut c = words.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => branch.to_string(),
    }
}

/// Title and description to start from: the one commit's message, or for
/// several, the branch name and a list of their summaries (oldest first).
pub fn pr_draft(repo: &Repo, branch: &str, base: &str) -> Result<PrDraft> {
    let dir = &repo.common_git_dir;
    let head = format!("refs/heads/{branch}");
    if git_opt(dir, ["rev-parse", "--verify", "-q", &head]).is_none() {
        return msg(format!("No branch named {branch}."));
    }
    let base = base_name(base);
    // The remote's copy of the base is what GitHub compares against.
    let against = [
        format!("refs/remotes/origin/{base}"),
        format!("refs/heads/{base}"),
    ]
    .into_iter()
    .find(|r| git_opt(dir, ["rev-parse", "--verify", "-q", r]).is_some());
    let Some(against) = against else {
        return msg(format!(
            "No branch named {base} to open a pull request into."
        ));
    };
    let ids = git(
        dir,
        [
            "rev-list",
            "--reverse",
            "--no-merges",
            &head,
            &format!("^{against}"),
            "--",
        ],
    )?;
    let ids: Vec<&str> = ids.lines().collect();
    let message = |id: &str| -> Result<String> {
        Ok(git(dir, ["log", "-1", "--format=%B", id])?
            .trim()
            .to_string())
    };
    let (title, body) = match ids.as_slice() {
        [] => (title_from_branch(branch), String::new()),
        [one] => {
            let m = message(one)?;
            let (first, rest) = m.split_once('\n').unwrap_or((&m, ""));
            (first.trim().to_string(), rest.trim().to_string())
        }
        many => {
            let mut body = String::new();
            for id in many.iter().take(50) {
                let m = message(id)?;
                body.push_str(&format!("- {}\n", m.lines().next().unwrap_or_default()));
            }
            if many.len() > 50 {
                body.push_str(&format!("- and {} more\n", many.len() - 50));
            }
            (title_from_branch(branch), body.trim_end().to_string())
        }
    };
    Ok(PrDraft {
        title,
        body,
        commits: ids.len() as u32,
    })
}

/// Open a pull request with `gh`. Pushes the branch first if it has commits
/// that aren't on its upstream yet. Returns the pull request's URL.
pub fn create_pr(repo: &Repo, req: &NewPullRequest) -> Result<String> {
    let Some(bin) = gh_path() else {
        return msg("Creating a pull request needs GitHub's gh tool. Install it from cli.github.com, run gh auth login, then try again.");
    };
    create_pr_with(&bin, repo, req)
}

/// `create_pr` with a given `gh` binary.
pub fn create_pr_with(bin: &std::path::Path, repo: &Repo, req: &NewPullRequest) -> Result<String> {
    let dir = &repo.common_git_dir;
    let branch = req.branch.as_str();
    let title = req.title.trim();
    if title.is_empty() {
        return msg("A pull request needs a title.");
    }
    let Some(tip) = git_opt(
        dir,
        [
            "rev-parse",
            "--verify",
            "-q",
            &format!("refs/heads/{branch}"),
        ],
    ) else {
        return msg(format!("No branch named {branch}."));
    };
    let base = base_name(&req.base);
    if base.is_empty() || base.starts_with('-') {
        return msg(format!("{base} isn't a branch name."));
    }
    // What the branch is called on GitHub: its upstream's name, else its own.
    let theirs = git_opt(dir, ["config", &format!("branch.{branch}.merge")])
        .map(|m| m.strip_prefix("refs/heads/").unwrap_or(&m).to_string())
        .unwrap_or_else(|| branch.to_string());
    if theirs == base {
        return msg(format!(
            "{branch} can't be merged into itself. Pick another base."
        ));
    }
    let pushed = git_opt(
        dir,
        [
            "rev-parse",
            "--verify",
            "-q",
            &format!("refs/remotes/origin/{theirs}"),
        ],
    );
    if pushed.as_deref() != Some(tip.as_str()) {
        crate::branch::push(repo, branch, "origin", false)?;
    }
    let mut args = vec![
        "pr".to_string(),
        "create".into(),
        format!("--head={theirs}"),
        format!("--base={base}"),
        format!("--title={title}"),
        format!("--body={}", req.body.trim()),
    ];
    if req.draft {
        args.push("--draft".into());
    }
    let (code, out, err) = gh(bin, &repo.root, &args)?;
    if code != 0 {
        let e = err.to_lowercase();
        return msg(if e.contains("already exists") {
            format!("{branch} already has a pull request.")
        } else if e.contains("auth login")
            || e.contains("not logged")
            || e.contains("authentication")
        {
            "GitHub's gh tool isn't signed in. Run gh auth login in a terminal, then try again."
                .to_string()
        } else if e.contains("no commits between") {
            format!("{base} already has everything on {branch}. There's nothing to open a pull request for.")
        } else {
            let line = err
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("gh pr create failed");
            format!("GitHub didn't create the pull request: {line}")
        });
    }
    // gh prints the new pull request's URL, last.
    Ok(out
        .lines()
        .map(str::trim)
        .rfind(|l| l.starts_with("http"))
        .unwrap_or_default()
        .to_string())
}
