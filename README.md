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
- sets Claude Code's `statusLine` command in `~/.claude/settings.json` (this is the one that runs `agent-status`)
- configures Codex's **native** `[tui].status_line` in `~/.codex/config.toml` to mirror the same layout (backs up the file first)
- adds a shell snippet to `~/.zshrc` / `~/.bashrc` (a fallback line for plain terminals)
- writes default budget config to `~/.config/agent-status/config.json`

### How each agent renders the status line

Only **Claude Code** supports running an external command for its status line, so the `agent-status` script (and the exact ` │ `-separated layout above) is Claude-Code-only. **Codex** and **Cursor** each render their *own* built-in status line and expose no external-command hook — so for Codex the installer configures its native item list to look as close as possible (model+effort · context · usage limits · branch · cwd, in Codex's own `·` style), and Cursor shows its built-in footer. The shell snippet only appears in a plain terminal that has the agent's env vars set; the Codex/Cursor TUIs don't run shell `precmd`, so it never shows *inside* them.

Restart Claude Code and open a new terminal to pick it up.

### Uninstall / reset

```sh
sh install.sh --reset
```

Removes the shell snippet from `~/.zshrc`/`~/.bashrc`, Claude Code's `statusLine`
command, and the exact `[tui].status_line` items it added to `~/.codex/config.toml`
(a hand-edited status line is left alone; other settings and your
`~/.config/agent-status/config.json` budgets are kept). **Open a new terminal and
restart Codex / Cursor afterward** so they reload. A pre-change backup of the Codex
config is saved at `~/.codex/config.toml.bak.agentstatus`.

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

Codex has **no** external-command status-line hook. It renders a built-in status
line from a list of item keys in `~/.codex/config.toml`. To mirror agent-status,
add a `[tui]` section:

```toml
[tui]
status_line = ["model-with-reasoning", "context-used", "five-hour-limit", "weekly-limit", "git-branch", "current-dir"]
status_line_use_colors = true
```

Restart Codex to pick it up (or use the in-app **`/status` → Configure Status Line** menu).

Available item keys: `app-name`, `project-name`, `current-dir`, `run-state`,
`thread-title`, `git-branch`, `context-remaining`, `context-used`,
`five-hour-limit`, `weekly-limit`, `codex-version`, `used-tokens`,
`total-input-tokens`, `total-output-tokens`, `thread-id`, `fast-mode`,
`model-with-reasoning`, `reasoning`, `task-progress`. (Usage-limit items show
the amount *remaining*, which is Codex's convention.)

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
