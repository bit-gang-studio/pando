//! Branch listing. Reads go through gix; ahead/behind is a rev walk against
//! the merge base with the upstream.

use crate::error::{gix_err, Result};
use crate::repo::Repo;
use crate::workspace;
use gix::remote::Direction;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Branch {
    pub name: String,
    pub tip: String,
    /// Short upstream name like `origin/main`.
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    /// Worktree that has this branch checked out, if any.
    pub checked_out_in: Option<PathBuf>,
}

pub fn list(repo: &Repo) -> Result<Vec<Branch>> {
    let checked_out: HashMap<String, PathBuf> = workspace::list(repo)?
        .into_iter()
        .filter_map(|w| w.branch.map(|b| (b, w.path)))
        .collect();

    let g = repo.open_gix()?;
    let refs = g.references().map_err(gix_err)?;
    let mut out = Vec::new();
    for r in refs.local_branches().map_err(gix_err)? {
        let r = r.map_err(gix_err)?;
        let full = r.name().to_owned();
        let name = full.shorten().to_string();
        let tip = match r.into_fully_peeled_id() {
            Ok(id) => id.detach(),
            Err(_) => continue, // unborn or broken ref
        };

        let mut b = Branch {
            name: name.clone(),
            tip: tip.to_string(),
            upstream: None,
            ahead: None,
            behind: None,
            checked_out_in: checked_out.get(&name).cloned(),
        };

        if let Some(Ok(track)) = g.branch_remote_tracking_ref_name(full.as_ref(), Direction::Fetch)
        {
            let track_name = track.as_bstr().to_string();
            b.upstream = Some(
                track_name
                    .strip_prefix("refs/remotes/")
                    .unwrap_or(&track_name)
                    .to_string(),
            );
            if let Ok(up) = g.find_reference(track.as_ref()) {
                if let Ok(up_id) = up.into_fully_peeled_id() {
                    let up_id = up_id.detach();
                    b.ahead = Some(count_only_in(&g, tip, up_id)?);
                    b.behind = Some(count_only_in(&g, up_id, tip)?);
                }
            }
        }
        out.push(b);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Commits reachable from `from` but not from `hide`.
fn count_only_in(g: &gix::Repository, from: gix::ObjectId, hide: gix::ObjectId) -> Result<u32> {
    let walk = g
        .rev_walk([from])
        .with_hidden([hide])
        .all()
        .map_err(gix_err)?;
    let mut n = 0u32;
    for c in walk {
        c.map_err(gix_err)?;
        n += 1;
    }
    Ok(n)
}
