//! Open a folder in a code editor. Not git, so it lives here and not in core.

use std::path::{Path, PathBuf};
use std::process::Command;

struct Editor {
    name: &'static str,
    /// App bundle name on macOS, without ".app".
    app: &'static str,
    /// Command-line launchers, looked up on PATH.
    bins: &'static [&'static str],
}

/// Editors we know how to open a folder in. AI-first and newer ones first:
/// if you installed one of those, you probably use it.
const EDITORS: &[Editor] = &[
    Editor {
        name: "Cursor",
        app: "Cursor",
        bins: &["cursor"],
    },
    Editor {
        name: "Windsurf",
        app: "Windsurf",
        bins: &["windsurf"],
    },
    Editor {
        name: "Zed",
        app: "Zed",
        bins: &["zed", "zeditor"],
    },
    Editor {
        name: "VS Code",
        app: "Visual Studio Code",
        bins: &["code"],
    },
    Editor {
        name: "VSCodium",
        app: "VSCodium",
        bins: &["codium"],
    },
    Editor {
        name: "Sublime Text",
        app: "Sublime Text",
        bins: &["subl"],
    },
    Editor {
        name: "IntelliJ IDEA",
        app: "IntelliJ IDEA",
        bins: &["idea"],
    },
    Editor {
        name: "WebStorm",
        app: "WebStorm",
        bins: &["webstorm"],
    },
    Editor {
        name: "PyCharm",
        app: "PyCharm",
        bins: &["pycharm"],
    },
    Editor {
        name: "GoLand",
        app: "GoLand",
        bins: &["goland"],
    },
    Editor {
        name: "RustRover",
        app: "RustRover",
        bins: &["rustrover"],
    },
    Editor {
        name: "PhpStorm",
        app: "PhpStorm",
        bins: &["phpstorm"],
    },
    Editor {
        name: "RubyMine",
        app: "RubyMine",
        bins: &["rubymine"],
    },
    Editor {
        name: "CLion",
        app: "CLion",
        bins: &["clion"],
    },
    Editor {
        name: "Rider",
        app: "Rider",
        bins: &["rider"],
    },
];

/// How to start one: a macOS app bundle, or a launcher on PATH.
#[derive(Debug, PartialEq, Eq)]
enum Found {
    App(PathBuf),
    Bin(PathBuf),
}

/// File names a launcher can have on this system.
fn bin_files(bin: &str) -> Vec<String> {
    if cfg!(windows) {
        ["cmd", "exe", "bat"]
            .iter()
            .map(|e| format!("{bin}.{e}"))
            .collect()
    } else {
        vec![bin.to_string()]
    }
}

/// Every known editor found in `apps` (folders of .app bundles) or on `path`,
/// in preference order.
fn detect(apps: &[PathBuf], path: &[PathBuf]) -> Vec<(&'static str, Found)> {
    EDITORS
        .iter()
        .filter_map(|e| {
            let app = apps
                .iter()
                .map(|d| d.join(format!("{}.app", e.app)))
                .find(|p| p.is_dir())
                .map(Found::App);
            let bin = || {
                e.bins
                    .iter()
                    .flat_map(|b| bin_files(b))
                    .flat_map(|f| path.iter().map(move |d| d.join(&f)))
                    .find(|p| p.is_file())
                    .map(Found::Bin)
            };
            app.or_else(bin).map(|f| (e.name, f))
        })
        .collect()
}

