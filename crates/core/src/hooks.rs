//! Run `.pando.toml` hook commands through the user's shell.

use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookResult {
    pub command: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl HookResult {
    pub fn ok(&self) -> bool {
        self.exit_code == Some(0)
    }
}

/// Run each command in `cwd` with `env` added. Stops after the first failure.
pub fn run(commands: &[String], cwd: &Path, env: &[(String, String)]) -> Result<Vec<HookResult>> {
    let mut results = Vec::new();
    for c in commands {
        let out = shell(c)
            .current_dir(cwd)
            .envs(env.iter().cloned())
            .output()?;
        let r = HookResult {
            command: c.clone(),
            exit_code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        };
        let ok = r.ok();
        results.push(r);
        if !ok {
            break;
        }
    }
    Ok(results)
}

fn shell(command: &str) -> Command {
    #[cfg(windows)]
    {
        let mut c = Command::new("cmd");
        c.args(["/C", command]);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    }
}
