//! Can Pando read these folders at all?
//!
//! On macOS, Documents, Desktop, Downloads, iCloud Drive and removable or
//! network volumes are protected: the first read asks the user. If every git
//! command asked at once, the user would get a pile of identical prompts. So
//! the app calls `check` first, alone, and runs no git until it passes.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// One check at a time, so two windows opening together ask once.
static GATE: Mutex<()> = Mutex::new(());

/// Folders the OS won't let Pando read. Missing folders aren't included:
/// that's a different problem, reported where the repo is opened.
pub fn check(paths: &[PathBuf]) -> Vec<PathBuf> {
    let _one = GATE.lock().unwrap_or_else(|e| e.into_inner());
    paths.iter().filter(|p| blocked(p)).cloned().collect()
}

fn blocked(p: &Path) -> bool {
    match std::fs::read_dir(p) {
        Ok(_) => false,
        Err(e) => e.kind() == std::io::ErrorKind::PermissionDenied,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn readable_missing_and_blocked() {
        let tmp = tempfile::tempdir().unwrap();
        let ok = tmp.path().join("ok");
        let locked = tmp.path().join("locked");
        std::fs::create_dir(&ok).unwrap();
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let missing = tmp.path().join("missing");

        let got = check(&[ok.clone(), locked.clone(), missing.clone()]);
        assert!(!got.contains(&ok) && !got.contains(&missing), "{got:?}");
        // Root reads anything; everyone else is blocked by mode 000.
        let root = std::env::var("USER").as_deref() == Ok("root");
        assert_eq!(got.contains(&locked), !root, "{got:?}");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn many_threads_at_once_all_get_an_answer() {
        let tmp = tempfile::tempdir().unwrap();
        let p = vec![tmp.path().to_path_buf()];
        let hs: Vec<_> = (0..16)
            .map(|_| {
                let p = p.clone();
                std::thread::spawn(move || check(&p))
            })
            .collect();
        for h in hs {
            assert!(h.join().unwrap().is_empty());
        }
    }
}
