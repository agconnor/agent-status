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
- enables Cursor's footer running-time display (`display.showStatusLineRunningTime`) in `~/.cursor/cli-config.json` — the only customization Cursor's fixed footer exposes (backs up the file first)
- adds a shell snippet to `~/.zshrc` / `~/.bashrc` (a fallback line for plain terminals)
- writes default budget config to `~/.config/agent-status/config.json`

### How each agent renders the status line

**Claude Code**, **Cursor**, and **Antigravity** (`agy`) all support running an external command for their status line, so the `agent-status` script renders the ` │ `-separated layout above directly inside them. **Codex** is the exception — it renders its *own* built-in status line and exposes no external-command hook:

- **Claude Code** — the installer points its `statusLine` command at `agent-status`; renders the full layout.
- **Cursor** — its CLI (`cursor-agent`) accepts an external `statusLine` command in `~/.cursor/cli-config.json` (same payload shape as Claude Code); the installer points it at `agent-status` and also enables `display.showStatusLineRunningTime` as a footer fallback.
- **Antigravity (`agy`)** — the Gemini-CLI successor accepts an external `statusLine` command in `~/.gemini/antigravity-cli/settings.json` (`{ "command": "<bin>", "enabled": true }`); the installer wires it to `agent-status`. *For now agy renders a minimal line (cwd · branch) — full context/usage parsing lands once its stdin payload schema is mapped.*
- **Codex** — no command hook; the installer instead configures its native item list (`[tui].status_line`) to look as close as possible: model+effort · context · usage limits · branch · cwd, in Codex's own `·` style.

The shell snippet only appears in a **plain terminal** that has the agent's env vars set (e.g. the Cursor/VSCode *integrated terminal*); the Codex and `cursor-agent`/`agy` TUIs don't run shell `precmd`, so it never shows *inside* them.

Restart Claude Code and open a new terminal to pick it up.

### Uninstall / reset

```sh
sh install.sh --reset
```

Removes the shell snippet from `~/.zshrc`/`~/.bashrc`, Claude Code's `statusLine`
command, the exact `[tui].status_line` items it added to `~/.codex/config.toml`
(a hand-edited status line is left alone), and turns Cursor's footer running-time
display back off in `~/.cursor/cli-config.json`. Other settings and your
`~/.config/agent-status/config.json` budgets are kept. **Open a new terminal and
restart Codex / Cursor afterward** so they reload. Pre-change backups are saved at
`~/.codex/config.toml.bak.agentstatus` and `~/.cursor/cli-config.json.bak.agentstatus`.

## Wiring it into `agent` (Cursor) and `codex` manually

`install.sh` does this for you, but if you'd rather wire it by hand:

### Cursor Agent (`agent` / `cursor-agent`)

The `cursor-agent` TUI renders a **fixed** built-in footer (`model · context% ·
cwd · branch`). It has no external-command hook and no configurable item list, so
the `agent-status` script **cannot** render inside it. The only thing you can
change is whether the footer shows elapsed running time — set it in
`~/.cursor/cli-config.json`:

```json
{ "display": { "showStatusLineRunningTime": true } }
```

(or use the in-app **`/config`** menu → Editor → *Show status line running time*).
Restart Cursor to pick it up.

If you instead want the full ` │ `-separated `agent-status` line, that's only
possible in a **plain shell** — e.g. the Cursor/VSCode *integrated terminal*,
which (unlike the TUI) runs `precmd`. Add this to `~/.zshrc` (or `~/.bashrc`):

```sh
# agent-status
if [ -n "$VSCODE_IPC_HOOK_CLI" ] || [ -n "$CURSOR_TRACE_ID" ]; then
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
