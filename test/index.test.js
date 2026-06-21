'use strict';

// NO_COLOR must be set BEFORE requiring index.js — USE_COLOR is captured at
// module load, so this makes paint() a no-op and keeps assertions ANSI-free.
process.env.NO_COLOR = '1';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const {
  fmtDuration, fmtCost, fmtPct, fmtTimeLeft, shortPwd,
  threshLevel, modelLevel, calcCost,
  usageField, budgetField, buildLine, detectAgent,
  isCursorPayload, loadConfig, claudeProjectKey, chooseSource,
} = require('../index.js');

// ─────────────────────────────────────────────────────────────
// fmtDuration
// ─────────────────────────────────────────────────────────────
test('fmtDuration: seconds / minutes / hours', () => {
  assert.equal(fmtDuration(30_000), '30s');
  assert.equal(fmtDuration(90_000), '2m');        // round(1.5)
  assert.equal(fmtDuration(57 * 60_000), '57m');
  assert.equal(fmtDuration(3_600_000), '1.0h');
  assert.equal(fmtDuration(5_400_000), '1.5h');
});

test('fmtDuration: null-ish and negative → null', () => {
  assert.equal(fmtDuration(0), null);
  assert.equal(fmtDuration(null), null);
  assert.equal(fmtDuration(-5), null);
});

// ─────────────────────────────────────────────────────────────
// fmtCost
// ─────────────────────────────────────────────────────────────
test('fmtCost: thresholds and precision', () => {
  assert.equal(fmtCost(0), '<$0.01');
  assert.equal(fmtCost(0.004), '<$0.01');
  assert.equal(fmtCost(5), '$5.00');
  assert.equal(fmtCost(9.99), '$9.99');
  assert.equal(fmtCost(14.8), '$14.8');           // ≥10 drops to 1dp
  assert.equal(fmtCost(null), null);
  assert.equal(fmtCost(undefined), null);
});

// ─────────────────────────────────────────────────────────────
// fmtPct
// ─────────────────────────────────────────────────────────────
test('fmtPct: rounds and guards zero/missing', () => {
  assert.equal(fmtPct(50, 200), '25%');
  assert.equal(fmtPct(84_000, 200_000), '42%');
  assert.equal(fmtPct(0, 100), null);            // !n
  assert.equal(fmtPct(5, 0), null);              // !total
  assert.equal(fmtPct(5, null), null);
});

// ─────────────────────────────────────────────────────────────
// fmtTimeLeft  (countdown, floored)
// ─────────────────────────────────────────────────────────────
test('fmtTimeLeft: minutes floor to at least 1', () => {
  assert.equal(fmtTimeLeft(0), '1m');
  assert.equal(fmtTimeLeft(90_000), '1m');       // 1.5m floors to 1
});

test('fmtTimeLeft: hours and days floor down', () => {
  assert.equal(fmtTimeLeft(7_200_000), '2h');
  assert.equal(fmtTimeLeft(86_400_000), '1d');
  assert.equal(fmtTimeLeft(6.7 * 86_400_000), '6d'); // not 7
});

// ─────────────────────────────────────────────────────────────
// shortPwd
// ─────────────────────────────────────────────────────────────
test('shortPwd: home → ~, deep paths truncate to last 2 segments', () => {
  const home = os.homedir();
  assert.equal(shortPwd(home), '~');
  assert.equal(shortPwd(path.join(home, 'code', 'proj')), '~/code/proj');
  assert.equal(shortPwd(path.join(home, 'a', 'b', 'c')), '…/b/c');
});

// ─────────────────────────────────────────────────────────────
// claudeProjectKey  (cwd → ~/.claude/projects/<key> directory name)
// ─────────────────────────────────────────────────────────────
test('claudeProjectKey: maps cwd to Claude\'s project-dir key per platform', () => {
  if (process.platform === 'win32') {
    // drive colon + every backslash collapse to a dash (C:\a\b → C--a-b)
    assert.equal(claudeProjectKey('C:\\Users\\foo\\bar'), 'C--Users-foo-bar');
    assert.equal(claudeProjectKey('D:\\proj'), 'D--proj');
  } else {
    // every slash becomes a dash, including the leading one (/Users/foo → -Users-foo)
    assert.equal(claudeProjectKey('/Users/foo/bar'), '-Users-foo-bar');
  }
});

