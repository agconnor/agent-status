#!/usr/bin/env node
'use strict';
// Shared install helpers for install.sh / install.ps1
const fs   = require('fs');
const path = require('path');

const [,, cmd, ...rest] = process.argv;

function read(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function write(fp, data) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n');
}

switch (cmd) {
  case 'json-del-key': {
    const [fp, key] = rest;
    const cfg = read(fp);
    if (cfg && key in cfg) { delete cfg[key]; write(fp, cfg); }
    break;
  }
  case 'claude-status-line': {
    const [fp, bin] = rest;
    const cfg = read(fp) || {};
    // Claude Code runs the statusLine command through Git Bash on Windows, and
    // Git Bash eats unquoted backslashes as escapes — `C:\a\b.cmd` becomes
    // `C:ab.cmd` (command not found → silent blank line). Use forward slashes,
    // which both Git Bash and cmd.exe accept.
    cfg.statusLine = { type: 'command', command: bin.replace(/\\/g, '/') };
    write(fp, cfg);
    break;
  }
  case 'codex-toml-set': {
    const [fp] = rest;
    let txt = ''; try { txt = fs.readFileSync(fp, 'utf8'); } catch {}
    const KEYS  = 'status_line = ["model-with-reasoning", "context-used", "five-hour-limit", "weekly-limit", "git-branch", "current-dir"]';
    const COLOR = 'status_line_use_colors = true';
    if (/^\s*status_line\s*=/m.test(txt)) break;
    const lines = txt.split('\n');
    const tuiIdx = lines.findIndex(l => /^\s*\[tui\]\s*$/.test(l));
    if (tuiIdx !== -1) lines.splice(tuiIdx + 1, 0, KEYS, COLOR);
    else {
      const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
      lines.splice(firstTable === -1 ? lines.length : firstTable, 0, '[tui]', KEYS, COLOR, '');
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, lines.join('\n'));
    break;
  }
  case 'codex-toml-reset': {
    const [fp] = rest;
    const OURS = new Set([
      'status_line = ["model-with-reasoning", "context-used", "five-hour-limit", "weekly-limit", "git-branch", "current-dir"]',
      'status_line_use_colors = true',
    ]);
    let txt; try { txt = fs.readFileSync(fp, 'utf8'); } catch { break; }
    fs.writeFileSync(fp, txt.split('\n').filter(l => !OURS.has(l.trim())).join('\n'));
    break;
  }
  case 'cursor-status-line': {
    // Wire the external statusLine command (same shape as Claude Code) plus the
    // built-in footer running-time as a fallback. Mirrors install.sh.
    const [fp, bin] = rest;
    const cfg = read(fp); if (!cfg) break;
    cfg.display = cfg.display || {};
    cfg.display.showStatusLineRunningTime = true;
    if (cfg.statusLine?.command === bin) { write(fp, cfg); break; }  // already wired; persist footer
    cfg.statusLine = { type: 'command', command: bin, padding: 0, updateIntervalMs: 300, timeoutMs: 2000 };
    write(fp, cfg);
    break;
  }
  case 'cursor-status-line-reset': {
    const [fp] = rest;
    const cfg = read(fp); if (!cfg) break;
    let changed = false;
    if (cfg.statusLine?.command && cfg.statusLine.command.includes('agent-status')) {
      delete cfg.statusLine; changed = true;
    }
    if (cfg.display?.showStatusLineRunningTime === true) {
      cfg.display.showStatusLineRunningTime = false; changed = true;
    }
    if (changed) write(fp, cfg);
    break;
  }
  case 'antigravity-status-line': {
    // Antigravity (agy) supports an external statusLine command (Claude-shaped).
    // Forward-slash the path so Git Bash on Windows doesn't eat backslashes.
    const [fp, bin] = rest;
    const cfg = read(fp) || {};
    const cmdPath = bin.replace(/\\/g, '/');
    if (cfg.statusLine?.command === cmdPath) break;  // already wired
    cfg.statusLine = { command: cmdPath, enabled: true };
    write(fp, cfg);
    break;
  }
  case 'antigravity-status-line-reset': {
    const [fp] = rest;
    const cfg = read(fp); if (!cfg) break;
    if (cfg.statusLine?.command && cfg.statusLine.command.includes('agent-status')) {
      delete cfg.statusLine; write(fp, cfg);
    }
    break;
  }
  case 'config-budget': {
    const [fp, daily, weekly] = rest;
    const cfg = read(fp) || {};
    if (daily)  cfg.dailyBudget  = parseFloat(daily);
    if (weekly) cfg.weeklyBudget = parseFloat(weekly);
    write(fp, cfg);
    break;
  }
  default:
    console.error('unknown command:', cmd);
    process.exit(1);
}
