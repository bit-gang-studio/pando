//! How one branch stands next to the base and the branches around it: where
//! it forked, what it's built on, and what's built on top of it.

use crate::branch::count_only_in;
use crate::cmd::{git_opt, git_raw};
use crate::commit::CommitInfo;
use crate::error::{Error, Result};
use crate::repo::Repo;
use serde::{Deserialize, Serialize};

/// Another branch on the same line of history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    /// A local branch name, or a remote one like `origin/feat/x`.
    pub name: String,
    pub remote: bool,
    /// Below: its commits past the link under it (or past the fork).
    /// Above: its commits past the branch being looked at.
    pub commits: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Relation {
    pub target: String,
    pub base: String,
    /// The last commit the two share: where the branch left the base.
    /// Missing when they share no history.
    pub fork: Option<CommitInfo>,
    /// Commits on the branch that the base doesn't have.
    pub ahead: u32,
    /// Commits on the base since the fork.
    pub behind: u32,
    /// Branches this one is built on, nearest the base first.
    pub below: Vec<Link>,
    /// The branch's own commits, past the top of `below` (or past the fork).
    pub own: u32,
    /// Branches built on top of this one.
    pub above: Vec<Link>,
}

/// Enough to draw; a branch built on more than this is listing noise.
const MAX_LINKS: usize = 30;

fn check(rev: &str) -> Result<()> {
    if rev.is_empty() || rev.starts_with('-') || rev.contains("..") {
        return Err(Error::Msg(format!("{rev} isn't a commit or a branch.")));
    }
    Ok(())
}

/// `target` is a branch or a commit. `base` is what it's compared to.
pub fn load(repo: &Repo, target: &str, base: &str) -> Result<Relation> {
    check(target)?;
    check(base)?;
    let dir = &repo.common_git_dir;
    let id = |rev: &str| {
        git_opt(
            dir,
            ["rev-parse", "--verify", "-q", &format!("{rev}^{{commit}}")],
        )
        .ok_or_else(|| Error::Msg(format!("{rev} isn't a commit or a branch here.")))
    };
    let tip = id(target)?;
    let base_tip = id(base)?;
    let fork_id = git_opt(dir, ["merge-base", &tip, &base_tip]);
    let fork = fork_id.as_deref().and_then(|f| {
        let g = repo.open_gix().ok()?;
        let oid = g.rev_parse_single(f).ok()?.detach();
        crate::commit::info(&g, oid).ok()
    });
    let ahead = count_only_in(repo, &tip, &base_tip)?;
    let behind = count_only_in(repo, &base_tip, &tip)?;

    // Refs as (full name, tip), filtered by git itself.
    let refs = |filter: &[&str]| -> Vec<(String, String)> {
        let mut args = vec!["for-each-ref", "--format=%(refname) %(objectname)"];
        args.extend_from_slice(filter);
        args.extend(["refs/heads", "refs/remotes"]);
        match git_raw(dir, args) {
            Ok((0, out, _)) => out
                .lines()
                .filter_map(|l| l.split_once(' '))
                .filter(|(n, _)| !n.ends_with("/HEAD"))
                .map(|(n, t)| (n.to_string(), t.to_string()))
                .collect(),
            _ => Vec::new(),
        }
    };
    let short = |full: &str| -> (String, bool) {
        match full.strip_prefix("refs/heads/") {
            Some(n) => (n.to_string(), false),
            None => (
                full.strip_prefix("refs/remotes/")
                    .unwrap_or(full)
                    .to_string(),
                true,
            ),
        }
    };
    // A remote branch only earns a place when no local branch stands for it.
    let local_of = |name: &str| name.split_once('/').map(|(_, b)| b.to_string());
    let keep = |found: Vec<(String, String)>| -> Vec<(String, bool, String)> {
        let mut out: Vec<(String, bool, String)> = Vec::new();
        let named: Vec<(String, bool, String)> = found
            .into_iter()
            .map(|(n, t)| {
                let (s, r) = short(&n);
                (s, r, t)
            })
            .filter(|(s, _, t)| s != target && s != base && *t != tip && *t != base_tip)
            .collect();
        let locals: Vec<String> = named.iter().filter(|x| !x.1).map(|x| x.0.clone()).collect();
        for (s, r, t) in named {
            // The base's own name without its remote: "main" for "origin/main".
            let base_local = base.split_once('/').map(|(_, b)| b).unwrap_or(base);
            let shadowed = r
                && local_of(&s).is_some_and(|l| {
                    locals.contains(&l) || l == target || l == base || l == base_local
                });
            // Two names on one commit: the first (local before remote) is enough.
            if shadowed || out.iter().any(|o| o.2 == t) {
                continue;
            }
            out.push((s, r, t));
        }
        out
    };

    // Built on: branches whose tip is in this one's history but not in the base's.
    let merged = format!("--merged={tip}");
    let not_in_base = format!("--no-merged={base_tip}");
    let mut under: Vec<(String, bool, String, u32)> = keep(refs(&[&merged, &not_in_base]))
        .into_iter()
        .filter_map(|(s, r, t)| {
            let past_base = count_only_in(repo, &t, &base_tip).ok()?;
            (past_base > 0).then_some((s, r, t, past_base))
        })
        .collect();
    under.sort_by(|a, b| a.3.cmp(&b.3).then_with(|| a.0.cmp(&b.0)));
    under.truncate(MAX_LINKS);
    let mut below = Vec::new();
    let mut prev = base_tip.clone();
    for (name, remote, t, _) in &under {
        below.push(Link {
            name: name.clone(),
            remote: *remote,
            commits: count_only_in(repo, t, &prev).unwrap_or(0),
        });
        prev = t.clone();
    }
    let own = if under.is_empty() {
        ahead
    } else {
        count_only_in(repo, &tip, &prev).unwrap_or(0)
    };

    // Built on top: branches that have this one's tip in their history.
    let contains = format!("--contains={tip}");
    let mut above: Vec<Link> = keep(refs(&[&contains]))
        .into_iter()
        .filter_map(|(name, remote, t)| {
            let commits = count_only_in(repo, &t, &tip).ok()?;
            (commits > 0).then_some(Link {
                name,
                remote,
                commits,
            })
        })
        .collect();
    above.sort_by(|a, b| a.commits.cmp(&b.commits).then_with(|| a.name.cmp(&b.name)));
    above.truncate(MAX_LINKS);

    Ok(Relation {
        target: target.to_string(),
        base: base.to_string(),
        fork,
        ahead,
        behind,
        below,
        own,
        above,
    })
}
