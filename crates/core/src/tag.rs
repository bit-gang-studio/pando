use crate::error::{gix_err, Result};
use crate::repo::Repo;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tag {
    pub name: String,
    pub target: String,
}

pub fn list(repo: &Repo) -> Result<Vec<Tag>> {
    let g = repo.open_gix()?;
    let refs = g.references().map_err(gix_err)?;
    let mut out = Vec::new();
    for r in refs.tags().map_err(gix_err)? {
        let r = r.map_err(gix_err)?;
        let name = r.name().shorten().to_string();
        if let Ok(id) = r.into_fully_peeled_id() {
            out.push(Tag {
                name,
                target: id.detach().to_string(),
            });
        }
    }
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}
