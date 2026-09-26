use clap::{Parser, Subcommand, ValueEnum};
use pando_core::{overview, worktree, CreateWorktree, Repo, Worktree};
use std::path::{Path, PathBuf};
use std::process::exit;

#[derive(Parser)]
#[command(name = "pando", version = pando_core::VERSION, about = "The worktree-native git client")]
struct Cli {
    /// Repo path. Defaults to the current directory.
    #[arg(long, global = true)]
    repo: Option<PathBuf>,
    /// Print JSON.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// List branches and their worktrees
    List,
    /// Add a worktree for a branch (creates the branch unless --existing)
    Add {
        branch: String,
        /// Start point for a new branch. Defaults to the repo's default branch
        #[arg(long)]
        base: Option<String>,
        /// Where to put it. Defaults to a sibling folder, <repo>-<branch>
        #[arg(long)]
        path: Option<PathBuf>,
        /// The branch already exists
        #[arg(long)]
        existing: bool,
    },
    /// Remove a worktree by branch or path. The branch is kept.
    Remove {
        target: String,
        /// Remove even with uncommitted changes
        #[arg(long, short)]
        force: bool,
    },
    /// Print a worktree path. Use: cd "$(pando switch feat/x)"
    Switch { target: String },
    /// Print a shell function `pcd` that cd's into a worktree
    ShellInit { shell: Shell },
    /// Check git and the environment
    Doctor,
}

#[derive(Clone, Copy, ValueEnum)]
enum Shell {
    Bash,
    Zsh,
    Fish,
}

fn main() {
    let cli = Cli::parse();
    if let Err(e) = run(cli) {
        eprintln!("error: {e}");
        exit(1);
    }
}

fn run(cli: Cli) -> pando_core::Result<()> {
    match cli.command {
        Cmd::Doctor => {
            let d = pando_core::doctor();
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&d).unwrap());
            } else {
                let v = d.git_version.as_deref().unwrap_or("not found");
                let ok = if d.git_ok { "ok" } else { "too old or missing" };
                println!("git {v} ({ok}, need >= {})", d.min_git);
            }
            if !d.git_ok {
                exit(1);
            }
        }
        Cmd::ShellInit { shell } => print!("{}", shell_init(shell)),
        Cmd::List => {
            let repo = open(cli.repo.as_deref())?;
            let o = overview::load(&repo)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&o).unwrap());
            } else {
                for r in &o.branches {
                    let state = match (&r.worktree, r.status) {
                        (Some(_), Some(s)) if s.is_clean() => "clean".to_string(),
                        (Some(_), Some(s)) => format!("{} changed", s.changed()),
                        (Some(_), None) => "missing".to_string(),
                        (None, _) => String::new(),
                    };
                    let ahead = r
                        .ahead_of_base
                        .filter(|a| *a > 0)
                        .map(|a| format!("{a} ahead"))
                        .unwrap_or_default();
                    let path = r
                        .worktree
                        .as_ref()
                        .map(|w| w.path.display().to_string())
                        .unwrap_or_default();
                    println!("{:<28} {state:<11} {ahead:<9} {path}", r.branch.name);
                }
                for d in &o.detached {
                    let head = d
                        .worktree
                        .head
                        .as_deref()
                        .map(|h| &h[..7.min(h.len())])
                        .unwrap_or("?");
                    let state = d
                        .status
                        .map(|s| {
                            if s.is_clean() {
                                "clean".to_string()
                            } else {
                                format!("{} changed", s.changed())
                            }
                        })
                        .unwrap_or_default();
                    println!(
                        "{:<28} {state:<11} {:<9} {}",
                        format!("(detached {head})"),
                        "",
                        d.worktree.path.display()
                    );
                }
                for r in &o.remote_only {
                    println!("{:<28} remote only", r.name);
                }
            }
        }
        Cmd::Add {
            branch,
            base,
            path,
            existing,
        } => {
            let repo = open(cli.repo.as_deref())?;
            let created = worktree::create(
                &repo,
                &CreateWorktree {
                    branch,
                    base,
                    path,
                    existing_branch: existing,
                },
            )?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&created).unwrap());
            } else {
                println!("added {}", created.worktree.path.display());
            }
        }
        Cmd::Remove { target, force } => {
            let repo = open(cli.repo.as_deref())?;
            let w = find(&repo, &target)?;
            worktree::remove(&repo, &w.path, force)?;
            if !cli.json {
                println!("removed {}", w.path.display());
            }
        }
        Cmd::Switch { target } => {
            let repo = open(cli.repo.as_deref())?;
            println!("{}", find(&repo, &target)?.path.display());
        }
    }
    Ok(())
}

fn open(path: Option<&Path>) -> pando_core::Result<Repo> {
    let cwd = std::env::current_dir()?;
    Repo::discover(path.unwrap_or(&cwd))
}

/// Match a worktree by branch name, then by path.
fn find(repo: &Repo, target: &str) -> pando_core::Result<Worktree> {
    let ws = worktree::list(repo)?;
    let by_branch = ws.iter().find(|w| w.branch.as_deref() == Some(target));
    let by_path = || {
        let p = dunce::canonicalize(target).ok()?;
        ws.iter().find(|w| w.path == p)
    };
    by_branch
        .or_else(by_path)
        .cloned()
        .ok_or_else(|| pando_core::Error::Config(format!("no worktree for '{target}'")))
}

fn shell_init(shell: Shell) -> &'static str {
    match shell {
        Shell::Bash | Shell::Zsh => {
            "pcd() { local p; p=\"$(pando switch \"$1\")\" && cd \"$p\"; }\n"
        }
        Shell::Fish => "function pcd\n    set -l p (pando switch $argv[1]); and cd $p\nend\n",
    }
}
