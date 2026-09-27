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
        // Never take optional locks: `git status` would otherwise lock the index
        // to save its cache, and the user's own `git commit` in a terminal fails
        // with "index.lock exists" if it lands at the same moment.
        .env("GIT_OPTIONAL_LOCKS", "0")
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

/// Run git with `input` on stdin. Returns (exit code, stdout bytes, stderr).
pub(crate) fn git_stdin<I, S>(cwd: &Path, args: I, input: &[u8]) -> Result<(i32, Vec<u8>, String)>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    use std::io::Write;
    use std::process::Stdio;
    let mut child = base(cwd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let input = input.to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let out = child.wait_with_output()?;
    let _ = writer.join();
    Ok((
        out.status.code().unwrap_or(-1),
        out.stdout,
        String::from_utf8_lossy(&out.stderr).trim().to_string(),
    ))
}

/// Like `git` with extra environment variables, e.g. a temporary `GIT_INDEX_FILE`.
pub(crate) fn git_env<I, S>(cwd: &Path, env: &[(&str, &OsStr)], args: I) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<_> = args
        .into_iter()
        .map(|a| a.as_ref().to_os_string())
        .collect();
    let mut c = base(cwd);
    for (k, v) in env {
        c.env(k, v);
    }
    let out = c.args(&args).output()?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
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
