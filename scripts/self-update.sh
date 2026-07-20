#!/usr/bin/env bash
set -euo pipefail

REPO="${SPARKDASH_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
REMOTE="${SPARKDASH_REMOTE:-origin}"
BRANCH="${SPARKDASH_BRANCH:-main}"
RESTART_CMD="${SPARKDASH_RESTART_CMD:-docker compose up --build -d}"

cd "$REPO"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "sparkDash update skipped: tracked local changes are present" >&2
  exit 2
fi

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$BRANCH" ]]; then
  echo "sparkDash update skipped: expected branch $BRANCH, found $current_branch" >&2
  exit 2
fi

git fetch "$REMOTE" "$BRANCH"
local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse "$REMOTE/$BRANCH")"

if [[ "$local_head" == "$remote_head" ]]; then
  echo "sparkDash is already current"
  exit 0
fi

if ! git merge-base --is-ancestor "$local_head" "$remote_head"; then
  echo "sparkDash update skipped: $REMOTE/$BRANCH is not a fast-forward" >&2
  exit 2
fi

git merge --ff-only "$remote_head"
npm ci
npm run build
bash -lc "$RESTART_CMD"
echo "sparkDash updated to $remote_head"