fn installed() -> Vec<(&'static str, Found)> {
    let apps: Vec<PathBuf> = if cfg!(target_os = "macos") {
        let mut a = vec![PathBuf::from("/Applications")];
        a.extend(std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Applications")));
        a
    } else {
        vec![]
    };
    let path: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    detect(&apps, &path)
}

/// The editors "Open in …" can use, by name.
pub fn names() -> Vec<String> {
    installed()
        .into_iter()
        .map(|(n, _)| n.to_string())
        .collect()
}

pub fn open(name: &str, dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err(format!("{} isn't a folder", dir.display()));
    }
    let (_, found) = installed()
        .into_iter()
        .find(|(n, _)| *n == name)
        .ok_or_else(|| format!("{name} isn't installed any more."))?;
    command(&found, dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open {name}: {e}"))
}

fn command(found: &Found, dir: &Path) -> Command {
    match found {
        Found::App(app) => {
            let mut c = Command::new("open");
            c.arg("-a").arg(app).arg(dir);
            c
        }
        Found::Bin(bin) => {
            let mut c = Command::new(bin);
            c.arg(dir);
            #[cfg(windows)]
            {
                // Launchers are often .cmd files: don't flash a console window.
                use std::os::windows::process::CommandExt;
                c.creation_flags(0x0800_0000);
            }
            c
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, bin: &str) -> PathBuf {
        let p = dir.join(&bin_files(bin)[0]);
        std::fs::write(&p, "").unwrap();
        p
    }

    #[test]
    fn finds_apps_and_launchers_in_preference_order() {
        let tmp = tempfile::tempdir().unwrap();
        let (apps, bin) = (tmp.path().join("Applications"), tmp.path().join("bin"));
        std::fs::create_dir_all(apps.join("Visual Studio Code.app")).unwrap();
        std::fs::create_dir_all(apps.join("Zed.app")).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        let cursor = touch(&bin, "cursor");
        let got = detect(std::slice::from_ref(&apps), &[bin]);
        assert_eq!(
            got,
            vec![
                ("Cursor", Found::Bin(cursor)),
                ("Zed", Found::App(apps.join("Zed.app"))),
                ("VS Code", Found::App(apps.join("Visual Studio Code.app"))),
            ]
        );
    }

    #[test]
    fn an_app_wins_over_its_launcher_and_each_editor_is_listed_once() {
        let tmp = tempfile::tempdir().unwrap();
        let (apps, a, b) = (
            tmp.path().join("Apps"),
            tmp.path().join("a"),
            tmp.path().join("b"),
        );
        for d in [&apps, &a, &b] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::create_dir_all(apps.join("Zed.app")).unwrap();
        touch(&a, "zed");
        touch(&b, "zeditor");
        let first = touch(&a, "code");
        touch(&b, "code");
        let got = detect(std::slice::from_ref(&apps), &[a, b]);
        assert_eq!(
            got,
            vec![
                ("Zed", Found::App(apps.join("Zed.app"))),
                ("VS Code", Found::Bin(first))
            ]
        );
    }

    #[test]
    fn nothing_installed_and_lookalikes_find_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        // A file named like an app, a folder named like a launcher, a near miss.
        std::fs::write(dir.join("Cursor.app"), "").unwrap();
        std::fs::create_dir_all(dir.join(&bin_files("code")[0])).unwrap();
        std::fs::write(dir.join("codex"), "").unwrap();
        assert!(detect(std::slice::from_ref(&dir), std::slice::from_ref(&dir)).is_empty());
        assert!(detect(&[], &[]).is_empty());
        assert!(detect(&[dir.join("missing")], &[dir.join("missing")]).is_empty());
    }

    #[test]
    fn open_refuses_a_missing_folder_and_an_unknown_editor() {
        let tmp = tempfile::tempdir().unwrap();
        let e = open("Cursor", &tmp.path().join("nope")).unwrap_err();
        assert!(e.contains("isn't a folder"), "{e}");
        let e = open("Not An Editor", tmp.path()).unwrap_err();
        assert!(e.contains("isn't installed"), "{e}");
    }

    #[test]
    fn the_folder_is_passed_as_one_argument_whatever_its_name() {
        let dir = Path::new("/tmp/my repo ü & co; rm -rf");
        let c = command(&Found::Bin(PathBuf::from("/usr/bin/code")), dir);
        assert_eq!(c.get_args().collect::<Vec<_>>(), [dir.as_os_str()]);
        let c = command(&Found::App(PathBuf::from("/Applications/Zed.app")), dir);
        let args: Vec<_> = c.get_args().collect();
        assert_eq!(args.len(), 3);
        assert_eq!(args[2], dir.as_os_str());
    }
}
