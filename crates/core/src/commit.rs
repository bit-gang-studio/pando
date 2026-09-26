use crate::error::{gix_err, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitInfo {
    pub id: String,
    pub summary: String,
    pub author: String,
    /// Unix seconds.
    pub time: i64,
}

pub(crate) fn info(g: &gix::Repository, id: gix::ObjectId) -> Result<CommitInfo> {
    let c = g.find_commit(id).map_err(gix_err)?;
    let summary = c
        .message()
        .map(|m| m.summary().to_string())
        .unwrap_or_default();
    let author = c.author().map(|a| a.name.to_string()).unwrap_or_default();
    let time = c.time().map_err(gix_err)?.seconds;
    Ok(CommitInfo {
        id: id.to_string(),
        summary,
        author,
        time,
    })
}

/// Commit the index. Returns the new commit id.
pub fn create(worktree: &std::path::Path, message: &str, amend: bool) -> Result<String> {
    let mut args = vec!["commit", "-q", "-m", message];
    if amend {
        args.push("--amend");
    }
    crate::cmd::git(worktree, &args)?;
    Ok(crate::cmd::git(worktree, ["rev-parse", "HEAD"])?
        .trim()
        .to_string())
}

pub(crate) fn parse_id(hex: &str) -> Result<gix::ObjectId> {
    gix::ObjectId::from_hex(hex.as_bytes()).map_err(gix_err)
}
