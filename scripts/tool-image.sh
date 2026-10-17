#!/usr/bin/env sh
# Prints the pinned image (tag@digest) of a tool stage in .github/tools/Dockerfile, e.g. `scripts/tool-image.sh trivy`.
set -eu
file="$(dirname "$0")/../.github/tools/Dockerfile"
image=$(awk -v stage="$1" '$1 == "FROM" && $3 == "AS" && $4 == stage { print $2 }' "$file")
case "$image" in
  *@sha256:*) echo "$image" ;;
  *) echo "tool-image: no image pinned by digest for '$1' in $file" >&2; exit 1 ;;
esac
