#!/usr/bin/env sh
# Builds, signs and notarizes the two release DMGs, one per architecture, into
# dist/Tasma-<version>-arm64.dmg and dist/Tasma-<version>-x64.dmg.
#
# Release steps:
#   1. Set "version" in the root package.json. The app, the daemon and the CLI
#      all read it from there.
#   2. Commit the change. The script refuses a working tree with changes.
#   3. Run `pnpm app:release`.
#   4. Install each DMG once into a new macOS user account: the app opens with
#      no Gatekeeper dialog, the board shows, and after Tasma › Install Command
#      Line Tool… `tasma --version` prints the new version.
#
# Prerequisites:
#   - rustup with the targets aarch64-apple-darwin and x86_64-apple-darwin.
#     Homebrew Rust has the host target only.
#   - The Developer ID Application identity in the login Keychain. Set
#     APPLE_SIGNING_IDENTITY to use an identity other than the default below.
#   - The notarytool Keychain profile tasma-notary, made with
#     `xcrun notarytool store-credentials tasma-notary` from an App Store
#     Connect API key.
#   - bun, and network access: bun downloads the x64 runtime, and notarization
#     is an Apple service.
#   - A logged-in GUI session: the DMG layout step drives Finder.
#
# The script runs no tests, changes nothing in git and publishes nothing.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

NOTARY_PROFILE=tasma-notary
TARGETS="aarch64-apple-darwin x86_64-apple-darwin"

APPLE_SIGNING_IDENTITY=${APPLE_SIGNING_IDENTITY:-"Developer ID Application: Almaz Mubinov (3A8ZGST774)"}
export APPLE_SIGNING_IDENTITY

# Tauri notarizes the app by itself when it finds any of these. The script
# notarizes the DMG instead, which holds the app.
unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH

triple=""
reported=""

fail() {
  reported=1
  if [ -n "$triple" ]; then
    echo "app-release: $triple: $*" >&2
  else
    echo "app-release: $*" >&2
  fi
  exit 1
}

# A command that fails under `set -e` prints its own error only, so this names
# the target it failed on.
on_exit() {
  status=$?
  if [ "$status" -ne 0 ] && [ -z "$reported" ] && [ -n "$triple" ]; then
    echo "app-release: $triple: the release stopped with exit status $status" >&2
  fi
}
trap on_exit EXIT

# Signs a compiled daemon or CLI with the hardened runtime and the JIT
# entitlement, which JavaScriptCore needs under that runtime.
sign_binary() {
  codesign --force --options runtime --timestamp \
    --entitlements apps/macos/Entitlements.plist --sign "$APPLE_SIGNING_IDENTITY" "$1"
}

# Fails unless the executable at $1 carries the hardened runtime, the Team ID
# and the JIT entitlement. Tauri can sign a nested binary again during the build.
check_nested() {
  # codesign -d writes the flags and the Team ID to stderr.
  details=$(codesign -d --verbose --entitlements - "$1" 2>&1) || fail "$1 is not signed"
  printf '%s\n' "$details" | grep -q '(runtime)' || fail "$1 has no hardened runtime"
  printf '%s\n' "$details" | grep -qx "TeamIdentifier=$team" || fail "$1 is not signed by the team $team"
  printf '%s\n' "$details" | grep -qF com.apple.security.cs.allow-jit || fail "$1 has no com.apple.security.cs.allow-jit"
}

team=$(printf '%s\n' "$APPLE_SIGNING_IDENTITY" | sed -n 's/.*(\([A-Z0-9]*\))$/\1/p')
[ -n "$team" ] || fail "no Team ID in the signing identity \"$APPLE_SIGNING_IDENTITY\""

changes=$(git status --porcelain) || fail "\`git status\` fails; run the script from a git checkout"
[ -z "$changes" ] || fail "the working tree has changes; commit them first"

installed=$(rustup target list --installed 2>/dev/null) || fail "rustup is not installed; Homebrew Rust has the host target only"
for target in $TARGETS; do
  printf '%s\n' "$installed" | grep -qx "$target" || fail "the Rust target $target is missing; run \`rustup target add $target\`"
done

security find-identity -v -p codesigning | grep -qF "\"$APPLE_SIGNING_IDENTITY\"" ||
  fail "the Keychain has no valid signing identity \"$APPLE_SIGNING_IDENTITY\""

xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 ||
  fail "\`xcrun notarytool history --keychain-profile $NOTARY_PROFILE\` fails; check the profile and the network"

pnpm install --frozen-lockfile
# git status does not see ignored paths, so a local edit in node_modules would
# go into the signed binaries.
pnpm store status || fail "\`pnpm store status\` finds packages with local changes"

version=$(plutil -extract version raw -o - package.json)
minimum_macos=$(plutil -extract bundle.macOS.minimumSystemVersion raw -o - apps/macos/tauri.conf.json)
mkdir -p dist
rm -f dist/Tasma-"$version"-*.dmg

for triple in $TARGETS; do
  case "$triple" in
    aarch64-*) arch=arm64 ;;
    x86_64-*) arch=x64 ;;
  esac

  scripts/app-binaries.sh "$triple"
  # build.rs copies these files into the bundle byte for byte, so the signature
  # made here is the one that ships.
  sign_binary "apps/macos/binaries/tasma-daemon-$triple"
  sign_binary "apps/macos/binaries/tasma-cli-$triple"

  bundle="apps/macos/target/$triple/release/bundle"
  # A DMG left from an earlier version would match the glob below.
  rm -rf "$bundle"

  MACOSX_DEPLOYMENT_TARGET=$minimum_macos TAURI_APP_PATH=apps/macos \
    pnpm exec tauri build --target "$triple" --bundles app,dmg -- --locked

  app="$bundle/macos/Tasma.app"
  set -- "$bundle"/dmg/*.dmg
  [ "$#" -eq 1 ] && [ -f "$1" ] || fail "expected one DMG in $bundle/dmg"
  dmg=$1

  check_nested "$app/Contents/MacOS/tasma-daemon"
  check_nested "$app/Contents/MacOS/tasma-cli"
  codesign --verify --deep --strict "$app" || fail "$app does not pass codesign --verify"

  codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$dmg"

  # `submit` exits non-zero on a rejection, and the log has to print first.
  submission=$(xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json) || true
  id=$(printf '%s' "$submission" | plutil -extract id raw -o - - 2>/dev/null) || id=""
  outcome=$(printf '%s' "$submission" | plutil -extract status raw -o - - 2>/dev/null) || outcome=""
  if [ "$outcome" != Accepted ]; then
    [ -z "$id" ] || xcrun notarytool log "$id" --keychain-profile "$NOTARY_PROFILE" >&2 || true
    fail "notarization ended with status \"${outcome:-unknown}\": $submission"
  fi

  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg" || fail "$dmg has no valid stapled ticket"
  spctl --assess --type exec -vv "$app" || fail "Gatekeeper rejects $app"
  spctl --assess --type open --context context:primary-signature -vv "$dmg" || fail "Gatekeeper rejects $dmg"

  release="dist/Tasma-$version-$arch.dmg"
  cp "$dmg" "$release"
  echo "$root/$release"
  shasum -a 256 "$release"
done