// ─────────────────────────────────────────────────────────────
// threshLevel
// ─────────────────────────────────────────────────────────────
test('threshLevel: red above redAt, amber above amberAt, else null', () => {
  assert.equal(threshLevel(60, 50, 30), 'red');
  assert.equal(threshLevel(40, 50, 30), 'amber');
  assert.equal(threshLevel(50, 50, 30), 'amber'); // boundary: not > redAt
  assert.equal(threshLevel(30, 50, 30), null);    // boundary: not > amberAt
  assert.equal(threshLevel(null, 50, 30), null);
});

// ─────────────────────────────────────────────────────────────
// modelLevel
// ─────────────────────────────────────────────────────────────
test('modelLevel: burn tiers by model name', () => {
  assert.equal(modelLevel('claude-opus-4-8'), 'red');
  assert.equal(modelLevel('gpt-5.5'), 'red');
  assert.equal(modelLevel('claude-sonnet-4-6'), 'amber');
  assert.equal(modelLevel('composer-2.5'), 'amber');
  assert.equal(modelLevel('gpt-4o'), null);
  assert.equal(modelLevel(null), null);
});

// ─────────────────────────────────────────────────────────────
// calcCost
// ─────────────────────────────────────────────────────────────
test('calcCost: per-type pricing for a known model', () => {
  // opus-4-8: in 15, out 75, cw 18.75, cr 1.50 per million
  assert.equal(calcCost({ input_tokens: 1_000_000 }, 'claude-opus-4-8'), 15);
  assert.equal(calcCost({ output_tokens: 1_000_000 }, 'claude-opus-4-8'), 75);
  assert.equal(
    calcCost({ cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 },
             'claude-opus-4-8'),
    18.75 + 1.5,
  );
});

test('calcCost: unknown model and empty usage → 0', () => {
  assert.equal(calcCost({ input_tokens: 1_000_000 }, 'no-such-model'), 0);
  assert.equal(calcCost({}, 'claude-opus-4-8'), 0);
});

// ─────────────────────────────────────────────────────────────
// usageField / budgetField
// ─────────────────────────────────────────────────────────────
test('usageField: omits when pct null, appends reset time', () => {
  assert.equal(usageField('s', null, 1000), null);
  assert.equal(usageField('s', 19, null), 's:19%');
  assert.equal(usageField('s', 19, 7_200_000), 's:19% 2h');
});

test('budgetField: null without budget, caps used at budget', () => {
  assert.equal(budgetField('day', 5, null, null), null);
  assert.equal(budgetField('day', 5, 10, null), 'day:50%');
  assert.equal(budgetField('day', 20, 10, null), 'day:100%'); // capped
  assert.equal(budgetField('day', 5, 10, 7_200_000), 'day:50% 2h');
});

// ─────────────────────────────────────────────────────────────
// isCursorPayload  (the render-bleed discriminator)
// ─────────────────────────────────────────────────────────────
test('isCursorPayload: cursor_version is the only Cursor marker', () => {
  assert.equal(isCursorPayload({ cursor_version: '2026.06.19' }), true);
  // context_window is NOT Cursor-exclusive — current Claude Code statusLine
  // payloads also carry it, so it must never on its own mark a payload Cursor.
  assert.equal(isCursorPayload({ context_window: { used_percentage: 12 } }), false);
});

test('isCursorPayload: a real Claude Code payload (with context_window) is NOT Cursor', () => {
  // Mirrors what current Claude Code actually pipes to statusLine on stdin: it
  // now includes a `context_window` object. Keying off context_window rendered
  // every Claude session as Cursor (the bleed bug); only cursor_version is safe.
  const claude = {
    model: { id: 'claude-opus-4-8', display_name: 'Opus' },
    workspace: { current_dir: '/x', project_dir: '/x' },
    session_id: 'abc', transcript_path: '/t', version: '2.1',
    output_style: { name: 'default' }, hook_event_name: 'Status',
    cost: { total_cost_usd: 1 }, exceeds_200k_tokens: false,
    context_window: {
      total_input_tokens: 84_000, context_window_size: 200_000,
      used_percentage: 42, remaining_percentage: 58,
    },
  };
  assert.equal(isCursorPayload(claude), false);
  assert.equal(isCursorPayload({}), false);
  assert.equal(isCursorPayload(null), false);
});

