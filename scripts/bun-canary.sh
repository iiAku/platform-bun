#!/bin/sh
# Runs a command of the Bun canary pinned in tools/bun-canary/package.json: `sh scripts/bun-canary.sh
# lint [args]`. `bun lint` ships only in canary builds; `bun check` and `bun fmt` are in the Bun
# release this repository runs on.
#
# The canary is a separate package (tools/bun-canary) so that its `bun` never shadows, through
# node_modules/.bin, the Bun that runs tests and builds. It is installed from its own lockfile on
# first use, and again whenever its manifest or lockfile changes. With no command, the script only
# installs it.
#
# On a Bun without the requested command, `bun lint` means `bun run lint`, and the `lint` script
# calls this script again. That second entry stops here instead of recursing until the machine
# runs out of processes.
set -eu

if [ -n "${BUN_CANARY_COMMAND:-}" ]; then
  echo "tools/bun-canary has no '$BUN_CANARY_COMMAND' command: pin a Bun build that ships it" >&2
  exit 2
fi

# The physical path, so that a checkout reaching tools/ through a symlink shares the lock below.
tool=$(CDPATH='' cd -P -- "$(dirname -- "$0")/../tools/bun-canary" && pwd -P)
stamp="$tool/node_modules/.installed-pin"
# What was installed: a changed pin reinstalls even when its lockfile was not updated, and the
# frozen install then refuses the mismatch instead of running the old build.
installed() {
  cat "$tool/package.json" "$tool/bun.lock" | cmp -s - "$stamp"
}
if ! installed; then
  # Concurrent runs all arrive here on a fresh checkout; one of them installs.
  lock="${TMPDIR:-/tmp}/bun-canary-$(printf '%s' "$tool" | cksum | cut -d ' ' -f 1).lock"
  waited=0
  until mkdir "$lock" 2>/dev/null; do
    # An installer killed outright leaves its lock behind. Once its owner is gone, one waiter, the
    # one holding $lock.break, removes the lock if that owner still holds it, and all retry.
    owner=$(cat "$lock/pid" 2>/dev/null || true)
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null && mkdir "$lock.break" 2>/dev/null; then
      [ "$(cat "$lock/pid" 2>/dev/null || true)" = "$owner" ] && rm -rf "$lock"
      rmdir "$lock.break"
      continue
    fi
    waited=$((waited + 1))
    if [ "$waited" -gt 600 ]; then
      echo "Waited 2 minutes for $lock: remove it if no install is running" >&2
      exit 1
    fi
    sleep 0.2
  done
  trap 'rm -rf "$lock"' EXIT
  # 128 plus the signal, as a shell reports one: `bun lint` exits 1 for findings, so an interrupted
  # install must not exit 1 as well.
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  echo $$ >"$lock/pid"
  if ! installed; then
    bun install --frozen-lockfile --cwd "$tool" >&2
    cat "$tool/package.json" "$tool/bun.lock" >"$stamp"
  fi
  rm -rf "$lock"
  trap - EXIT HUP INT TERM
fi

[ "$#" -gt 0 ] || exit 0
command=$1
shift
BUN_CANARY_COMMAND=$command exec "$tool/node_modules/.bin/bun" "$command" --no-script "$@"
