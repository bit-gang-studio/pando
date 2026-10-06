use crate::error::Result;
use crate::repo::Repo;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tag {
    pub name: String,
    /// The commit it points at.
    pub target: String,
    /// What the ref itself holds: the tag object for an annotated tag, else
    /// the commit. Restoring this brings an annotated tag back exactly.
    #[serde(default)]
    pub object: String,
    /// Has its own message, author and date (`git tag -a`).
    #[serde(default)]
    pub annotated: bool,
    /// When it was made (unix seconds): the tag's date, or its commit's.
    #[serde(default)]
    pub time: i64,
    /// First line of the tag's message, or of its commit's.
    #[serde(default)]
    pub summary: String,
}

/// Every tag, newest first. One git call, however many there are.
pub fn list(repo: &Repo) -> Result<Vec<Tag>> {
    let out = crate::cmd::git(
        &repo.common_git_dir,
        [
            "for-each-ref",
            "--sort=-creatordate",
            "--sort=-version:refname",
            "--format=%(refname:short)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)%00%(creatordate:unix)%00%(contents:subject)",
            "refs/tags",
        ],
    )?;
    let mut tags: Vec<Tag> = out
        .lines()
        .filter_map(|l| {
            let mut f = l.split('\0');
            let (name, object, peeled, kind) = (f.next()?, f.next()?, f.next()?, f.next()?);
            let peeled_kind = f.next()?;
            let time = f.next()?.parse().unwrap_or(0);
            // A tag can point at a tree or a blob. Those have no commit to show.
            let target = match (kind, peeled_kind) {
                ("commit", _) => object.to_string(),
                ("tag", "commit") => peeled.to_string(),
                // A tag of a tag: git unwraps one level here, so ask for the rest.
                ("tag", "tag") => crate::cmd::git_opt(
                    &repo.common_git_dir,
                    [
                        "rev-parse",
                        "--verify",
                        "-q",
                        &format!("{object}^{{commit}}"),
                    ],
                )?,
                _ => return None,
            };
            Some(Tag {
                name: name.to_string(),
                target,
                object: object.to_string(),
                annotated: kind == "tag",
                time,
                summary: f.next().unwrap_or_default().to_string(),
            })
        })
        .collect();
    // Newest first; the same moment falls back to the higher version name.
    tags.sort_by_key(|t| std::cmp::Reverse(t.time));
    Ok(tags)
}

/// Undo a delete: point the tag at what it held before. Refuses if a tag of
/// that name exists again.
pub fn restore(repo: &Repo, name: &str, object: &str) -> Result<()> {
    crate::branch::check_name(name, "tag")?;
    if object.is_empty() || !object.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(crate::Error::Msg(format!(
            "{object} isn't a commit or tag id."
        )));
    }
    // An all-zero old value means "only if it doesn't exist".
    let none = "0".repeat(object.len());
    crate::cmd::git(
        &repo.common_git_dir,
        ["update-ref", &format!("refs/tags/{name}"), object, &none],
    )
    .map_err(|_| {
        crate::Error::Msg(format!(
            "A tag named {name} exists again. Nothing was restored."
        ))
    })?;
    Ok(())
}

/// Create a tag on `target`. With a message it is an annotated tag.
pub fn create(repo: &Repo, name: &str, target: &str, message: Option<&str>) -> Result<()> {
    crate::branch::check_name(name, "tag")?;
    match message.filter(|m| !m.trim().is_empty()) {
        Some(m) => crate::cmd::git(&repo.root, ["tag", "-a", name, target, "-m", m])?,
        None => crate::cmd::git(&repo.root, ["tag", name, target])?,
    };
    Ok(())
}

pub fn delete(repo: &Repo, name: &str) -> Result<()> {
    crate::cmd::git(&repo.root, ["tag", "-d", name])?;
    Ok(())
}

pub fn push(repo: &Repo, name: &str) -> Result<()> {
    crate::cmd::git(
        &repo.root,
        ["push", "-q", "origin", &format!("refs/tags/{name}")],
    )?;
    Ok(())
}
