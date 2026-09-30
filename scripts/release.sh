#!/usr/bin/env bash
# jcoder — Copyright (C) 2026 Jason Roughley — SPDX-License-Identifier: GPL-3.0-or-later
#
# Publishes a release: bumps the version, tags it, pushes, and creates a
# GitHub release with the built package (jcoder-X.Y.Z.tgz) attached. Every
# installed jcoder picks it up within a day, or at once with /update.
#
#   scripts/release.sh patch|minor|major|X.Y.Z   (the current version releases it as is)
set -euo pipefail
cd "$(dirname "$0")/.."

bump=${1:?usage: scripts/release.sh patch|minor|major|X.Y.Z}
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first" >&2; exit 1; }
branch=$(git branch --show-current)
case "$branch" in master|main) ;; *) echo "release from master or main, not $branch" >&2; exit 1 ;; esac
command -v gh >/dev/null || { echo "needs the GitHub CLI (gh)" >&2; exit 1; }
grep -q "^## " CHANGELOG.md || { echo "CHANGELOG.md needs a section for the release" >&2; exit 1; }

npm ci --no-audit --no-fund
npm run build
current=$(node -p "require('./package.json').version")
if [ "$bump" = "$current" ]; then
  # Releasing the version already in package.json (the first release).
  git tag -a "v$current" -m "jcoder $current"
  version=$current
else
  version=$(npm version "$bump" -m "jcoder %s")   # commits package.json and tags vX.Y.Z
  version=${version#v}
fi
tgz=$(npm pack --silent)                         # runs the build again via prepack
git push --follow-tags
# The same package as jcoder.tgz too, so releases/latest/download/jcoder.tgz
# is a stable install URL.
cp "$tgz" jcoder.tgz
# Notes: this version's section of CHANGELOG.md.
notes=$(awk -v v="## $version" '$0 == v {on=1; next} /^## / {on=0} on' CHANGELOG.md)
[ -n "$notes" ] || notes="jcoder $version"
gh release create "v$version" "$tgz" jcoder.tgz --title "jcoder $version" --notes "$notes"
rm -f "$tgz" jcoder.tgz
echo "released jcoder $version"
