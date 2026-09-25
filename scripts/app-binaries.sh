#!/usr/bin/env sh
# Compiles the daemon and the CLI into the self-contained executables the
# application ships beside its own, so a machine with no Node installed still
# serves the tree and still runs the command.
#
# It stands outside scripts/dev-home.sh: the wrapper replaces HOME for the whole
# child, which would put bun's cache and its downloaded runtimes under /tmp,
# where macOS clears them.
#
# Usage: scripts/app-binaries.sh [target-triple]
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

# The triple is Tauri's name for the file and the architecture is bun's name for
# the runtime. With no argument both are read from the toolchain, so a host this
# script is run on cannot disagree with the crate built beside it.
triple=${1:-$(rustc -vV | sed -n 's/^host: //p')}

case "$triple" in
  aarch64-*) arch=arm64 ;;
  x86_64-*) arch=x64 ;;
  *)
    echo "app-binaries: no bun target for $triple" >&2
    exit 1
    ;;
esac

# Compiles the script in $1 into the executable at $2.
compile() {
  # The scratch file differs from the output by directory alone. bun writes the
  # output name into the executable, so a name of its own would change the bytes
  # on every run: the comparison below would never match, the output would be
  # replaced every time, and the guard that keeps the crate's build incremental
  # would be inert with no visible symptom.
  scratch="apps/macos/binaries/.tmp/$(basename "$2")"

  mkdir -p "$(dirname "$scratch")"
  # A compiled executable reads bunfig.toml and .env from its working directory
  # by default, and a bunfig.toml preload runs code before the entry.
  bun build "$1" --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
    --target="bun-darwin-$arch" --outfile "$scratch"

  # tauri_build reruns on the mtime of the output and relinks the whole crate, so
  # a compile that produced the same bytes leaves the output untouched.
  if cmp -s "$scratch" "$2"; then
    rm -f "$scratch"
  else
    mv -f "$scratch" "$2"
  fi
}

pnpm --filter @tasma/daemon --filter @tasma/cli build

compile apps/daemon/dist/tasma-daemon.js "apps/macos/binaries/tasma-daemon-$triple"
compile apps/cli/dist/tasma.js "apps/macos/binaries/tasma-cli-$triple"
