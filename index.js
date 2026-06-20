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

function fmtTimeLeft(ms) {
  // countdown — floor so "resets in 6.7d" shows 6d, not 7d
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 3600)  return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function shortPwd(p) {
  const home = os.homedir();
  const rel  = p.startsWith(home) ? '~' + p.slice(home.length) : p;
  // Truncate deeply nested paths: keep last 2 segments after ~
  const parts = rel.split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : rel;
}

// ─────────────────────────────────────────────────────────────
// Color coding  (red+bold = hot, amber = warm; honors NO_COLOR)
// ─────────────────────────────────────────────────────────────

const COLORS    = { red: '\x1b[1;31m', amber: '\x1b[38;5;214m' };
const RESET     = '\x1b[0m';
const USE_COLOR = !process.env.NO_COLOR;

// burn-tier classification by model name (user-confirmed: sonnet=amber)
const MODEL_TIER = {
  red:   [/opus/i, /gpt-5\.5/i],
  amber: [/gpt-5\.4/i, /composer-2\.5/i, /sonnet/i],
};

function paint(text, level) {
  if (!level || !USE_COLOR || !COLORS[level]) return text;
  return COLORS[level] + text + RESET;
}

// value > redAt → red; value > amberAt → amber; else no color
function threshLevel(value, redAt, amberAt) {
  if (value == null) return null;
  if (value > redAt)   return 'red';
  if (value > amberAt) return 'amber';
  return null;
}

function modelLevel(model) {
  if (!model) return null;
  if (MODEL_TIER.red.some(r => r.test(model)))   return 'red';
  if (MODEL_TIER.amber.some(r => r.test(model))) return 'amber';
  return null;
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

const CACHE_TTL_MS       = 5_000;
const USAGE_CACHE_TTL_MS = 60_000;  // network usage endpoint — poll at most once/min

function cacheRead(key, ttl = CACHE_TTL_MS) {
  const file = path.join(os.tmpdir(), `agent-status-${key}.json`);
  try {
    const raw  = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - raw._ts < ttl) return raw;
  } catch {}
  return null;
}

function cacheWrite(key, data) {
  const file = path.join(os.tmpdir(), `agent-status-${key}.json`);
  try { fs.writeFileSync(file, JSON.stringify({ ...data, _ts: Date.now() })); } catch {}
}

// ─────────────────────────────────────────────────────────────
// Claude subscription usage (the same %s shown by /usage)
//   GET /api/oauth/usage → five_hour + seven_day windows, each
//   { utilization: 0–100 (% consumed), resets_at: ISO8601 }
//   Token read READ-ONLY from the login keychain — never refreshed
//   or written back (that would force a Claude Code re-login).
// ─────────────────────────────────────────────────────────────

