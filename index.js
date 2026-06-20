#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');

// ─────────────────────────────────────────────────────────────
// Model catalogue  (prices per million tokens)
// ─────────────────────────────────────────────────────────────
const MODELS = {
  // Claude
  'claude-opus-4-8':            { in: 15.00, out: 75.00, cw: 18.75, cr:  1.50, ctx: 200_000 },
  'claude-opus-4-7':            { in: 15.00, out: 75.00, cw: 18.75, cr:  1.50, ctx: 200_000 },
  'claude-sonnet-4-6':          { in:  3.00, out: 15.00, cw:  3.75, cr:  0.30, ctx: 200_000 },
  'claude-haiku-4-5-20251001':  { in:  0.80, out:  4.00, cw:  1.00, cr:  0.08, ctx: 200_000 },
  // OpenAI / Codex
  'gpt-4o':                     { in:  2.50, out: 10.00, cw:  0,    cr:  1.25, ctx: 128_000 },
  'gpt-4o-mini':                { in:  0.15, out:  0.60, cw:  0,    cr:  0.075,ctx: 128_000 },
  'o3':                         { in: 10.00, out: 40.00, cw:  0,    cr:  5.00, ctx: 200_000 },
  'o4-mini':                    { in:  1.10, out:  4.40, cw:  0,    cr:  0.275,ctx: 200_000 },
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function fmtCost(usd) {
  if (usd === null || usd === undefined) return null;
  if (usd < 0.005) return '<$0.01';
  if (usd < 10)    return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(1)}`;
}

function fmtPct(n, total) {
  if (!total || !n) return null;
  return `${Math.round((n / total) * 100)}%`;
}

function shortPwd(p) {
  const home = os.homedir();
  const rel  = p.startsWith(home) ? '~' + p.slice(home.length) : p;
  // Truncate deeply nested paths: keep last 2 segments after ~
  const parts = rel.split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : rel;
}

function calcCost(usage, model) {
  const p = MODELS[model];
  if (!p) return 0;
  const M = 1_000_000;
  return (usage.input_tokens                || 0) * p.in  / M
       + (usage.output_tokens               || 0) * p.out / M
       + (usage.cache_creation_input_tokens || 0) * p.cw  / M
       + (usage.cache_read_input_tokens     || 0) * p.cr  / M;
}

function getGitBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8', timeout: 500, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────
// Short-lived file cache (avoids re-reading JSONL every second)
// ─────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5_000;

function cacheRead(key) {
  const file = path.join(os.tmpdir(), `agent-status-${key}.json`);
  try {
    const raw  = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - raw._ts < CACHE_TTL_MS) return raw;
  } catch {}
  return null;
}

function cacheWrite(key, data) {
  const file = path.join(os.tmpdir(), `agent-status-${key}.json`);
  try { fs.writeFileSync(file, JSON.stringify({ ...data, _ts: Date.now() })); } catch {}
}

// ─────────────────────────────────────────────────────────────
// Claude Code reader
// ─────────────────────────────────────────────────────────────

function readClaudeCode() {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return {};

  const cached = cacheRead(`cc-${sessionId}`);
  if (cached) return cached;

  const home       = os.homedir();
  const projectKey = process.cwd().replace(/\//g, '-');
  const jsonlPath  = path.join(home, '.claude', 'projects', projectKey, `${sessionId}.jsonl`);

  let firstTs = null, lastTs = null, totalCost = 0;
  let lastModel = null, ctxTokens = 0;

  try {
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : null;
      if (ts) {
        if (firstTs === null || ts < firstTs) firstTs = ts;
        if (lastTs  === null || ts > lastTs)  lastTs  = ts;
      }

      const usage = entry.message?.usage;
      const model = entry.message?.model;
      if (usage && model) {
        lastModel = model;
        totalCost += calcCost(usage, model);
        // Total tokens currently in context for this turn
        ctxTokens = (usage.input_tokens                || 0)
                  + (usage.cache_read_input_tokens     || 0)
                  + (usage.cache_creation_input_tokens || 0);
      }
    }
  } catch { /* session file not yet created or unreadable */ }

  // Weekly + daily cost from stats-cache
  let weekCost = 0, todayCost = 0;
  const statsPath = path.join(home, '.claude', 'stats-cache.json');
  const stats = readJSON(statsPath);
  if (stats?.dailyModelTokens) {
    const now       = Date.now();
    const todayStr  = new Date().toISOString().slice(0, 10);
    const dayOfWeek = new Date().getDay();
    const daysSinceMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    for (const day of stats.dailyModelTokens) {
      const daysAgo = Math.round((now - new Date(day.date + 'T12:00:00Z').getTime()) / 86_400_000);
      let dayCost = 0;
      for (const [model, tokens] of Object.entries(day.tokensByModel || {})) {
        // stats-cache only stores total tokens without input/output split;
        // use 15% output as a rough heuristic (conservative estimate)
        const p = MODELS[model];
        if (p) dayCost += (tokens * 0.85) * p.in / 1_000_000
                        + (tokens * 0.15) * p.out / 1_000_000;
      }
      if (daysAgo <= daysSinceMon) weekCost += dayCost;
      if (day.date === todayStr)   todayCost = dayCost;
    }
  }

  const result = {
    agent: 'claude-code',
    model: lastModel,
    ctxTokens,
    ctxWindow: lastModel ? (MODELS[lastModel]?.ctx ?? null) : null,
    convDuration: firstTs && lastTs ? lastTs - firstTs : null,
    convCost: totalCost,
    todayCost,
    weekCost,
  };
  cacheWrite(`cc-${sessionId}`, result);
  return result;
}

// ─────────────────────────────────────────────────────────────
// Codex (OpenAI Codex CLI) reader
// ─────────────────────────────────────────────────────────────

function readCodex() {
  const sessionId = process.env.CODEX_SESSION_ID;
  const model     = process.env.OPENAI_MODEL || process.env.CODEX_MODEL || 'o4-mini';

  // Codex stores state in ~/.codex/
  const home    = os.homedir();
  const usageFp = path.join(home, '.codex', 'usage.json');
  const usage   = readJSON(usageFp);

  return {
    agent: 'codex',
    model,
    ctxTokens:   usage?.context_tokens   ?? null,
    ctxWindow:   MODELS[model]?.ctx      ?? 128_000,
    convDuration:usage?.duration_ms      ?? null,
    convCost:    usage?.session_cost_usd ?? null,
    todayCost:   usage?.today_cost_usd   ?? null,
    weekCost:    usage?.week_cost_usd    ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// Cursor reader  (reads ~/.cursor/chats SQLite databases)
// ─────────────────────────────────────────────────────────────

function readCursor() {
  // Cursor uses subscription pricing — no per-token cost to report.
  // What we can reliably get: conversation start time from store.db meta.
  let convDuration = null;
  let model        = null;

  const home     = os.homedir();
  const chatsDir = path.join(home, '.cursor', 'chats');

  if (fs.existsSync(chatsDir)) {
    // Walk workspace dirs → session dirs → store.db
    // Take the most-recently-modified store.db
    let newestMtime = 0;
    let newestDb    = null;

    for (const wsId of safeReaddirSync(chatsDir)) {
      const wsDir = path.join(chatsDir, wsId);
      for (const sessId of safeReaddirSync(wsDir)) {
        const dbPath = path.join(wsDir, sessId, 'store.db');
        try {
          const stat = fs.statSync(dbPath);
          if (stat.mtimeMs > newestMtime) { newestMtime = stat.mtimeMs; newestDb = dbPath; }
        } catch {}
      }
    }

    if (newestDb) {
      try {
        // Use sqlite3 CLI to read the meta row (avoids native module dependency)
        const out = execFileSync('sqlite3', [newestDb,
          "SELECT value FROM meta WHERE key='0' LIMIT 1;"],
          { encoding: 'utf8', timeout: 1000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

        if (out) {
          const meta = JSON.parse(Buffer.from(out, 'hex').toString('utf8'));
          if (meta.createdAt) convDuration = Date.now() - meta.createdAt;
          if (meta.lastUsedModel) model = meta.lastUsedModel;
        }
      } catch {}
    }
  }

  return { agent: 'cursor', model, convDuration, ctxTokens: null, ctxWindow: null,
           convCost: null, todayCost: null, weekCost: null };
}

function safeReaddirSync(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// ─────────────────────────────────────────────────────────────
// Agent detection
// ─────────────────────────────────────────────────────────────

function detectAgent() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_SESSION_ID) return 'claude-code';
  if (process.env.CODEX_SESSION_ID || process.env.OPENAI_CODEX === '1') return 'codex';
  if (process.env.CURSOR_TRACE_ID  || process.env.CURSOR_SESSION_ID)    return 'cursor';
  // Cursor terminals often have TERM_PROGRAM=iTerm2 but also expose VSCODE_*
  if (process.env.VSCODE_IPC_HOOK_CLI || process.env.VSCODE_GIT_IPC_HANDLE) return 'cursor';
  const ai = process.env.AI_AGENT || '';
  if (ai.includes('claude')) return 'claude-code';
  if (ai.includes('codex'))  return 'codex';
  if (ai.includes('cursor')) return 'cursor';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

function loadConfig() {
  const fp = path.join(os.homedir(), '.config', 'agent-status', 'config.json');
  const defaults = {
    dailyBudget:  null,   // e.g. 5.00  (USD) — omit to hide budget bars
    weeklyBudget: null,   // e.g. 25.00 (USD)
    sep:          ' │ ',  // field separator
  };
  return Object.assign(defaults, readJSON(fp) || {});
}

// ─────────────────────────────────────────────────────────────
// Budget bar  e.g.  $1.20/$5.00  or  $1.20 (80% left)
// ─────────────────────────────────────────────────────────────

function budgetField(label, used, budget) {
  if (used === null && !budget) return null;
  const usedFmt = fmtCost(used ?? 0);
  if (!budget) return `${label}:${usedFmt}`;
  const rem  = Math.max(0, budget - (used ?? 0));
  const pct  = Math.round(rem / budget * 100);
  return `${label}:${usedFmt}/${fmtCost(budget)} (${pct}% left)`;
}

// ─────────────────────────────────────────────────────────────
// Assemble status line
// ─────────────────────────────────────────────────────────────

function buildLine(data, cfg) {
  const fields = [];

  const push = (v) => { if (v !== null && v !== undefined) fields.push(v); };

  // Context window
  push(fmtPct(data.ctxTokens, data.ctxWindow)
    ? `ctx:${fmtPct(data.ctxTokens, data.ctxWindow)}` : null);

  // Conversation wall-clock
  const dur = fmtDuration(data.convDuration);
  push(dur ? `⏱${dur}` : null);

  // Conversation cost
  push(data.convCost > 0 ? fmtCost(data.convCost) : null);

  // Daily usage / budget
  push(budgetField('day', data.todayCost, cfg.dailyBudget));

  // Weekly usage / budget
  push(budgetField('wk', data.weekCost, cfg.weeklyBudget));

  // PWD
  push(shortPwd(process.cwd()));

  // Git branch
  push(getGitBranch());

  return fields.join(cfg.sep);
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

function main() {
  const agent = detectAgent();
  const cfg   = loadConfig();

  let data = {};
  if      (agent === 'claude-code') data = readClaudeCode();
  else if (agent === 'codex')       data = readCodex();
  else if (agent === 'cursor')      data = readCursor();
  else {
    // Outside any agent — show git + pwd only (useful for testing)
    data = { agent: 'unknown' };
  }

  const line = buildLine(data, cfg);
  process.stdout.write(line + '\n');
}

main();
