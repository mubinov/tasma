#!/usr/bin/env sh
# Runs a command with HOME on the development tree, so the application writes
# its .tasma tree in a per-user directory under the temporary directory rather
# than in the real home directory.
set -eu
# Cargo and rustup keep their trees under the real HOME. Replacing HOME for a
# command that compiles would send them to the temporary directory, where macOS
# clears the downloaded registry, so both are named from the real home first.
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export CARGO_HOME RUSTUP_HOME
# A relative TMPDIR would resolve against a different directory after the cd
# below, so only an absolute one is used.
case "${TMPDIR:-}" in
  /*) HOME="$TMPDIR" ;;
  *) HOME=/tmp ;;
esac
HOME="${HOME%/}/tasma-dev"
export HOME
# The name can already exist; it is used only when it is a real directory of
# this account that no other account can write, because chmod does not remove
# what another account already put in it. The check is one find, which does not
# follow a link: separate tests stat the name separately, and another account
# can swap the name for a link between them. mkdir runs before the check, so a
# parallel run that creates the name first is not an error.
if ! mkdir_error=$(mkdir -m 700 "$HOME" 2>&1); then
  if [ ! -e "$HOME" ] && [ ! -L "$HOME" ]; then
    echo "$mkdir_error" >&2
    exit 1
  fi
  if [ -z "$(find "$HOME" -prune -type d -user "$(id -u)" ! -perm -020 ! -perm -002 2>/dev/null)" ]; then
    echo "dev-home: $HOME is not a directory of this account; remove it and run again" >&2
    exit 1
  fi
fi
chmod 700 "$HOME"
# A package manager runs a root script from the repository root, while the CLI
# resolves the acting project from the directory it runs in. INIT_CWD carries
# the directory the invocation came from.
cd "${INIT_CWD:-$PWD}"
exec "$@"
