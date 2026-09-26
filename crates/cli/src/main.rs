use clap::{Parser, Subcommand, ValueEnum};
use pando_core::{branch, workspace, CreateWorkspace, Repo, Workspace, WorkspaceKind};
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
    /// List workspaces
    Ls,
    /// List branches with upstream, ahead/behind, and where they are checked out
    Branches,
    /// Create a workspace for a branch and run post_create hooks
    New {
        branch: String,
        /// Start point for the new branch
        #[arg(long)]
        base: Option<String>,
        /// Where to put it. Defaults to the .pando.toml location template
        #[arg(long)]
        path: Option<PathBuf>,
        /// Check out an existing branch instead of creating one
        #[arg(long)]
        existing: bool,
        /// Skip post_create hooks
        #[arg(long)]
        no_hooks: bool,
    },
    /// Remove a workspace by branch or path
    Rm {
        target: String,
        /// Remove even with uncommitted changes
        #[arg(long, short)]
        force: bool,
    },
    /// Print a workspace path. Use: cd "$(pando switch feat/x)"
    Switch { target: String },
    /// Open a workspace in your editor ($PANDO_EDITOR, $VISUAL, $EDITOR)
    Open {
        target: String,
        /// Editor command, e.g. "code" or "cursor"
        #[arg(long)]
        editor: Option<String>,
    },
    /// Print a shell function `pcd` that cd's into a workspace
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
        Cmd::Ls => {
            let repo = open(cli.repo.as_deref())?;
            let ws = workspace::list(&repo)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&ws).unwrap());
            } else {
                let ports = pando_core::runtime::ports(&repo)?;
                for w in &ws {
                    let kind = match w.kind {
                        WorkspaceKind::Main => "main",
                        WorkspaceKind::Linked => "",
                    };
                    let branch = w.branch.clone().unwrap_or_else(|| "(detached)".into());
                    let port = w
                        .branch
                        .as_ref()
                        .and_then(|b| ports.get(b))
                        .map(|p| format!(":{p}"))
                        .unwrap_or_default();
                    let flags = [
                        w.locked.as_ref().map(|_| "locked"),
                        w.prunable.as_ref().map(|_| "prunable"),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" ");
                    println!(
                        "{branch:<28} {kind:<5} {port:<6} {flags:<9} {}",
                        w.path.display()
                    );
                }
            }
        }
        Cmd::Branches => {
            let repo = open(cli.repo.as_deref())?;
            let bs = branch::list(&repo)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&bs).unwrap());
            } else {
                for b in &bs {
                    let ab = match (b.ahead, b.behind) {
                        (Some(a), Some(d)) => format!("↑{a} ↓{d}"),
                        _ => String::new(),
                    };
                    let up = b.upstream.clone().unwrap_or_default();
                    let at = b
                        .checked_out_in
                        .as_ref()
                        .map(|p| p.display().to_string())
                        .unwrap_or_default();
                    println!("{:<28} {up:<20} {ab:<8} {at}", b.name);
                }
            }
        }
        Cmd::New {
            branch,
            base,
            path,
            existing,
            no_hooks,
        } => {
            let repo = open(cli.repo.as_deref())?;
            let created = workspace::create(
                &repo,
                &CreateWorkspace {
                    branch,
                    base,
                    path,
                    existing_branch: existing,
                    run_hooks: !no_hooks,
                },
            )?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&created).unwrap());
            } else {
                println!("created {}", created.workspace.path.display());
                if let Some(p) = created.port {
                    println!("port {p}");
                }
                for h in &created.hooks {
                    let mark = if h.ok() { "ok " } else { "FAIL" };
                    println!("{mark} {}", h.command);
                    if !h.ok() {
                        eprint!("{}{}", h.stdout, h.stderr);
                    }
                }
            }
            if created.hooks.iter().any(|h| !h.ok()) {
                exit(2);
            }
        }
        Cmd::Rm { target, force } => {
            let repo = open(cli.repo.as_deref())?;
            let w = find(&repo, &target)?;
            workspace::remove(&repo, &w.path, force)?;
            if !cli.json {
                println!("removed {}", w.path.display());
            }
        }
        Cmd::Switch { target } => {
            let repo = open(cli.repo.as_deref())?;
            println!("{}", find(&repo, &target)?.path.display());
        }
        Cmd::Open { target, editor } => {
            let repo = open(cli.repo.as_deref())?;
            let w = find(&repo, &target)?;
            pando_core::launch::open_in_editor(&w.path, editor.as_deref())?;
        }
    }
    Ok(())
}

fn open(path: Option<&Path>) -> pando_core::Result<Repo> {
    let cwd = std::env::current_dir()?;
    Repo::discover(path.unwrap_or(&cwd))
}

/// Match a workspace by branch name, then by path.
fn find(repo: &Repo, target: &str) -> pando_core::Result<Workspace> {
    let ws = workspace::list(repo)?;
    let by_branch = ws.iter().find(|w| w.branch.as_deref() == Some(target));
    let by_path = || {
        let p = dunce::canonicalize(target).ok()?;
        ws.iter().find(|w| w.path == p)
    };
    by_branch
        .or_else(by_path)
        .cloned()
        .ok_or_else(|| pando_core::Error::Config(format!("no workspace for '{target}'")))
}

fn shell_init(shell: Shell) -> &'static str {
    match shell {
        Shell::Bash | Shell::Zsh => {
            "pcd() { local p; p=\"$(pando switch \"$1\")\" && cd \"$p\"; }\n"
        }
        Shell::Fish => "function pcd\n    set -l p (pando switch $argv[1]); and cd $p\nend\n",
    }
}
