#!/usr/bin/env bash
# accelerate.sh — the alkanes-safe accelerator on this computer, with one command.
#
#   bash accelerate.sh                 first run: downloads the repo to ~/alkanes-safe-accelerate, then starts it
#                                      later runs: reuse that copy (fast-forwarding it to the latest), then start
#   bash accelerate.sh --no-update     start the copy you have without checking for updates
#   bash accelerate.sh --port 4200     any other flag goes to the server (--port N, --no-open)
#   ACCEL_DIR=/somewhere bash accelerate.sh    keep the copy somewhere else
#
# What runs: site/serve-local.mjs (Node built-ins only, nothing installed). It checks every file of the prebuilt
# page in local/ against the hashes recorded at build time, serves it on http://localhost:4173/ (127.0.0.1 only),
# forwards the page's SUBFROST calls the way subfrost-app's server does, and opens the browser. Why a local
# server at all, and what it refuses: see the header of site/serve-local.mjs.
#
# Run from inside a clone, it uses that clone. Run from anywhere else (downloaded on its own), it uses
# $ACCEL_DIR or ~/alkanes-safe-accelerate, cloning it (public, no sign-in) only if that folder does not exist yet. An existing folder
# that is not this repo is refused, never overwritten. Updates are fast-forward only and skipped when the copy
# has local changes; offline, it starts the copy it has.
# Tests: site/test/local-runner.mjs. Setup guide for users: https://0xcasuwu.github.io/alkanes-safe-accelerate/
set -euo pipefail

REPO="0xcasuwu/alkanes-safe-accelerate"
REPO_URL="${ACCEL_REPO_URL:-https://github.com/$REPO.git}"

say() { printf '  %s\n' "$*"; }
die() { printf '\n  ✗ %s\n\n' "$*" >&2; exit 1; }

update=1
server_args=()
for a in "$@"; do
  if [ "$a" = "--no-update" ]; then update=0; else server_args+=("$a"); fi
done

# ── 1. tools ──
command -v git >/dev/null 2>&1 || die "git is not installed. On a Mac run: xcode-select --install   (Linux: install git with your package manager)"
command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install version 18 or newer from https://nodejs.org (or on a Mac with Homebrew: brew install node), then run this again."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \
  || die "Node.js $(node -v) is too old. Install version 18 or newer from https://nodejs.org, then run this again."

# ── 2. the copy to run ──
is_ours() { # $1 = folder: a clone of this repo?
  local url
  url="$(git -C "$1" remote get-url origin 2>/dev/null)" || return 1
  [ -n "${ACCEL_REPO_URL:-}" ] && [ "$url" = "$ACCEL_REPO_URL" ] && return 0
  case "$url" in *"$REPO"|*"$REPO.git"|*"$REPO/") return 0 ;; esac
  return 1
}
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${ACCEL_DIR:-}" ] && [ -f "$here/site/serve-local.mjs" ] && is_ours "$here"; then
  dir="$here"
else
  dir="${ACCEL_DIR:-$HOME/alkanes-safe-accelerate}"
fi

if [ ! -e "$dir" ]; then
  say "Downloading the accelerator to $dir (first run only)…"
  # Public repo: no sign-in. GIT_TERMINAL_PROMPT=0 so a mistyped URL fails instead of asking for a password.
  GIT_TERMINAL_PROMPT=0 git clone --quiet "$REPO_URL" "$dir" || die "Download failed. Check your internet connection and run this again."
elif ! is_ours "$dir"; then
  die "$dir already exists and is not a copy of $REPO. Move it aside, or choose another folder: ACCEL_DIR=/some/folder bash accelerate.sh"
elif [ "$update" = 1 ]; then
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then
    say "Not updating: $dir has local changes. Running it as it is."
  elif [ "$(git -C "$dir" rev-parse --abbrev-ref HEAD)" != "main" ]; then
    say "Not updating: $dir is not on main. Running it as it is."
  elif git -C "$dir" fetch --quiet origin main 2>/dev/null; then
    before="$(git -C "$dir" rev-parse --short HEAD)"
    if git -C "$dir" merge --ff-only --quiet origin/main 2>/dev/null; then
      after="$(git -C "$dir" rev-parse --short HEAD)"
      if [ "$before" = "$after" ]; then say "Up to date ($after)."; else say "Updated $before → $after."; fi
    else
      say "Could not fast-forward to the latest version. Running the copy you have ($before)."
    fi
  else
    say "Could not check for updates (offline?). Running the copy you have ($(git -C "$dir" rev-parse --short HEAD))."
  fi
fi

[ -f "$dir/site/serve-local.mjs" ] || die "$dir has no site/serve-local.mjs: this copy is from before the local runner. Update it (git -C \"$dir\" pull) and run this again."

# ── 3. start ──
exec node "$dir/site/serve-local.mjs" ${server_args[@]+"${server_args[@]}"}
