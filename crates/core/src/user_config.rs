//! Per-user state in `~/.config/pando/`. `PANDO_CONFIG_DIR` overrides it.

use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UserConfig {
    /// Main worktree roots the app knows about.
    pub repos: Vec<PathBuf>,
    pub editor: Option<String>,
}

pub fn dir() -> PathBuf {
    if let Ok(d) = std::env::var("PANDO_CONFIG_DIR") {
        return PathBuf::from(d);
    }
    std::env::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("pando")
}

fn file() -> PathBuf {
    dir().join("config.json")
}

pub fn load() -> Result<UserConfig> {
    let p = file();
    if !p.exists() {
        return Ok(UserConfig::default());
    }
    Ok(serde_json::from_str(&std::fs::read_to_string(p)?).unwrap_or_default())
}

pub fn save(c: &UserConfig) -> Result<()> {
    std::fs::create_dir_all(dir())?;
    std::fs::write(file(), serde_json::to_string_pretty(c).unwrap())?;
    Ok(())
}

pub fn add_repo(root: &Path) -> Result<UserConfig> {
    let mut c = load()?;
    let root = crate::repo::canon(root);
    if !c.repos.contains(&root) {
        c.repos.push(root);
        save(&c)?;
    }
    Ok(c)
}

pub fn remove_repo(root: &Path) -> Result<UserConfig> {
    let mut c = load()?;
    let root = crate::repo::canon(root);
    c.repos.retain(|r| *r != root);
    save(&c)?;
    Ok(c)
}
