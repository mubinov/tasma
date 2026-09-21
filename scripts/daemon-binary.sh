#!/usr/bin/env sh
# Compiles the daemon into the self-contained executable the application ships
# beside its own, so a machine with no Node installed still serves the tree.
#
# It stands outside scripts/dev-home.sh: the wrapper replaces HOME for the whole
# child, which would put bun's cache and its downloaded runtimes under /tmp,
# where macOS clears them.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

# The triple is Tauri's name for the file and the architecture is bun's name for
# the runtime. Both are read from the toolchain, so a host this script is run on
# cannot disagree with the crate built beside it.
triple=$(rustc -vV | sed -n 's/^host: //p')

case "$triple" in
  aarch64-*) arch=arm64 ;;
  x86_64-*) arch=x64 ;;
  *)
    echo "daemon-binary: no bun target for $triple" >&2
    exit 1
    ;;
esac

out="apps/macos/binaries/tasma-daemon-$triple"
# The scratch file differs from the output by directory alone. bun writes the
# output name into the executable, so a name of its own would change the bytes
# on every run: the comparison below would never match, the output would be
# replaced every time, and the guard that keeps the crate's build incremental
# would be inert with no visible symptom.
scratch="apps/macos/binaries/.tmp/tasma-daemon-$triple"

pnpm --filter @tasma/daemon build

mkdir -p "$(dirname "$scratch")"
bun build apps/daemon/dist/tasma-daemon.js --compile --target="bun-darwin-$arch" --outfile "$scratch"

# tauri_build reruns on the mtime of the output and relinks the whole crate, so
# a compile that produced the same bytes leaves the output untouched.
if cmp -s "$scratch" "$out"; then
  rm -f "$scratch"
else
  mv -f "$scratch" "$out"
fi
