//! Time the calls the repo page makes: `cargo run --release -p pando-core --example timing -- <repo>`
use pando_core::{branch, detail, log, merge, overview, stash, status, worktree, Repo};
use std::time::Instant;

fn main() {
    let root = std::env::args().nth(1).expect("repo path");
    let t = Instant::now();
    let repo = Repo::discover(std::path::Path::new(&root)).unwrap();
    println!("discover   {:>5}ms", t.elapsed().as_millis());
    macro_rules! time {
        ($name:expr, $e:expr) => {{
            let t = Instant::now();
            let r = $e;
            println!("  {:<12} {:>5}ms", $name, t.elapsed().as_millis());
            r
        }};
    }
    time!("base", merge::default_base(&repo).ok());
    let wts = time!("worktrees", worktree::list(&repo).unwrap());
    time!("branches", branch::list(&repo).unwrap());
    time!("remote", branch::list_remote(&repo).unwrap());
    for w in &wts {
        time!("status", status::summary(&w.path).unwrap());
    }
    time!("overview quick", overview::load_quick(&repo).unwrap());
    let t = Instant::now();
    let o = overview::load(&repo).unwrap();
    println!("overview   {:>5}ms", t.elapsed().as_millis());
    let t = Instant::now();
    log::list(&repo, None, 0, 200).unwrap();
    println!("log 200    {:>5}ms", t.elapsed().as_millis());
    let t = Instant::now();
    stash::list(&repo).unwrap();
    println!("stash list {:>5}ms", t.elapsed().as_millis());
    let path = o
        .branches
        .iter()
        .find_map(|b| b.worktree.as_ref())
        .unwrap()
        .path
        .clone();
    let t = Instant::now();
    detail::load(&repo, &path).unwrap();
    println!("detail     {:>5}ms", t.elapsed().as_millis());
}