function readClaudeUsage() {
  const cached = cacheRead('claude-usage', USAGE_CACHE_TTL_MS);
  if (cached) return cached;

  // 1. Read the OAuth access token from the macOS keychain (read-only)
  let token = null;
  try {
    const raw = execFileSync('security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-a', os.userInfo().username, '-w'],
      { encoding: 'utf8', timeout: 1000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    token = JSON.parse(raw)?.claudeAiOauth?.accessToken || null;
  } catch { return null; }
  if (!token) return null;

  // 2. Hit the usage endpoint via curl (keeps this path synchronous, zero-dep)
  let body;
  try {
    body = execFileSync('curl',
      ['-s', '--max-time', '3', 'https://api.anthropic.com/api/oauth/usage',
       '-H', `Authorization: Bearer ${token}`,
       '-H', 'anthropic-beta: oauth-2025-04-20',
       '-H', 'anthropic-version: 2023-06-01'],
      { encoding: 'utf8', timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { return null; }

  let json;
  try { json = JSON.parse(body); } catch { return null; }

  const fh = json.five_hour, sd = json.seven_day;
  if (!fh && !sd) return null;  // 401 / unexpected shape

  const now  = Date.now();
  const toMs = iso => { const t = Date.parse(iso); return Number.isNaN(t) ? null : Math.max(0, t - now); };

  const result = {
    sessionPct:     fh ? Math.round(fh.utilization) : null,
    sessionResetMs: fh ? toMs(fh.resets_at)         : null,
    weekPct:        sd ? Math.round(sd.utilization) : null,
    weekResetMs:    sd ? toMs(sd.resets_at)         : null,
  };
  cacheWrite('claude-usage', result);
  return result;
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
    ...(readClaudeUsage() || {}),  // real session/weekly utilization windows
  };
  cacheWrite(`cc-${sessionId}`, result);
  return result;
}

// ─────────────────────────────────────────────────────────────
// Codex (OpenAI Codex CLI) reader
//   Reads ~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl — the JSONL
//   Codex writes per session. The `token_count` event_msg carries
//   `rate_limits` (primary = 5h window, secondary = weekly), each
//   { used_percent, window_minutes, resets_at(unix s) }, plus the
//   live token usage and model_context_window.
// ─────────────────────────────────────────────────────────────

function findCodexRollout(sessionId) {
  const base = path.join(os.homedir(), '.codex', 'sessions');
  let newest = null, newestMtime = 0;
  const walk = (dir, depth) => {
    for (const name of safeReaddirSync(dir)) {
      const fp = path.join(dir, name);
      if (depth < 3) {
        let hit = null;
        try { if (fs.statSync(fp).isDirectory()) hit = walk(fp, depth + 1); } catch {}
        if (hit) return hit;  // propagate session-id match up the recursion
      } else if (/^rollout-.*\.jsonl$/.test(name)) {
        if (sessionId && name.includes(sessionId)) return fp;  // exact match wins
        try {
          const m = fs.statSync(fp).mtimeMs;
          if (m > newestMtime) { newestMtime = m; newest = fp; }
        } catch {}
      }
    }
    return null;
  };
  return walk(base, 0) || newest;
}

function readCodex() {
  const sessionId = process.env.CODEX_SESSION_ID;
  const cacheKey  = `codex-${sessionId || 'latest'}`;
  const cached    = cacheRead(cacheKey);
  if (cached) return cached;

  const rollout = findCodexRollout(sessionId);
  let model = null, ctxTokens = null, ctxWindow = null;
  let firstTs = null, lastTs = null, rl = null;

  if (rollout) {
    try {
      const lines = fs.readFileSync(rollout, 'utf8').trim().split('\n');
      for (const line of lines) {
        let d; try { d = JSON.parse(line); } catch { continue; }

        const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
        if (!Number.isNaN(ts)) {
          if (firstTs === null) firstTs = ts;
          lastTs = ts;
        }

        const p = d.payload || {};
        if (d.type === 'turn_context' && p.model) model = p.model;
        if (d.type === 'event_msg' && p.type === 'token_count' && p.info) {
          const last = p.info.last_token_usage || p.info.total_token_usage;
          if (last) ctxTokens = last.input_tokens || null;       // current context occupancy
          if (p.info.model_context_window) ctxWindow = p.info.model_context_window;
          if (p.rate_limits) rl = p.rate_limits;                 // keep most recent
        }
      }
    } catch {}
  }

  const now  = Date.now();
  const toMs = sec => (sec ? Math.max(0, sec * 1000 - now) : null);

  const result = {
    agent: 'codex',
    model,
    ctxTokens,
    ctxWindow,
    convDuration: firstTs && lastTs ? lastTs - firstTs : null,
    convCost: null,
    sessionPct:     rl?.primary   ? Math.round(rl.primary.used_percent)   : null,
    sessionResetMs: rl?.primary   ? toMs(rl.primary.resets_at)            : null,
    weekPct:        rl?.secondary ? Math.round(rl.secondary.used_percent) : null,
    weekResetMs:    rl?.secondary ? toMs(rl.secondary.resets_at)          : null,
  };
  cacheWrite(cacheKey, result);
  return result;
}

// ─────────────────────────────────────────────────────────────
// Cursor reader
// ─────────────────────────────────────────────────────────────

function readCursorAgent() {
  // Cursor Agent mode: session data lives in AGENT_TRANSCRIPTS/<convId>/<convId>.jsonl
  const transcriptDir = process.env.AGENT_TRANSCRIPTS;
  const convId        = process.env.CURSOR_CONVERSATION_ID;
  if (!transcriptDir || !convId) return {};

  const cached = cacheRead(`cursor-${convId}`);
  if (cached) return cached;

  const jsonlPath = path.join(transcriptDir, convId, `${convId}.jsonl`);
  let convDuration = null, turns = 0;

  try {
    const stat      = fs.statSync(jsonlPath);
    const startTime = stat.birthtimeMs || stat.ctimeMs;
    convDuration    = Date.now() - startTime;

    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    for (const line of lines) {
      try { if (JSON.parse(line).role === 'assistant') turns++; } catch {}
    }
  } catch {}

  const result = { agent: 'cursor', agentLabel: 'cursor', model: null, convDuration, turns,
                   ctxTokens: null, ctxWindow: null,
                   convCost: null, todayCost: null, weekCost: null };
  cacheWrite(`cursor-${convId}`, result);
  return result;
}

function readCursorIde() {
  // Cursor IDE (Composer) mode: session data in ~/.cursor/chats/*/store.db
  let convDuration = null, model = null;

  const chatsDir = path.join(os.homedir(), '.cursor', 'chats');
  let newestMtime = 0, newestDb = null;

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
      const out = execFileSync('sqlite3', [newestDb,
        "SELECT value FROM meta WHERE key='0' LIMIT 1;"],
        { encoding: 'utf8', timeout: 1000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (out) {
        const meta = JSON.parse(Buffer.from(out, 'hex').toString('utf8'));
        if (meta.createdAt)     convDuration = Date.now() - meta.createdAt;
        if (meta.lastUsedModel) model = meta.lastUsedModel;
      }
    } catch {}
  }

  return { agent: 'cursor', model, convDuration, turns: null,
           ctxTokens: null, ctxWindow: null,
           convCost: null, todayCost: null, weekCost: null };
}

// Cursor monthly usage quota (the % the dashboard shows).
//   GetPlanInfo            → includedAmountCents + billingCycleEnd + planName
//   GetAggregatedUsageEvents → totalCostCents consumed this cycle
//   Connect-protocol JSON over POST; token read READ-ONLY from keychain.
function readCursorUsage() {
  const cached = cacheRead('cursor-usage', USAGE_CACHE_TTL_MS);
  if (cached) return cached;

  let token = null;
  try {
    token = execFileSync('security',
      ['find-generic-password', '-s', 'cursor-access-token', '-w'],
      { encoding: 'utf8', timeout: 1000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return null; }
  if (!token) return null;

  const post = (method) => {
    try {
      return JSON.parse(execFileSync('curl',
        ['-s', '--max-time', '4', '-X', 'POST',
         `https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`,
         '-H', `authorization: Bearer ${token}`,
         '-H', 'content-type: application/json',
         '-H', 'connect-protocol-version: 1',
         '--data', '{}'],
        { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }));
    } catch { return null; }
  };

  const info = post('GetPlanInfo')?.planInfo;
  const agg  = post('GetAggregatedUsageEvents');
  if (!info || !agg) return null;

  const included = Number(info.includedAmountCents) || 0;
  const used     = Number(agg.totalCostCents)       || 0;
  const end      = Number(info.billingCycleEnd)     || 0;

  const result = {
    cursorPlan:    info.planName || null,
    cursorPct:     included ? Math.round(used / included * 100) : null,
    cursorResetMs: end ? Math.max(0, end - Date.now()) : null,
  };
  cacheWrite('cursor-usage', result);
  return result;
}

function readCursor() {
  const base = (process.env.CURSOR_AGENT === '1' || process.env.CURSOR_CONVERSATION_ID)
    ? readCursorAgent()
    : readCursorIde();
  return { ...base, ...(readCursorUsage() || {}) };
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
  if (process.env.CURSOR_AGENT === '1' || process.env.CURSOR_CONVERSATION_ID) return 'cursor';
  if (process.env.CURSOR_TRACE_ID  || process.env.CURSOR_SESSION_ID)    return 'cursor';
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
// Usage window  e.g.  s:18% 2h  (% consumed, time until reset)
// ─────────────────────────────────────────────────────────────

function usageField(label, pctUsed, resetMs) {
  if (pctUsed == null) return null;
  const time = resetMs != null ? ` ${fmtTimeLeft(resetMs)}` : '';
  return `${label}:${pctUsed}%${time}`;
}

// Dollar-budget fallback (non-Claude agents, or when /usage is unreachable)
// Shows % of budget consumed + time until the window rolls over.
function budgetField(label, used, budget, timeLeftMs) {
  if (!budget) return null;
  const pct  = Math.round(Math.min(used ?? 0, budget) / budget * 100);
  const time = timeLeftMs != null ? ` ${fmtTimeLeft(timeLeftMs)}` : '';
  return `${label}:${pct}%${time}`;
}

// ─────────────────────────────────────────────────────────────
// Assemble status line
// ─────────────────────────────────────────────────────────────

function buildLine(data, cfg) {
  const fields = [];

  const push = (v) => { if (v !== null && v !== undefined) fields.push(v); };

  // Agent label fallback (e.g. Cursor Agent new session before JSONL exists)
  if (data.agentLabel && !data.convDuration && !data.ctxTokens) push(data.agentLabel);

  // Context window  (amber >30%, red >50%)
  const ctxPct = data.ctxWindow ? (data.ctxTokens / data.ctxWindow) * 100 : null;
  if (fmtPct(data.ctxTokens, data.ctxWindow)) {
    push(paint(`ctx:${fmtPct(data.ctxTokens, data.ctxWindow)}`, threshLevel(ctxPct, 50, 30)));
  }

  // Conversation wall-clock  (amber >2h, red >3h)
  const dur = fmtDuration(data.convDuration);
  if (dur) {
    const hrs = data.convDuration / 3_600_000;
    push(paint(`⏱${dur}`, threshLevel(hrs, 3, 2)));
  }

  // Turn count (Cursor Agent only)
  if (data.turns > 0) push(`${data.turns}t`);

  // Conversation cost
  push(data.convCost > 0 ? fmtCost(data.convCost) : null);

  // Session window (5h) — prefer real utilization; else dollar fallback
  //   (amber >50%, red >80%)
  if (data.sessionPct != null) {
    push(paint(usageField('s', data.sessionPct, data.sessionResetMs),
               threshLevel(data.sessionPct, 80, 50)));
  } else if (cfg.dailyBudget && data.todayCost != null) {
    const now = new Date();
    const midnight = new Date(now); midnight.setHours(24, 0, 0, 0);
    push(budgetField('day', data.todayCost, cfg.dailyBudget, midnight - now));
  }

  // Weekly window — prefer real utilization; else dollar fallback
  //   (amber >50%, red >80%)
  if (data.weekPct != null) {
    push(paint(usageField('wk', data.weekPct, data.weekResetMs),
               threshLevel(data.weekPct, 80, 50)));
  } else if (cfg.weeklyBudget && data.weekCost != null) {
    const now = new Date();
    const dow = now.getDay();
    const daysUntilMon = dow === 0 ? 1 : dow === 1 ? 7 : 8 - dow;
    const nextMon = new Date(now); nextMon.setDate(now.getDate() + daysUntilMon); nextMon.setHours(0, 0, 0, 0);
    push(budgetField('wk', data.weekCost, cfg.weeklyBudget, nextMon - now));
  }

  // Cursor monthly quota (subscription)  (amber >50%, red >80%)
  if (data.cursorPct != null) {
    const t = data.cursorResetMs != null ? ` ${fmtTimeLeft(data.cursorResetMs)}` : '';
    push(paint(`cur:${data.cursorPct}%${t}`, threshLevel(data.cursorPct, 80, 50)));
  }

  // Model  (red = high-burn e.g. opus/gpt-5.5; amber = medium e.g. gpt-5.4/sonnet/composer-2.5)
  if (data.model) push(paint(data.model.replace(/^claude-/, ''), modelLevel(data.model)));

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
