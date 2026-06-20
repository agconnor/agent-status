# agent-status

A compact, zero-dependency status line for CLI AI coding agents — **Claude Code**, **Codex**, and **Cursor**. It shows context-window usage, session wall-clock, cost, real rate-limit windows (% consumed + time-to-reset), the active model, working directory, and git branch — color-coded so you can see at a glance when you're running hot.

```
ctx:42% │ ⏱57m │ $14.8 │ s:19% 2h │ wk:2% 6d │ opus-4-8 │ ~/code/proj │ main
```

| Field | Meaning |
|-------|---------|
| `ctx:42%`   | context window consumed |
| `⏱57m`      | conversation wall-clock |
| `$14.8`     | conversation cost (Claude Code) |
| `s:19% 2h`  | 5-hour usage window: % consumed, resets in 2h |
| `wk:2% 6d`  | weekly usage window: % consumed, resets in 6d |
| `cur:26% 12d` | Cursor monthly quota: % consumed, cycle resets in 12d |
| `opus-4-8`  | active model |

Color: **red+bold** when hot (ctx >50%, runtime >3h, window >80%, high-burn model), **amber** when warm (ctx >30%, runtime >2h, window >50%, medium-burn model). Honors `NO_COLOR`.

## Requirements

- **macOS** (reads usage tokens read-only from the login keychain via `security`; reads Cursor IDE sessions via `sqlite3`)
- **Node.js ≥ 18** — found automatically from PATH, Homebrew, nvm, or Cursor's bundled runtime
- `curl` and `sqlite3` (preinstalled on macOS)

## Install

```sh
git clone https://github.com/agconnor/agent-status.git
cd agent-status
sh install.sh                 # wires every agent it detects
sh install.sh --daily 5 --weekly 25   # also set dollar-budget fallbacks
```

The installer:
- sets Claude Code's `statusLine` in `~/.claude/settings.json`
- adds a shell snippet to `~/.zshrc` / `~/.bashrc` for **Cursor Agent** and **Codex** terminals
- sets `statusLineCmd` in `~/.codex/config.json` if Codex is installed
- writes default budget config to `~/.config/agent-status/config.json`

Restart Claude Code and open a new terminal to pick it up.

### Uninstall / reset

```sh
sh install.sh --reset
```

Removes the shell snippet from `~/.zshrc`/`~/.bashrc` and the `statusLine` /
`statusLineCmd` keys from Claude Code and Codex (other settings untouched; your
`~/.config/agent-status/config.json` budgets are kept). **Open a new terminal and
restart Codex / Cursor afterward** — existing sessions already loaded the old
prompt hook and keep printing it until reloaded.

## Wiring it into `agent` (Cursor) and `codex` manually

`install.sh` does this for you, but if you'd rather wire it by hand:

### Cursor Agent (`agent` / `cursor-agent`)

Cursor has no native status-line hook, so it renders through your shell prompt. Add this to `~/.zshrc` (or `~/.bashrc`) — it only fires inside a Cursor terminal:

```sh
# agent-status
if [ -n "$CURSOR_AGENT" ] || [ -n "$CURSOR_TRACE_ID" ] || [ -n "$VSCODE_IPC_HOOK_CLI" ] || [ -n "$CODEX_SESSION_ID" ]; then
  _agent_status_precmd() { /absolute/path/to/agent-status/agent-status 2>/dev/null; }
  if [ -n "$ZSH_VERSION" ]; then
    precmd_functions+=(_agent_status_precmd)
  else
    PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }_agent_status_precmd"
  fi
fi
```

Then `source ~/.zshrc` or open a new terminal. The line prints above each prompt.

### Codex

Point Codex's status-line command at the wrapper in `~/.codex/config.json`:

```json
{ "statusLineCmd": "/absolute/path/to/agent-status/agent-status" }
```

The shell snippet above also covers Codex terminals (it checks `$CODEX_SESSION_ID`), so you get the line either way.

## How it reads usage

All tokens are read **read-only** from the macOS login keychain and never refreshed or written back (writing would force a re-login).

- **Claude Code** — per-session JSONL for ctx/duration/cost; real 5-hour + weekly windows from `GET https://api.anthropic.com/api/oauth/usage`.
- **Codex** — newest `~/.codex/sessions/.../rollout-*.jsonl`; `rate_limits.primary` (5h) + `.secondary` (weekly).
- **Cursor** — session transcript for duration/turns; monthly quota from the Cursor dashboard API.

Network usage endpoints are cached for 60s; file reads for 5s (`$TMPDIR/agent-status-*.json`).

## Config

`~/.config/agent-status/config.json`:

```json
{ "dailyBudget": 5.00, "weeklyBudget": 25.00, "sep": " │ " }
```

Budgets are a dollar-based fallback shown only when a real usage window isn't available. Omit them to hide budget bars.

## License

MIT
