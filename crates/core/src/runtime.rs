//! Ports per worktree. Stored in `<git common dir>/pando/ports.json`.

use crate::config::PortConfig;
use crate::error::Result;
use crate::repo::Repo;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn file(repo: &Repo) -> PathBuf {
    repo.common_git_dir.join("pando").join("ports.json")
}

fn load(repo: &Repo) -> Result<BTreeMap<String, u16>> {
    let p = file(repo);
    if !p.exists() {
        return Ok(BTreeMap::new());
    }
    let text = std::fs::read_to_string(p)?;
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

fn save(repo: &Repo, map: &BTreeMap<String, u16>) -> Result<()> {
    let p = file(repo);
    std::fs::create_dir_all(p.parent().unwrap())?;
    std::fs::write(p, serde_json::to_string_pretty(map).unwrap())?;
    Ok(())
}

/// Return the port for `branch`, assigning the lowest free one if needed.
pub fn assign_port(repo: &Repo, branch: &str, cfg: &PortConfig) -> Result<u16> {
    let mut map = load(repo)?;
    if let Some(p) = map.get(branch) {
        return Ok(*p);
    }
    let port = lowest_free(&map, cfg);
    map.insert(branch.to_string(), port);
    save(repo, &map)?;
    Ok(port)
}

/// The port a new branch would get. Does not reserve it.
pub fn next_port(repo: &Repo, cfg: &PortConfig) -> Result<u16> {
    Ok(lowest_free(&load(repo)?, cfg))
}

fn lowest_free(map: &BTreeMap<String, u16>, cfg: &PortConfig) -> u16 {
    let mut port = cfg.start;
    while map.values().any(|p| *p == port) {
        port += 1;
    }
    port
}

pub fn port_for(repo: &Repo, branch: &str) -> Result<Option<u16>> {
    Ok(load(repo)?.get(branch).copied())
}

pub fn release_port(repo: &Repo, branch: &str) -> Result<()> {
    let mut map = load(repo)?;
    if map.remove(branch).is_some() {
        save(repo, &map)?;
    }
    Ok(())
}

/// All assigned ports, by branch.
pub fn ports(repo: &Repo) -> Result<BTreeMap<String, u16>> {
    load(repo)
}
