#!/usr/bin/env sh
# Runs a command with HOME on the development tree, so the application writes
# its .tasma tree under /tmp rather than in the real home directory.
set -eu
# Cargo and rustup keep their trees under the real HOME. Replacing HOME for a
# command that compiles would send them to /tmp, where macOS clears the
# downloaded registry, so both are named from the real home first.
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export CARGO_HOME RUSTUP_HOME
HOME=/tmp/tasma-dev
export HOME
mkdir -p "$HOME"
# A package manager runs a root script from the repository root, while the CLI
# resolves the acting project from the directory it runs in. INIT_CWD carries
# the directory the invocation came from.
cd "${INIT_CWD:-$PWD}"
exec "$@"
