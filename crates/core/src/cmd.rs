//! Run the user's git. Only this module spawns processes.

use crate::error::{Error, Result};
use std::ffi::OsStr;
use std::path::Path;
use std::process::Command;

fn base(cwd: &Path) -> Command {
    let mut c = Command::new("git");
    c.current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");
    c
}

/// Run git and return stdout as a string. Fails on non-zero exit.
pub(crate) fn git<I, S>(cwd: &Path, args: I) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let out = git_bytes(cwd, args)?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Run git and return raw stdout bytes. Use for `-z` output.
pub(crate) fn git_bytes<I, S>(cwd: &Path, args: I) -> Result<Vec<u8>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<_> = args
        .into_iter()
        .map(|a| a.as_ref().to_os_string())
        .collect();
    let out = base(cwd).args(&args).output()?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(Error::Git {
            cmd: args
                .iter()
                .map(|a| a.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" "),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        })
    }
}

/// Like `git` but a non-zero exit is `Ok(None)`. For probes.
pub(crate) fn git_opt<I, S>(cwd: &Path, args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    git(cwd, args)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Run git and return (exit code, stdout, stderr) without failing on non-zero.
pub(crate) fn git_raw<I, S>(cwd: &Path, args: I) -> Result<(i32, String, String)>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let out = base(cwd).args(args).output()?;
    Ok((
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}
