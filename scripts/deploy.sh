#!/usr/bin/env bash
# Deploys a branch from GitHub to the test server: pulls it on the host and rebuilds the containers.
#
#   scripts/deploy.sh [branch]        (default: main)
#
# KERNEL_DEPLOY_HOST (default dockerhost) and KERNEL_DEPLOY_DIR (default ~/kernel) select the target.
# The host keeps its own .env; only committed and pushed code is deployed.
set -euo pipefail

host="${KERNEL_DEPLOY_HOST:-dockerhost}"
dir="${KERNEL_DEPLOY_DIR:-kernel}"
branch="${1:-main}"

git fetch -q origin "$branch"
if [ -n "$(git rev-list "origin/$branch..$branch" 2>/dev/null)" ]; then
  echo "warning: local $branch has commits that are not pushed to origin; they will not be deployed" >&2
fi

ssh "$host" bash -s -- "$dir" "$branch" <<'REMOTE'
set -euo pipefail
cd "$1"
git fetch -q origin "$2"
git checkout -q "$2"
git merge -q --ff-only "origin/$2"
echo "Deploying $(git log -1 --format='%h %s')"
docker compose up -d --build --remove-orphans
app=$(docker compose ps -q app)
for _ in $(seq 60); do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$app")
  [ "$status" = healthy ] && { echo "Kernel is healthy"; exit 0; }
  [ "$status" = unhealthy ] && break
  sleep 2
done
echo "Kernel did not become healthy (status: $status). Recent logs:" >&2
docker compose logs --tail 30 app >&2
exit 1
REMOTE
