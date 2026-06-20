#!/bin/sh
# install.sh — one-shot setup for agent-status
# Usage:  sh install.sh [--daily 5] [--weekly 25]
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$REPO_DIR/agent-status"
HOME_DIR="$HOME"

# ── helpers ─────────────────────────────────────────────────────

info()  { printf '  %s\n' "$*"; }
ok()    { printf '✓ %s\n' "$*"; }
warn()  { printf '! %s\n' "$*"; }
die()   { printf 'error: %s\n' "$*" >&2; exit 1; }

read_json_field() {
  # read_json_field <file> <key>  — naive grep-based, avoids jq dependency
  grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$1" 2>/dev/null \
    | head -1 | sed 's/.*:[[:space:]]*"\(.*\)"/\1/'
}

# ── args ─────────────────────────────────────────────────────────

DAILY=""
WEEKLY=""
i=1
while [ $i -le $# ]; do
  eval "arg=\${$i}"
  i=$((i + 1))
  case "$arg" in
    --daily|-d)  eval "DAILY=\${$i}";  i=$((i + 1)) ;;
    --weekly|-w) eval "WEEKLY=\${$i}"; i=$((i + 1)) ;;
  esac
done

# ── 1. sanity checks ─────────────────────────────────────────────

[ -x "$BINARY" ] || die "agent-status binary not found or not executable at $BINARY"

# ── 2. find node ─────────────────────────────────────────────────

find_node() {
  command -v node 2>/dev/null && return
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$p" ] && { echo "$p"; return; }
  done
  NVM_DIR="${NVM_DIR:-$HOME_DIR/.nvm}"
  if [ -d "$NVM_DIR/versions/node" ]; then
    latest=$(ls -t "$NVM_DIR/versions/node" | head -1)
    [ -x "$NVM_DIR/versions/node/$latest/bin/node" ] && \
      echo "$NVM_DIR/versions/node/$latest/bin/node" && return
  fi
  CURSOR_AGENT="$HOME_DIR/.local/share/cursor-agent/versions"
  if [ -d "$CURSOR_AGENT" ]; then
    latest=$(ls -t "$CURSOR_AGENT" | head -1)
    [ -x "$CURSOR_AGENT/$latest/node" ] && echo "$CURSOR_AGENT/$latest/node" && return
  fi
  return 1
}

NODE=$(find_node) || die "Node.js not found. Install it via Homebrew: brew install node"
ok "Node found: $NODE"

# ── 3. Claude Code ───────────────────────────────────────────────

CLAUDE_SETTINGS="$HOME_DIR/.claude/settings.json"
if [ -d "$HOME_DIR/.claude" ]; then
  # Use node to safely merge — avoids clobbering other settings
  "$NODE" - "$CLAUDE_SETTINGS" "$BINARY" <<'EOF'
const fs = require('fs');
const [,, fp, bin] = process.argv;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
cfg.statusLine = { type: 'command', command: bin };
fs.mkdirSync(require('path').dirname(fp), { recursive: true });
fs.writeFileSync(fp, JSON.stringify(cfg, null, 2) + '\n');
EOF
  ok "Claude Code: statusLine set in $CLAUDE_SETTINGS"
else
  warn "~/.claude not found — skipping Claude Code setup (not installed?)"
fi

# ── 4. Shell (Cursor + Codex terminal integration) ───────────────

ZSHRC="$HOME_DIR/.zshrc"
BASHRC="$HOME_DIR/.bashrc"
MARKER="# agent-status"

add_shell_snippet() {
  local rcfile="$1"
  [ -f "$rcfile" ] || return
  if grep -qF "$MARKER" "$rcfile" 2>/dev/null; then
    ok "Shell: already present in $rcfile"
    return
  fi
  cat >> "$rcfile" <<SNIPPET

$MARKER
if [ -n "\$CURSOR_AGENT" ] || [ -n "\$CURSOR_TRACE_ID" ] || [ -n "\$VSCODE_IPC_HOOK_CLI" ] || [ -n "\$CODEX_SESSION_ID" ]; then
  _agent_status_precmd() { $BINARY 2>/dev/null; }
  if [ -n "\$ZSH_VERSION" ]; then
    precmd_functions+=(_agent_status_precmd)
  else
    PROMPT_COMMAND="\${PROMPT_COMMAND:+\$PROMPT_COMMAND; }_agent_status_precmd"
  fi
fi
SNIPPET
  ok "Shell: snippet added to $rcfile"
}

added_shell=0
for rcfile in "$ZSHRC" "$BASHRC"; do
  [ -f "$rcfile" ] && add_shell_snippet "$rcfile" && added_shell=1
done
[ "$added_shell" = "0" ] && warn "No .zshrc or .bashrc found — shell integration skipped"

# ── 5. Codex config (if installed) ──────────────────────────────

CODEX_DIR="$HOME_DIR/.codex"
if [ -d "$CODEX_DIR" ]; then
  "$NODE" - "$CODEX_DIR/config.json" "$BINARY" <<'EOF'
const fs = require('fs');
const [,, fp, bin] = process.argv;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
cfg.statusLineCmd = bin;
fs.mkdirSync(require('path').dirname(fp), { recursive: true });
fs.writeFileSync(fp, JSON.stringify(cfg, null, 2) + '\n');
EOF
  ok "Codex: statusLineCmd set in $CODEX_DIR/config.json"
else
  info "Codex not installed (~/.codex missing) — shell snippet covers it when you install"
fi

# ── 6. Budget config ─────────────────────────────────────────────

CFG_FILE="$HOME_DIR/.config/agent-status/config.json"
if [ -n "$DAILY" ] || [ -n "$WEEKLY" ]; then
  "$NODE" - "$CFG_FILE" "$DAILY" "$WEEKLY" <<'EOF'
const fs = require('fs');
const [,, fp, daily, weekly] = process.argv;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
if (daily)  cfg.dailyBudget  = parseFloat(daily);
if (weekly) cfg.weeklyBudget = parseFloat(weekly);
fs.mkdirSync(require('path').dirname(fp), { recursive: true });
fs.writeFileSync(fp, JSON.stringify(cfg, null, 2) + '\n');
EOF
  ok "Config: daily=${DAILY:-unchanged} weekly=${WEEKLY:-unchanged} → $CFG_FILE"
elif [ ! -f "$CFG_FILE" ]; then
  mkdir -p "$(dirname "$CFG_FILE")"
  cp "$REPO_DIR/config.example.json" "$CFG_FILE"
  ok "Config: example config written to $CFG_FILE (edit to set budgets)"
else
  ok "Config: $CFG_FILE already exists — unchanged"
fi

# ── done ─────────────────────────────────────────────────────────

printf '\nDone. Restart Claude Code and open a new terminal to pick up the status line.\n'
