#!/usr/bin/env bash
# scripts/release.sh <main commit>
#
# Fast-forwards origin/release (the live site) to a commit that is already on origin/main, after
# `npm run check` and a smoke run of the local dev stack pass on exactly that commit.
#
#   git checkout <commit>   # or stay on main at that commit
#   npm run dev             # in another terminal (ports 3000/4000/4100/4200)
#   SMOKE_AGENT_TOKEN=tk_agent_... bash scripts/release.sh <commit>
#
# It never force-pushes: a release that is not a fast-forward is refused by git.
set -euo pipefail

commit_arg="${1:-}"
if [[ -z "$commit_arg" ]]; then
  echo "usage: bash scripts/release.sh <main commit>" >&2
  exit 2
fi

cd "$(git rev-parse --show-toplevel)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean; commit or stash first." >&2
  exit 1
fi

git fetch --quiet origin
commit="$(git rev-parse --verify "${commit_arg}^{commit}")"
short="${commit:0:7}"

if ! git merge-base --is-ancestor "$commit" origin/main; then
  echo "$short is not on origin/main. Push it to main (and let CI pass) first." >&2
  exit 1
fi
if [[ "$(git rev-parse HEAD)" != "$commit" ]]; then
  echo "HEAD is $(git rev-parse --short HEAD), not $short. Check out $short so check and smoke test it." >&2
  exit 1
fi
if git rev-parse --verify --quiet origin/release >/dev/null; then
  if ! git merge-base --is-ancestor origin/release "$commit"; then
    echo "origin/release is not an ancestor of $short; a release must be a fast-forward." >&2
    exit 1
  fi
  echo "Releasing $(git rev-parse --short origin/release)..$short:"
  git log --oneline origin/release.."$commit"
else
  echo "origin/release does not exist yet; it will be created at $short."
fi

echo
echo "== npm run check"
npm run check

echo
echo "== npm run smoke -- --env local"
npm run smoke -- --env local

echo
echo "== git push origin $short:refs/heads/release"
git push origin "$commit:refs/heads/release"

cat <<MSG

Released $short to origin/release. Render auto-deploys all four services from release.

Next:
  1. Render dashboard: wait until gateway, web, twokey-mcp and agent-runner show
     "Deploy live" for commit $short (gateway runs migrations first in its pre-deploy step).
  2. npm run smoke -- --env prod      (SMOKE_*_URL and SMOKE_AGENT_TOKEN set)

If the release is bad, roll back (old code runs on the new schema; never a down migration):
  1. https://dashboard.render.com -> the broken service -> Events.
  2. Find the last deploy marked "Deploy live" before $short -> Rollback -> confirm.
     Repeat for every service the release broke (usually all four, gateway first).
  3. Rolling back turns off auto-deploy for that service. Fix forward on main, release again,
     then turn auto-deploy back on (service -> Settings -> Auto-Deploy: On Commit).
  4. npm run smoke -- --env prod, and add a row to the rollback log in docs/DEPLOY.md.
MSG
