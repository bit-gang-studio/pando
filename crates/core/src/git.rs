use serde::{Deserialize, Serialize};
use std::process::Command;

/// Lowest git we support. Apple ships 2.39.
pub const MIN_GIT: (u32, u32) = (2, 39);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Doctor {
    pub git_version: Option<String>,
    pub git_ok: bool,
    pub min_git: String,
}

/// Check the git on PATH.
pub fn doctor() -> Doctor {
    let raw = Command::new("git")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let parsed = raw.as_deref().and_then(parse_version);
    Doctor {
        git_ok: parsed.map(|v| v >= MIN_GIT).unwrap_or(false),
        git_version: parsed.map(|(a, b)| format!("{a}.{b}")).or(raw),
        min_git: format!("{}.{}", MIN_GIT.0, MIN_GIT.1),
    }
}

/// "git version 2.39.5 (Apple Git-154)" -> (2, 39)
fn parse_version(s: &str) -> Option<(u32, u32)> {
    let v = s
        .split_whitespace()
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))?;
    let mut parts = v.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_apple_git() {
        assert_eq!(
            parse_version("git version 2.39.5 (Apple Git-154)"),
            Some((2, 39))
        );
    }

    #[test]
    fn parses_windows_git() {
        assert_eq!(parse_version("git version 2.51.0.windows.1"), Some((2, 51)));
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(parse_version("nope"), None);
    }
}