// ─────────────────────────────────────────────────────────────
// chooseSource  (which reader handles this invocation — bleed-proof routing)
//   Claude Code and Cursor BOTH pipe a statusLine payload sharing
//   context_window + transcript_path, so the payload shape can't tell them
//   apart. Claude Code sets CLAUDECODE in env; Cursor never does. Route by env.
// ─────────────────────────────────────────────────────────────
test('chooseSource: Claude payload with context_window routes to Claude (no Cursor bleed)', () => {
  const claudePayload = { transcript_path: '/t', context_window: { used_percentage: 42 } };
  assert.equal(chooseSource('claude-code', claudePayload), 'claude-code');
});

test('chooseSource: Cursor payload (no CLAUDECODE) routes to Cursor (no reverse bleed)', () => {
  // Cursor's payload shares transcript_path/context_window with Claude; the only
  // reliable signal is that CLAUDECODE is absent. Must NOT route to Claude even
  // when env detection misses (agent "unknown").
  const cursorPayload = { transcript_path: '/t', context_window: { used_percentage: 30 } };
  assert.equal(chooseSource('cursor', cursorPayload), 'cursor');
  assert.equal(chooseSource('unknown', cursorPayload), 'cursor');
});

test('chooseSource: explicit cursor_version is always Cursor', () => {
  assert.equal(chooseSource('unknown', { cursor_version: '2026.06' }), 'cursor');
});

test('chooseSource: no payload falls back to env detection', () => {
  assert.equal(chooseSource('claude-code', null), 'claude-code');
  assert.equal(chooseSource('codex', null), 'codex');
  assert.equal(chooseSource('cursor', null), 'cursor');
  assert.equal(chooseSource('unknown', null), 'unknown');
});

// ─────────────────────────────────────────────────────────────
// detectAgent  (env-driven)
// ─────────────────────────────────────────────────────────────
const AGENT_ENV = [
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'OPENAI_CODEX',
  'CURSOR_AGENT', 'CURSOR_CONVERSATION_ID', 'CURSOR_TRACE_ID', 'CURSOR_SESSION_ID',
  'VSCODE_IPC_HOOK_CLI', 'VSCODE_GIT_IPC_HANDLE', 'AI_AGENT',
];
let savedEnv;
beforeEach(() => {
  savedEnv = {};
  for (const k of AGENT_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of AGENT_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test('detectAgent: claude / codex / cursor / unknown', () => {
  assert.equal(detectAgent(), 'unknown');
  process.env.CLAUDE_CODE_SESSION_ID = 'x';
  assert.equal(detectAgent(), 'claude-code');
  delete process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CODEX_SESSION_ID = 'x';
  assert.equal(detectAgent(), 'codex');
  delete process.env.CODEX_SESSION_ID;
  process.env.CURSOR_AGENT = '1';
  assert.equal(detectAgent(), 'cursor');
});

test('detectAgent: AI_AGENT fallback', () => {
  process.env.AI_AGENT = 'cursor-agent';
  assert.equal(detectAgent(), 'cursor');
});

// ─────────────────────────────────────────────────────────────
// buildLine  (assembly; NO_COLOR keeps it ANSI-free)
// ─────────────────────────────────────────────────────────────
test('buildLine: assembles a Claude-style line, strips claude- prefix', () => {
  // a non-git temp dir so getGitBranch returns null deterministically
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-test-'));
  const cfg = loadConfig();
  const line = buildLine({
    agent: 'claude-code',
    model: 'claude-opus-4-8',
    ctxTokens: 84_000,
    ctxWindow: 200_000,
    convDuration: 57 * 60_000,
    convCost: 14.8,
    sessionPct: 19, sessionResetMs: 7_200_000,
    weekPct: 2,     weekResetMs: 6 * 86_400_000,
    cwd: tmp,
  }, cfg);

  assert.match(line, /ctx:42%/);
  assert.match(line, /⏱57m/);
  assert.match(line, /\$14\.8/);
  assert.match(line, /s:19% 2h/);
  assert.match(line, /wk:2% 6d/);
  assert.match(line, /opus-4-8/);
  assert.doesNotMatch(line, /claude-opus/); // prefix stripped
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('buildLine: uses ctxUsedPct directly when present', () => {
  const line = buildLine({ agent: 'cursor', ctxUsedPct: 37.4, cwd: os.tmpdir() }, loadConfig());
  assert.match(line, /ctx:37%/);
});
