#!/bin/sh
# install.sh — one-shot setup for agent-status
# Usage:  sh install.sh [--daily 5] [--weekly 25]
#         sh install.sh --reset      # remove all agent-status wiring
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$REPO_DIR/agent-status"
HOME_DIR="$HOME"

# ── helpers ─────────────────────────────────────────────────────

info()  { printf '  %s\n' "$*"; }
ok()    { printf '✓ %s\n' "$*"; }
warn()  { printf '! %s\n' "$*"; }
die()   { printf 'error: %s\n' "$*" >&2; exit 1; }

# delete one top-level key from a JSON file, preserving everything else
# (no-op if the file is missing/unparseable or the key isn't present)
json_del_key() {
  _file="$1"; _key="$2"
  [ -f "$_file" ] || return 0
  "$NODE" - "$_file" "$_key" <<'EOF'
const fs = require('fs');
const [,, fp, key] = process.argv;
let cfg; try { cfg = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { process.exit(0); }
if (cfg && typeof cfg === 'object' && key in cfg) {
  delete cfg[key];
  fs.writeFileSync(fp, JSON.stringify(cfg, null, 2) + '\n');
}
EOF
}

# ── reset / uninstall ────────────────────────────────────────────
# Strips the shell snippet and the Claude/Codex status-line keys.
# Leaves ~/.config/agent-status/config.json (your budgets) untouched.
do_reset() {
  printf 'Removing agent-status wiring...\n'

  CLAUDE_SETTINGS="$HOME_DIR/.claude/settings.json"
  json_del_key "$CLAUDE_SETTINGS" statusLine \
    && [ -f "$CLAUDE_SETTINGS" ] && ok "Claude Code: statusLine cleared from $CLAUDE_SETTINGS"

  # Legacy: older versions wrote a (no-op) statusLineCmd into config.json
  CODEX_CFG="$HOME_DIR/.codex/config.json"
  json_del_key "$CODEX_CFG" statusLineCmd \
    && [ -f "$CODEX_CFG" ] && ok "Codex: legacy statusLineCmd cleared from $CODEX_CFG"

  # Codex native status line: remove only the exact lines we inserted
  # (a hand-edited status_line is left untouched).
  CODEX_TOML="$HOME_DIR/.codex/config.toml"
  if [ -f "$CODEX_TOML" ]; then
    "$NODE" - "$CODEX_TOML" <<'EOF'
const fs = require('fs');
const fp = process.argv[2];
const OURS = new Set([
  'status_line = ["model-with-reasoning", "context-used", "five-hour-limit", "weekly-limit", "git-branch", "current-dir"]',
  'status_line_use_colors = true',
]);
let txt; try { txt = fs.readFileSync(fp, 'utf8'); } catch { process.exit(0); }
const kept = txt.split('\n').filter(l => !OURS.has(l.trim()));
fs.writeFileSync(fp, kept.join('\n'));
EOF
    ok "Codex: agent-status items removed from $CODEX_TOML (restart Codex)"
  fi

  # Cursor: remove statusLine command if it points at this repo's binary.
  CURSOR_CFG="$HOME_DIR/.cursor/cli-config.json"
  if [ -f "$CURSOR_CFG" ]; then
    "$NODE" - "$CURSOR_CFG" "$BINARY" <<'EOF'
const fs = require('fs');
const fp = process.argv[2];
const bin = process.argv[3];
let cfg; try { cfg = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { process.exit(0); }
let changed = false;
if (cfg?.statusLine?.command && cfg.statusLine.command.includes('agent-status')) {
  delete cfg.statusLine;
  changed = true;
}
if (cfg?.display?.showStatusLineRunningTime === true) {
  cfg.display.showStatusLineRunningTime = false;
  changed = true;
}
if (changed) fs.writeFileSync(fp, JSON.stringify(cfg, null, 2) + '\n');
EOF
    ok "Cursor: statusLine + footer running-time cleared from $CURSOR_CFG (restart Cursor)"
  fi

  # Antigravity (agy): remove statusLine command if it points at this repo's binary.
  AGY_CFG="$HOME_DIR/.gemini/antigravity-cli/settings.json"
  if [ -f "$AGY_CFG" ]; then
    "$NODE" - "$AGY_CFG" <<'EOF'
const fs = require('fs');
const fp = process.argv[2];
let cfg; try { cfg = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { process.exit(0); }
if (cfg?.statusLine?.command && cfg.statusLine.command.includes('agent-status')) {
  delete cfg.statusLine;
  fs.writeFileSync(fp, JSON.stringify(cfg, null, 2) + '\n');
}
EOF
    ok "Antigravity: statusLine cleared from $AGY_CFG (restart agy)"
  fi

  # Remove the snippet block(s): from the "# agent-status" marker line
  # through the next top-level `fi` (the outer if's closer, column 0).
  for rcfile in "$HOME_DIR/.zshrc" "$HOME_DIR/.bashrc"; do
    [ -f "$rcfile" ] || continue
    if grep -qxF '# agent-status' "$rcfile" 2>/dev/null; then
      tmp=$(mktemp)
      awk '
        /^# agent-status$/ { skip=1; next }
        skip && /^fi$/     { skip=0; next }
        skip               { next }
        { print }
      ' "$rcfile" > "$tmp" && mv "$tmp" "$rcfile"
      ok "Shell: snippet removed from $rcfile"
    else
      info "Shell: nothing to remove in $rcfile"
    fi
  done

  printf '\nReset complete — the status line is unwired.\n'
  printf 'Important: open a NEW terminal and restart Codex / Cursor / agy.\n'
  printf 'Existing sessions already loaded the old prompt hook, so they\n'
  printf 'keep printing the old line until the shell is reloaded.\n'
}

# ── args ─────────────────────────────────────────────────────────

DAILY=""
WEEKLY=""
RESET=""
i=1
while [ $i -le $# ]; do
  eval "arg=\${$i}"
  i=$((i + 1))
  case "$arg" in
    --daily|-d)        eval "DAILY=\${$i}";  i=$((i + 1)) ;;
    --weekly|-w)       eval "WEEKLY=\${$i}"; i=$((i + 1)) ;;
    --reset|--uninstall) RESET=1 ;;
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

# ── reset short-circuits the install steps ───────────────────────
if [ -n "$RESET" ]; then
  do_reset
  exit 0
fi

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

# ── 5. Codex native status line (if installed) ──────────────────
# Codex has NO external-command status-line hook — it renders its own
# built-in status line from [tui].status_line in ~/.codex/config.toml,
# a list of built-in item keys. We configure those items to mirror the
# agent-status layout (model+effort, context, usage limits, branch, cwd).

CODEX_DIR="$HOME_DIR/.codex"
if [ -d "$CODEX_DIR" ]; then
  CODEX_TOML="$CODEX_DIR/config.toml"
  [ -f "$CODEX_TOML" ] && cp "$CODEX_TOML" "$CODEX_TOML.bak.agentstatus"
  "$NODE" - "$CODEX_TOML" <<'EOF'
const fs = require('fs');
const fp = process.argv[2];
let txt = ''; try { txt = fs.readFileSync(fp, 'utf8'); } catch {}
const KEYS = 'status_line = ["model-with-reasoning", "context-used", "five-hour-limit", "weekly-limit", "git-branch", "current-dir"]';
const COLOR = 'status_line_use_colors = true';
if (/^\s*status_line\s*=/m.test(txt)) { console.log('exists'); process.exit(0); }  // don't clobber a hand-tuned line
const lines = txt.split('\n');
const tuiIdx = lines.findIndex(l => /^\s*\[tui\]\s*$/.test(l));
if (tuiIdx !== -1) {
  lines.splice(tuiIdx + 1, 0, KEYS, COLOR);          // add under existing [tui]
} else {
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const block = ['[tui]', KEYS, COLOR, ''];
  lines.splice(firstTable === -1 ? lines.length : firstTable, 0, ...block);
}
fs.mkdirSync(require('path').dirname(fp), { recursive: true });
fs.writeFileSync(fp, lines.join('\n'));
console.log('set');
EOF
  ok "Codex: [tui].status_line configured in $CODEX_TOML (restart Codex to see it)"
else
  info "Codex not installed (~/.codex missing) — skipping native status-line config"
fi

# ── 5b. Cursor CLI status line (if installed) ───────────────────
# Cursor Agent supports an external statusLine command in ~/.cursor/cli-config.json
# (same shape as Claude Code). We point it at agent-status and also enable the
# built-in footer running-time display as a fallback when the command is slow.

CURSOR_DIR="$HOME_DIR/.cursor"
CURSOR_CFG="$CURSOR_DIR/cli-config.json"
if [ -f "$CURSOR_CFG" ]; then
  cp "$CURSOR_CFG" "$CURSOR_CFG.bak.agentstatus"
  "$NODE" - "$CURSOR_CFG" "$BINARY" <<'EOF'
const fs = require('fs');
const fp = process.argv[2];
const bin = process.argv[3];
let cfg; try { cfg = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { console.log('skip'); process.exit(0); }
cfg.display = cfg.display || {};
cfg.display.showStatusLineRunningTime = true;
if (cfg.statusLine?.command === bin) { console.log('exists'); process.exit(0); }
cfg.statusLine = { type: 'command', command: bin, padding: 0, updateIntervalMs: 300, timeoutMs: 2000 };
fs.writeFileSync(fp, JSON.stringify(cfg, null, 2) + '\n');
console.log('set');
EOF
  ok "Cursor: statusLine command set in $CURSOR_CFG (restart Cursor to see it)"
else
  info "Cursor not installed (~/.cursor/cli-config.json missing) — skipping status line config"
fi

# ── 5c. Antigravity (agy) status line (if installed) ────────────
# Antigravity's CLI (agy, the Gemini-CLI successor) supports an external
# statusLine command in ~/.gemini/antigravity-cli/settings.json (same shape
# as Claude Code). We point it at agent-status so it renders the full layout.

AGY_DIR="$HOME_DIR/.gemini/antigravity-cli"
AGY_CFG="$AGY_DIR/settings.json"
if [ -d "$AGY_DIR" ]; then
  [ -f "$AGY_CFG" ] && cp "$AGY_CFG" "$AGY_CFG.bak.agentstatus"
  "$NODE" - "$AGY_CFG" "$BINARY" <<'EOF'
const fs = require('fs');
const fp = process.argv[2];
const bin = process.argv[3];
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
if (cfg.statusLine?.command === bin) { console.log('exists'); process.exit(0); }
cfg.statusLine = { command: bin, enabled: true };
fs.mkdirSync(require('path').dirname(fp), { recursive: true });
fs.writeFileSync(fp, JSON.stringify(cfg, null, 2) + '\n');
console.log('set');
EOF
  ok "Antigravity: statusLine command set in $AGY_CFG (restart agy to see it)"
else
  info "Antigravity not installed (~/.gemini/antigravity-cli missing) — skipping status line config"
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
