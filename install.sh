#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CFBrain installer
#
#   ./install.sh
#
# What it does:
#   1. checks/installs Bun (the only hard runtime dependency)
#   2. installs npm dependencies
#   3. creates .env from .env.example if missing
#   4. initialises a local PGLite brain at ~/.cfbrain
#   5. verifies the install with `doctor`
#
# It is safe to re-run: every step is idempotent and nothing is overwritten.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m   %s\n' "$1"; }
die()  { printf '\n\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# --- 1. Bun -----------------------------------------------------------------
say "Checking Bun"
BUN_WAS_MISSING_FROM_PATH=0
if ! command -v bun >/dev/null 2>&1; then
  BUN_WAS_MISSING_FROM_PATH=1
  # Bun may be installed but not on PATH for this shell
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
    ok "found Bun at ~/.bun/bin (not on your PATH — see the note at the end)"
  else
    warn "Bun not found — installing from bun.sh"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
    command -v bun >/dev/null 2>&1 || die "Bun install failed. Install manually: https://bun.sh"
    ok "Bun installed to ~/.bun/bin"
  fi
fi
ok "Bun $(bun --version)"

# --- 2. Dependencies --------------------------------------------------------
say "Installing dependencies"
bun install
ok "dependencies installed"

# --- 3. Config --------------------------------------------------------------
say "Setting up .env"
if [ -f .env ]; then
  ok ".env already exists (left untouched)"
else
  cp .env.example .env
  ok "created .env from .env.example"
  warn "edit .env and set OPENAI_API_KEY before using semantic search"
fi

# --- 4. Brain ---------------------------------------------------------------
say "Initialising local brain"
BRAIN_DIR="${CFBRAIN_DATA_HOME:-$HOME}/.cfbrain"
if [ -d "$BRAIN_DIR/brain.pglite" ]; then
  ok "brain already exists at $BRAIN_DIR/brain.pglite (left untouched)"
else
  bun run src/cli.ts init --pglite --non-interactive
  ok "brain created at $BRAIN_DIR/brain.pglite"
fi

# --- 5. Verify --------------------------------------------------------------
say "Verifying"
if bun run src/cli.ts doctor >/dev/null 2>&1; then
  ok "doctor passed"
else
  warn "doctor reported issues — run 'bun run src/cli.ts doctor' to see details"
fi

# --- 6. Feishu (optional) ----------------------------------------------------
say "Feishu integration (optional)"
if command -v lark-cli >/dev/null 2>&1; then
  ok "lark-cli detected — run 'bun run src/cli.ts feishu setup' to finish wiring it up"
else
  warn "lark-cli not installed"
  echo "    Feishu sync needs it. Everything else works without it."
  echo "    Guided setup (detects, asks first, then installs):"
  echo "      bun run src/cli.ts feishu setup"
fi

# --- Done -------------------------------------------------------------------
echo ""
echo "-------------------------------------------------------------------"
printf '\033[1m  CFBrain is installed.\033[0m\n'
echo "-------------------------------------------------------------------"

# The single most common post-install failure: this script exported PATH for
# ITSELF, but a shell cannot change its parent's environment. So if Bun was not
# already on the caller's PATH, every following `bun ...` command fails with
# "bun: command not found" even though the install succeeded. Say so loudly.
if [ "$BUN_WAS_MISSING_FROM_PATH" = "1" ]; then
  printf '\n\033[33m  ⚠  ONE MORE STEP — Bun is not on your PATH in this shell.\033[0m\n'
  echo   "     Without this, the next command you run will fail with"
  echo   '     "bun: command not found". Run this now:'
  printf '\n\033[1m       export PATH="$HOME/.bun/bin:$PATH"\033[0m\n'
  echo   ""
  echo   "     To make it permanent, add that line to your shell profile"
  echo   "     (~/.zshrc or ~/.bashrc), then restart your shell."
  echo   ""
  echo   "     Verify with:  bun --version"
fi

cat <<'EOF'

  Try it:
    bun run src/cli.ts --help
    bun run src/cli.ts list

  Optional — make `cfbrain` available globally:
    bun link

  Next: read QUICKSTART.md   (data & privacy: docs/DATA-AND-SYNC.md)
EOF
