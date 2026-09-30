#!/usr/bin/env bash
# jcoder — Copyright (C) 2026 Jason Roughley — SPDX-License-Identifier: GPL-3.0-or-later
#
# Publishes a release: bumps the version, tags it, pushes, and creates a
# GitHub release with the built package (jcoder-X.Y.Z.tgz) attached. Every
# installed jcoder picks it up within a day, or at once with /update.
#
#   scripts/release.sh patch|minor|major|X.Y.Z
set -euo pipefail
cd "$(dirname "$0")/.."

bump=${1:?usage: scripts/release.sh patch|minor|major|X.Y.Z}
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first" >&2; exit 1; }
branch=$(git branch --show-current)
case "$branch" in master|main) ;; *) echo "release from master or main, not $branch" >&2; exit 1 ;; esac
command -v gh >/dev/null || { echo "needs the GitHub CLI (gh)" >&2; exit 1; }

npm ci --no-audit --no-fund
npm run build
version=$(npm version "$bump" -m "jcoder %s")   # commits package.json and tags vX.Y.Z
version=${version#v}
tgz=$(npm pack --silent)                         # runs the build again via prepack
git push --follow-tags
gh release create "v$version" "$tgz" --title "jcoder $version" --generate-notes
rm -f "$tgz"
echo "released jcoder $version"
