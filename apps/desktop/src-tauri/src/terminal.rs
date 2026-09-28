//! Open a terminal in a folder. Not git, so it lives here and not in core.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Terminals we know how to open in a folder, most likely preferred first:
/// if you installed a third-party one, you probably use it.
#[cfg(target_os = "macos")]
const MAC: &[(&str, &str)] = &[
    ("Ghostty", "/Applications/Ghostty.app"),
    ("iTerm", "/Applications/iTerm.app"),
    ("Warp", "/Applications/Warp.app"),
    ("WezTerm", "/Applications/WezTerm.app"),
    ("Terminal", "/System/Applications/Utilities/Terminal.app"),
];

/// The terminal Pando will use, by name, for the menu label.
pub fn name() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        MAC.iter()
            .find(|(_, p)| Path::new(p).exists())
            .map(|(n, _)| n.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        Some(
            if which("wt.exe").is_some() {
                "Windows Terminal"
            } else {
                "Command Prompt"
            }
            .to_string(),
        )
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        which("x-terminal-emulator")
            .or_else(|| which("gnome-terminal"))
            .map(|_| "Terminal".to_string())
    }
}

pub fn open(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err(format!("{} isn't a folder", dir.display()));
    }
    let spawned = spawn(dir);
    spawned
        .map(|_| ())
        .map_err(|e| format!("Couldn't open a terminal: {e}"))
}

#[cfg(target_os = "macos")]
fn spawn(dir: &Path) -> std::io::Result<std::process::Child> {
    let (app, _) = MAC
        .iter()
        .find(|(_, p)| Path::new(p).exists())
        .ok_or_else(|| std::io::Error::other("no terminal app found"))?;
    let d = dir.as_os_str();
    match *app {
        // These take the folder as an argument rather than a document to open.
        "Ghostty" => Command::new("open")
            .args(["-na", "Ghostty", "--args"])
            .arg(format!("--working-directory={}", dir.display()))
            .spawn(),
        "WezTerm" => Command::new("open")
            .args(["-na", "WezTerm", "--args", "start", "--cwd"])
            .arg(d)
            .spawn(),
        other => Command::new("open").args(["-a", other]).arg(d).spawn(),
    }
}

#[cfg(target_os = "windows")]
fn spawn(dir: &Path) -> std::io::Result<std::process::Child> {
    if which("wt.exe").is_some() {
        Command::new("wt.exe").arg("-d").arg(dir).spawn()
    } else {
        Command::new("cmd")
            .args(["/c", "start", "cmd", "/K", "cd", "/d"])
            .arg(dir)
            .spawn()
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn(dir: &Path) -> std::io::Result<std::process::Child> {
    match which("x-terminal-emulator") {
        Some(t) => Command::new(t).current_dir(dir).spawn(),
        None => Command::new("gnome-terminal")
            .arg(format!("--working-directory={}", dir.display()))
            .spawn(),
    }
}

#[allow(dead_code)]
fn which(exe: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|p| {
        std::env::split_paths(&p)
            .map(|d| d.join(exe))
            .find(|f| f.is_file())
    })
}
