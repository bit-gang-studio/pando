use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "pando", version = pando_core::VERSION, about = "The worktree-native git client")]
struct Cli {
    #[command(subcommand)]
    command: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Check that git and the environment are usable
    Doctor {
        /// Print JSON instead of text
        #[arg(long)]
        json: bool,
    },
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Some(Cmd::Doctor { json }) => {
            let d = pando_core::doctor();
            if json {
                println!("{}", serde_json::to_string_pretty(&d).unwrap());
            } else {
                let v = d.git_version.as_deref().unwrap_or("not found");
                let ok = if d.git_ok { "ok" } else { "too old or missing" };
                println!("git {v} ({ok}, need >= {})", d.min_git);
            }
            if !d.git_ok {
                std::process::exit(1);
            }
        }
        None => println!("pando {}. Try `pando --help`.", pando_core::VERSION),
    }
}
