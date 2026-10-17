#!/usr/bin/env bash
# Deploys Kernel to the test server: the image CI built and signed for the commit, verified before it runs (#66).
#
#   scripts/deploy.sh                 deploy origin/main (the published, signed image for its commit)
#   scripts/deploy.sh --build [branch]  build on the server instead (unsigned), e.g. to try a branch
#
# KERNEL_DEPLOY_HOST (default dockerhost) and KERNEL_DEPLOY_DIR (default ~/kernel) select the target, and
# KERNEL_DEPLOY_REPO (default snailtail/kernel) the GitHub repository whose CI signs the image. The host keeps its own
# .env; only committed and pushed code is deployed. A private image needs `docker login ghcr.io` on the host once,
# with a token that can only read packages.
set -euo pipefail

host="${KERNEL_DEPLOY_HOST:-dockerhost}"
dir="${KERNEL_DEPLOY_DIR:-kernel}"
repo="${KERNEL_DEPLOY_REPO:-snailtail/kernel}"
mode=signed
if [ "${1:-}" = --build ]; then mode=build; shift; fi
branch="${1:-main}"
if [ "$mode" = signed ] && [ "$branch" != main ]; then
  echo "only main has signed images; use: scripts/deploy.sh --build $branch" >&2
  exit 2
fi

git fetch -q origin "$branch"
if [ -n "$(git rev-list "origin/$branch..$branch" 2>/dev/null)" ]; then
  echo "warning: local $branch has commits that are not pushed to origin; they will not be deployed" >&2
fi

ssh "$host" bash -s -- "$dir" "$branch" "$mode" "$repo" <<'REMOTE'
set -euo pipefail
cd "$1"
branch=$2 mode=$3 repo=$4
git fetch -q origin "$branch"
git checkout -q "$branch"
git merge -q --ff-only "origin/$branch"
commit=$(git rev-parse HEAD)
echo "Deploying $(git log -1 --format='%h %s')"

if [ "$mode" = build ]; then
  docker compose up -d --build --remove-orphans
else
  image="ghcr.io/$repo:sha-$commit"
  if ! docker pull -q "$image" >/dev/null; then
    echo "No image for $commit yet. Wait for the 'Publish signed image' job (gh run watch), then deploy again." >&2
    exit 1
  fi
  # Pinned to the digest just pulled, so the image that was verified is the image that runs.
  ref=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" | grep -m1 "^ghcr.io/$repo@sha256:")
  # The signature must come from this repository's CI workflow on main, for this exact commit (Sigstore keyless).
  creds=()
  [ -f "$HOME/.docker/config.json" ] && creds=(-v "$HOME/.docker/config.json:/docker/config.json:ro" -e DOCKER_CONFIG=/docker)
  docker run --rm "${creds[@]}" "$(scripts/tool-image.sh cosign)" verify \
    --certificate-identity "https://github.com/$repo/.github/workflows/ci.yml@refs/heads/main" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    --certificate-github-workflow-repository "$repo" \
    --certificate-github-workflow-sha "$commit" \
    "$ref" >/dev/null
  echo "Signature verified: $ref"
  # Compose runs kernel:latest; tagging the verified digest means a plain `docker compose up` uses it too.
  docker tag "$ref" kernel:latest
  docker compose up -d --no-build --remove-orphans
fi

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
