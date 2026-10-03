#!/usr/bin/env sh
# Uploads dist/Tasma-<version>-arm64.dmg and dist/Tasma-<version>-x64.dmg to a
# new GitHub release v<version> on mubinov/tasma, as Tasma-arm64.dmg and
# Tasma-x64.dmg, and marks the release as latest. This is release step 6 in
# the header of scripts/app-release.sh.
#
# Usage: pnpm app:publish [--dry-run]
#   --dry-run  Run all checks, then print the release notes and the
#              `gh release create` command instead of running it.
#
# Prerequisites:
#   - The GitHub CLI gh, logged in with `gh auth login`, with write access to
#     mubinov/tasma.
#   - The tag v<version> pushed to origin.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

REPO=mubinov/tasma

fail() {
  echo "app-publish: $*" >&2
  exit 1
}

dry_run=""
case "$#:${1:-}" in
  0:) ;;
  1:--dry-run) dry_run=1 ;;
  *) fail "usage: pnpm app:publish [--dry-run]" ;;
esac

command -v gh >/dev/null || fail "gh is not installed; install the GitHub CLI"
gh auth status --hostname github.com --active >/dev/null 2>&1 || fail "gh is not logged in; run \`gh auth login\`"

version=$(plutil -extract version raw -o - package.json)
minimum_macos=$(plutil -extract bundle.macOS.minimumSystemVersion raw -o - apps/macos/tauri.conf.json)
tag="v$version"

for arch in arm64 x64; do
  release="dist/Tasma-$version-$arch.dmg"
  [ -f "$release" ] || fail "no $release; run \`pnpm app:release\` first"
  xcrun stapler validate "$release" >/dev/null || fail "$release has no valid stapled ticket"
done

# gh finds a draft release too.
if gh release view "$tag" --repo "$REPO" >/dev/null 2>&1; then
  fail "the release $tag exists on $REPO; delete it first with \`gh release delete $tag --repo $REPO\`"
fi

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

cp "dist/Tasma-$version-arm64.dmg" "$dir/Tasma-arm64.dmg"
cp "dist/Tasma-$version-x64.dmg" "$dir/Tasma-x64.dmg"
sums=$(cd "$dir" && shasum -a 256 Tasma-arm64.dmg Tasma-x64.dmg)

notes="$dir/notes.md"
cat >"$notes" <<EOF
Download the DMG for your Mac:

- Apple Silicon (M1 and later): Tasma-arm64.dmg
- Intel: Tasma-x64.dmg

Open the DMG, drag Tasma to Applications, then open Tasma.
Requires macOS $minimum_macos or later.

SHA-256:
$sums
EOF

# With files to upload, gh creates a draft and makes it public only after all
# uploads succeed.
set -- "$tag" --repo "$REPO" --verify-tag --latest --title "Tasma $version" --notes-file "$notes" \
  "$dir/Tasma-arm64.dmg" "$dir/Tasma-x64.dmg"

if [ -n "$dry_run" ]; then
  cat "$notes"
  echo
  printf 'gh release create'
  for arg in "$@"; do
    case "$arg" in
      *" "*) printf " '%s'" "$arg" ;;
      *) printf ' %s' "$arg" ;;
    esac
  done
  echo
  exit 0
fi

gh release create "$@"
