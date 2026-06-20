#!/usr/bin/env node
/**
 * setup.js  —  wire agent-status into Claude Code, Cursor, and Codex
 *
 * Usage:  node setup.js [--all] [--claude] [--cursor] [--codex]
 *         node setup.js --budget-daily 5 --budget-weekly 25
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const SCRIPT = path.resolve(__dirname, 'agent-status');
const HOME   = os.homedir();

function readJSON(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function writeJSON(fp, data) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n');
}

function mergeJSON(fp, patch) {
  const existing = readJSON(fp) || {};
  writeJSON(fp, Object.assign(existing, patch));
}

// ── Claude Code ──────────────────────────────────────────────
function setupClaudeCode() {
  const settingsPath = path.join(HOME, '.claude', 'settings.json');
  mergeJSON(settingsPath, { statusLine: SCRIPT });
  console.log(`✓ Claude Code: statusLine set in ${settingsPath}`);
}

// ── Cursor (shell integration) ───────────────────────────────
// Cursor doesn't have a native status-line hook, but you can add
// the script output to your shell prompt (PS1 / starship / p10k).
function setupCursor() {
  const snippet = `
# agent-status in Cursor terminal (add to ~/.zshrc or ~/.bashrc)
if [ -n "$CURSOR_TRACE_ID" ] || [ -n "$VSCODE_IPC_HOOK_CLI" ]; then
  __agent_status() { node ${SCRIPT} 2>/dev/null; }
  PROMPT_COMMAND='__agent_status'       # bash
  precmd() { __agent_status }           # zsh (add to precmd_functions instead)
fi
`;
  console.log('Cursor shell integration snippet:');
  console.log(snippet);
  console.log('Add the above to ~/.zshrc (zsh) or ~/.bashrc (bash).');
}

// ── Codex ────────────────────────────────────────────────────
// Codex CLI reads CODEX_STATUS_LINE_CMD if set; otherwise falls
// back to shell-prompt integration like Cursor.
function setupCodex() {
  // If Codex supports a config file, wire it there
  const codexConfig = path.join(HOME, '.codex', 'config.json');
  if (fs.existsSync(path.join(HOME, '.codex'))) {
    mergeJSON(codexConfig, { statusLineCmd: `node ${SCRIPT}` });
    console.log(`✓ Codex: statusLineCmd set in ${codexConfig}`);
  } else {
    console.log('Codex not detected (~/.codex missing).');
    console.log(`  When installed, add to ~/.codex/config.json:`);
    console.log(`  { "statusLineCmd": "node ${SCRIPT}" }`);
  }
}

// ── Config ───────────────────────────────────────────────────
function setupConfig(argv) {
  const cfgPath = path.join(HOME, '.config', 'agent-status', 'config.json');
  const patch   = {};

  const daily  = argv['--budget-daily']  || argv['-d'];
  const weekly = argv['--budget-weekly'] || argv['-w'];
  if (daily)  patch.dailyBudget  = parseFloat(daily);
  if (weekly) patch.weeklyBudget = parseFloat(weekly);

  if (Object.keys(patch).length) {
    mergeJSON(cfgPath, patch);
    console.log(`✓ Config updated: ${cfgPath}`);
    console.log(`  ${JSON.stringify(patch)}`);
  } else if (!fs.existsSync(cfgPath)) {
    // Copy example config on first run
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'config.example.json'), cfgPath);
    console.log(`✓ Default config written to ${cfgPath}`);
    console.log('  Edit it to set your daily/weekly budget limits.');
  }
}

// ── Main ─────────────────────────────────────────────────────
function main() {
  const argv = {};
  let i = 2;
  while (i < process.argv.length) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      argv[a] = process.argv[i + 1] || true;
      i += 2;
    } else {
      argv[a] = true;
      i++;
    }
  }

  const all    = argv['--all']    || Object.keys(argv).length === 0;
  const claude = argv['--claude'] || all;
  const cursor = argv['--cursor'] || all;
  const codex  = argv['--codex']  || all;

  setupConfig(argv);
  if (claude) setupClaudeCode();
  if (cursor) setupCursor();
  if (codex)  setupCodex();

  console.log('\nDone. Restart your agent to pick up the status line.');
}

main();
