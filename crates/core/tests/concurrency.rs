//! Reads must survive other git processes changing the repo underneath them.
mod common;
use common::*;
use pando_core::{detail, log, overview};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[test]
fn many_overview_loads_at_once() {
    let r = repo();
    for i in 0..4 {
        add_worktree(&r, &format!("feat/{i}"), &format!("wt{i}"));
    }
    let root = r.root.clone();
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let root = root.clone();
            std::thread::spawn(move || {
                let core = pando_core::Repo::discover(&root).unwrap();
                for _ in 0..5 {
                    let o = overview::load(&core).unwrap();
                    assert_eq!(o.branches.len(), 5);
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
}

#[test]
fn reads_while_another_process_commits_and_branches() {
    let r = repo();
    let stop = Arc::new(AtomicBool::new(false));
    let writer = {
        let root = r.root.clone();
        let stop = stop.clone();
        std::thread::spawn(move || {
            let mut i = 0;
            while !stop.load(Ordering::Relaxed) {
                commit(&root, "busy.txt", &format!("{i}\n"));
                git(&root, &["branch", "-f", &format!("b{}", i % 5)]);
                i += 1;
            }
            i
        })
    };
    let core = r.core();
    for _ in 0..30 {
        overview::load(&core).unwrap();
        log::list(&core, None, 0, 50).unwrap();
        detail::load(&core, &r.root).unwrap();
    }
    stop.store(true, Ordering::Relaxed);
    assert!(writer.join().unwrap() > 0, "the writer really ran");
}
