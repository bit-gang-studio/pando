#!/bin/bash
# Builds a throwaway repo for the real-git browser tests. Only touches $1.
set -euo pipefail
BASE="$1"
rm -rf "$BASE" && mkdir -p "$BASE/config"
cd "$BASE"
g() { git -c user.name=Test -c user.email=test@example.com -c commit.gpgsign=false "$@"; }
c() { echo "$2" > "$1"; g add -- "$1"; g commit -q -m "$3"; }

git init -q --bare origin.git
git init -q -b main shop && cd shop
git config core.autocrlf false
c README.md "shop" "Initial commit"
c app.js "console.log(1)" "Add app"
git remote add origin "$BASE/origin.git"
g push -q -u origin main
g tag v1

# feat/login: pushed, then one more local commit (↑1), plus an uncommitted edit.
g worktree add -q -b feat/login ../shop-feat-login
( cd ../shop-feat-login && c login.js "login v1" "Add login" && g push -q -u origin feat/login && c login.js "login v2" "Improve login" && echo "draft notes" > notes.txt && echo "unsaved" >> app.js )

# feat/behind: pushed; a teammate pushes on top, so after fetch it's ↓1.
g worktree add -q -b feat/behind ../shop-feat-behind
( cd ../shop-feat-behind && c behind.js "b1" "Start behind" && g push -q -u origin feat/behind )
git clone -q "$BASE/origin.git" ../teammate
( cd ../teammate && g switch -q feat/behind && c behind.js "b2 from teammate" "Teammate change" && g push -q origin feat/behind )

# feat/done: squash-merged into main, so it's "merged".
g worktree add -q -b feat/done ../shop-feat-done
( cd ../shop-feat-done && c done1.js "d1" "Done part 1" && c done2.js "d2" "Done part 2" )
g merge -q --squash feat/done && g commit -q -m "Squash feat/done"
c later.js "later" "Main moves on"

# feat/dirty: a worktree with uncommitted work, for forced remove + undo.
g worktree add -q -b feat/dirty ../shop-feat-dirty
( cd ../shop-feat-dirty && echo "precious" > wip.txt && echo "edited" >> README.md )

# feat/collide: also edits login.js, so it overlaps feat/login.
g worktree add -q -b feat/collide ../shop-feat-collide
( cd ../shop-feat-collide && c login.js "a different login" "Rewrite login" )

g branch spike/old
echo "stashed idea" >> README.md && g stash push -q -m "half done"

printf '{"repos": ["%s"]}' "$BASE/shop" > "$BASE/config/config.json"
echo "ready: $BASE/shop"
