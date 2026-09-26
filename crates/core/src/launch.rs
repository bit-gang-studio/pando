//! Open a worktree in the user's editor or file manager.

use crate::error::{Error, Result};
use std::path::Path;
use std::process::{Command, Stdio};

/// `editor` is a command line like `code` or `cursor --new-window`.
/// Falls back to `$PANDO_EDITOR`, `$VISUAL`, `$EDITOR`, then the OS opener.
pub fn open_in_editor(path: &Path, editor: Option<&str>) -> Result<()> {
    let from_env = ["PANDO_EDITOR", "VISUAL", "EDITOR"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()));
    let cmdline = editor.map(str::to_string).or(from_env);

    let mut cmd = match cmdline {
        Some(line) => {
            let mut parts = line.split_whitespace();
            let prog = parts
                .next()
                .ok_or_else(|| Error::Config("empty editor command".into()))?;
            let mut c = Command::new(prog);
            c.args(parts).arg(path);
            c
        }
        None => os_open(path),
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

fn os_open(path: &Path) -> Command {
    #[cfg(target_os = "macos")]
    {
        let mut c = Command::new("open");
        c.arg(path);
        c
    }
    #[cfg(windows)]
    {
        let mut c = Command::new("explorer");
        c.arg(path);
        c
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let mut c = Command::new("xdg-open");
        c.arg(path);
        c
    }
}
