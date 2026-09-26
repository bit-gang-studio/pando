//! `.pando.toml` at the repo root. Committed, shared by the team.

use crate::error::{Error, Result};
use crate::repo::Repo;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const FILE_NAME: &str = ".pando.toml";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RepoConfig {
    pub worktree: WorktreeConfig,
    pub hooks: Hooks,
    pub runtime: RuntimeConfig,
    pub land: LandConfig,
    pub agents: BTreeMap<String, AgentConfig>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorktreeConfig {
    /// Template. `{repo}`, `{branch}`, `{branch_slug}` and a leading `~` expand.
    /// Relative paths are relative to the repo root.
    pub location: String,
    /// Default start point for new branches. Falls back to the repo's default branch.
    pub base: Option<String>,
}

impl Default for WorktreeConfig {
    fn default() -> Self {
        Self {
            location: "~/.pando/worktrees/{repo}/{branch_slug}".into(),
            base: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Hooks {
    pub post_create: Vec<String>,
    pub pre_land: Vec<String>,
    pub post_land: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RuntimeConfig {
    pub port: Option<PortConfig>,
    /// Paths copied from the main worktree into a new one (copy-on-write where possible).
    pub share: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PortConfig {
    pub env: String,
    pub start: u16,
}

impl Default for PortConfig {
    fn default() -> Self {
        Self {
            env: "PORT".into(),
            start: 3000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LandConfig {
    pub strategy: String,
    pub delete_branch: bool,
    pub remove_worktree: bool,
}

impl Default for LandConfig {
    fn default() -> Self {
        Self {
            strategy: "squash".into(),
            delete_branch: true,
            remove_worktree: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AgentConfig {
    pub command: String,
}

impl RepoConfig {
    /// Load `.pando.toml` from the repo root, or defaults if there is none.
    pub fn load(repo: &Repo) -> Result<RepoConfig> {
        let path = repo.root.join(FILE_NAME);
        if !path.exists() {
            return Ok(RepoConfig::default());
        }
        let text = std::fs::read_to_string(&path)?;
        Self::parse(&text)
    }

    pub fn parse(text: &str) -> Result<RepoConfig> {
        toml::from_str(text).map_err(|e| Error::Config(e.to_string()))
    }

    pub fn to_toml(&self) -> Result<String> {
        toml::to_string_pretty(self).map_err(|e| Error::Config(e.to_string()))
    }

    /// Write `.pando.toml` at the repo root. Returns the text written.
    pub fn save(&self, repo: &Repo) -> Result<String> {
        let text = self.to_toml()?;
        std::fs::write(repo.root.join(FILE_NAME), &text)?;
        Ok(text)
    }
}

/// Commit only `.pando.toml` in the main worktree.
pub fn commit(repo: &Repo, message: &str) -> Result<()> {
    crate::cmd::git(&repo.root, ["add", "--", FILE_NAME])?;
    crate::cmd::git(&repo.root, ["commit", "-m", message, "--", FILE_NAME])?;
    Ok(())
}

impl RepoConfig {
    /// Where a new worktree for `branch` goes.
    pub fn worktree_path(&self, repo: &Repo, branch: &str) -> PathBuf {
        let repo_name = repo
            .root
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "repo".into());
        let mut s = self
            .worktree
            .location
            .replace("{repo}", &repo_name)
            .replace("{branch_slug}", &branch_slug(branch))
            .replace("{branch}", branch);
        if let Some(rest) = s.strip_prefix("~/") {
            if let Some(home) = std::env::home_dir() {
                s = home.join(rest).to_string_lossy().into_owned();
            }
        }
        let p = PathBuf::from(s);
        if p.is_absolute() {
            p
        } else {
            repo.root.join(p)
        }
    }
}

/// `feat/Auth Refresh` -> `feat-auth-refresh`
pub fn branch_slug(branch: &str) -> String {
    let mut out = String::with_capacity(branch.len());
    let mut last_dash = false;
    for c in branch.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_empty() {
        let c = RepoConfig::parse("").unwrap();
        assert_eq!(
            c.worktree.location,
            "~/.pando/worktrees/{repo}/{branch_slug}"
        );
        assert!(c.hooks.post_create.is_empty());
        assert_eq!(c.land.strategy, "squash");
    }

    #[test]
    fn parses_full_file() {
        let c = RepoConfig::parse(
            r#"
[worktree]
location = "../{repo}-worktrees/{branch_slug}"
base = "origin/main"
[hooks]
post_create = ["cp $PANDO_MAIN/.env .env", "pnpm install"]
[runtime]
port = { env = "PORT", start = 4000 }
share = ["node_modules"]
[agents.claude]
command = "claude"
"#,
        )
        .unwrap();
        assert_eq!(c.hooks.post_create.len(), 2);
        assert_eq!(c.runtime.port.unwrap().start, 4000);
        assert_eq!(c.agents["claude"].command, "claude");
        assert_eq!(c.worktree.base.as_deref(), Some("origin/main"));
    }

    #[test]
    fn toml_round_trip() {
        let mut c = RepoConfig::default();
        c.hooks.post_create = vec!["pnpm install".into()];
        c.runtime.port = Some(PortConfig {
            env: "PORT".into(),
            start: 4000,
        });
        c.agents.insert(
            "claude".into(),
            AgentConfig {
                command: "claude".into(),
            },
        );
        let text = c.to_toml().unwrap();
        assert_eq!(RepoConfig::parse(&text).unwrap(), c);
        assert!(text.contains("[hooks]"));
    }

    #[test]
    fn slugs() {
        assert_eq!(branch_slug("feat/Auth Refresh"), "feat-auth-refresh");
        assert_eq!(branch_slug("fix/a..b__c"), "fix-a..b__c");
        assert_eq!(branch_slug("/x/"), "x");
    }

    #[test]
    fn relative_location_is_under_root() {
        let repo = Repo {
            root: PathBuf::from("/tmp/pando"),
            common_git_dir: PathBuf::from("/tmp/pando/.git"),
            default_branch: None,
            bare: false,
        };
        let mut c = RepoConfig::default();
        c.worktree.location = "../{repo}-worktrees/{branch_slug}".into();
        assert_eq!(
            c.worktree_path(&repo, "feat/x"),
            PathBuf::from("/tmp/pando/../pando-worktrees/feat-x")
        );
    }
}
