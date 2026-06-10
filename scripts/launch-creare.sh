#!/usr/bin/env bash
# Day-to-day launcher for the Creare desktop app — runs the PRODUCTION build
# (electron-vite preview: no dev server, no tsc watchers), unlike `pnpm dev`.
# Wired to a .desktop entry so it launches from the XFCE menu / a desktop icon.
#
# Robust to being launched with no terminal (Terminal=false): all output is
# appended to a log so failures are diagnosable.
set -euo pipefail

# Resolve the repo root from this script's own location (portable across machines).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO"

# corepack's pnpm shim lives in ~/.local/bin on this box; the desktop session's
# PATH may not include it.
export PATH="$HOME/.local/bin:$PATH"

LOG="${XDG_CACHE_HOME:-$HOME/.cache}/creare-launch.log"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "===== Creare launch $(date -Iseconds) ====="

# Build the production bundle once if it's missing (e.g. after a clean checkout
# or `pnpm clean`). To pick up new code afterwards, re-run:
#   pnpm --filter @creare/desktop build
if [ ! -f apps/desktop/out/main/index.js ]; then
  echo "No production build found — building once…"
  pnpm --filter @creare/desktop build
fi

# Launch it. `prepreview` swaps better-sqlite3 to the Electron ABI first, so this
# works regardless of whether `pnpm test` (Node ABI) ran last.
exec pnpm --filter @creare/desktop preview
