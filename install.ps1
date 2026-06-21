# install.ps1 - one-shot setup for agent-status on Windows
# Usage:  .\install.ps1 [-Daily 5] [-Weekly 25]
#         .\install.ps1 -Reset

param(
  [double]$Daily,
  [double]$Weekly,
  [switch]$Reset
)

$ErrorActionPreference = 'Stop'
$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Binary  = Join-Path $RepoDir 'agent-status.cmd'
$Helper  = Join-Path $RepoDir 'install-helpers.js'
$HomeDir = $env:USERPROFILE

function Write-Ok($msg)   { Write-Host "[ok] $msg" -ForegroundColor Green }
function Write-Info($msg) { Write-Host "  $msg" }
function Write-Warn($msg) { Write-Host "! $msg" -ForegroundColor Yellow }

function Find-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { return $node.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

function Invoke-Helper($cmd, [string[]]$HelperArgs) {
  & $Node $Helper $cmd @HelperArgs
}

function Do-Reset {
  Write-Host 'Removing agent-status wiring...'

  $claudeSettings = Join-Path $HomeDir '.claude\settings.json'
  Invoke-Helper 'json-del-key' @($claudeSettings, 'statusLine')
  if (Test-Path $claudeSettings) { Write-Ok "Claude Code: statusLine cleared from $claudeSettings" }

  $codexCfg = Join-Path $HomeDir '.codex\config.json'
  Invoke-Helper 'json-del-key' @($codexCfg, 'statusLineCmd')
  if (Test-Path $codexCfg) { Write-Ok "Codex: legacy statusLineCmd cleared from $codexCfg" }

  $codexToml = Join-Path $HomeDir '.codex\config.toml'
  if (Test-Path $codexToml) {
    Invoke-Helper 'codex-toml-reset' @($codexToml)
    Write-Ok "Codex: agent-status items removed from $codexToml (restart Codex)"
  }

  $cursorCfg = Join-Path $HomeDir '.cursor\cli-config.json'
  if (Test-Path $cursorCfg) {
    Invoke-Helper 'cursor-status-line-reset' @($cursorCfg)
    Write-Ok "Cursor: statusLine command + footer running-time cleared from $cursorCfg (restart Cursor)"
  }

  $profilePath = $PROFILE.CurrentUserCurrentHost
  if (Test-Path $profilePath) {
    $lines = Get-Content $profilePath
    $out = @(); $skip = $false
    foreach ($line in $lines) {
      if ($line -eq '# agent-status') { $skip = $true; continue }
      if ($skip -and $line -match '^\}$') { $skip = $false; continue }
      if ($skip) { continue }
      $out += $line
    }
    if ($out.Count -ne $lines.Count) {
      Set-Content -Path $profilePath -Value $out -Encoding utf8
      Write-Ok "PowerShell: snippet removed from $profilePath"
    } else {
      Write-Info "PowerShell: nothing to remove in $profilePath"
    }
  }

  Write-Host ""
  Write-Host "Reset complete - the status line is unwired."
  Write-Host "Open a NEW terminal and restart Codex / Cursor."
}

$Node = Find-Node
if (-not $Node) {
  Write-Error 'Node.js not found. Install from https://nodejs.org or run: winget install OpenJS.NodeJS.LTS'
}
Write-Ok "Node found: $Node"

if ($Reset) { Do-Reset; exit 0 }

$claudeDir = Join-Path $HomeDir '.claude'
$claudeSettings = Join-Path $claudeDir 'settings.json'
if (Test-Path $claudeDir) {
  Invoke-Helper 'claude-status-line' @($claudeSettings, $Binary)
  Write-Ok "Claude Code: statusLine set in $claudeSettings"
} else {
  Write-Warn '~\.claude not found - skipping Claude Code setup (not installed?)'
}

$profilePath = $PROFILE.CurrentUserCurrentHost
$marker = '# agent-status'
$snippet = @"

$marker
if (`$env:CURSOR_AGENT -or `$env:CURSOR_TRACE_ID -or `$env:VSCODE_IPC_HOOK_CLI -or `$env:CODEX_SESSION_ID) {
  function global:_agent_status_precmd {
    & '$Binary' 2>`$null
  }
  if (`$null -ne `$ExecutionContext.SessionState.InvokeCommand.GetCommand('prompt', [System.Management.Automation.CommandTypes]::Function)) {
    `$origPrompt = Get-Command prompt
    function global:prompt {
      _agent_status_precmd
      & `$origPrompt
    }
  } else {
    function global:prompt {
      _agent_status_precmd
      "PS `$(`$executionContext.SessionState.Path.CurrentLocation)`$('>' * (`$nestedPromptLevel + 1)) "
    }
  }
}
"@

if (Test-Path $profilePath) {
  if ((Get-Content $profilePath -Raw) -match [regex]::Escape($marker)) {
    Write-Ok "PowerShell: already present in $profilePath"
  } else {
    Add-Content -Path $profilePath -Value $snippet -Encoding utf8
    Write-Ok "PowerShell: snippet added to $profilePath"
  }
} else {
  $profileDir = Split-Path $profilePath -Parent
  if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
  Set-Content -Path $profilePath -Value $snippet.TrimStart() -Encoding utf8
  Write-Ok "PowerShell: profile created at $profilePath"
}

$codexDir = Join-Path $HomeDir '.codex'
if (Test-Path $codexDir) {
  $codexToml = Join-Path $codexDir 'config.toml'
  if (Test-Path $codexToml) { Copy-Item $codexToml "$codexToml.bak.agentstatus" -Force }
  Invoke-Helper 'codex-toml-set' @($codexToml)
  Write-Ok "Codex: [tui].status_line configured in $codexToml (restart Codex to see it)"
} else {
  Write-Info 'Codex not installed (~\.codex missing) - skipping native status-line config'
}

$cursorCfg = Join-Path $HomeDir '.cursor\cli-config.json'
if (Test-Path $cursorCfg) {
  Copy-Item $cursorCfg "$cursorCfg.bak.agentstatus" -Force
  Invoke-Helper 'cursor-status-line' @($cursorCfg, $Binary)
  Write-Ok "Cursor: statusLine command set in $cursorCfg (restart Cursor to see it)"
} else {
  Write-Info 'Cursor not installed (~\.cursor\cli-config.json missing) - skipping status line config'
}

$cfgFile = Join-Path $HomeDir '.config\agent-status\config.json'
if ($Daily -or $Weekly) {
  Invoke-Helper 'config-budget' @($cfgFile, "$Daily", "$Weekly")
  $dailyLabel  = if ($Daily)  { $Daily }  else { 'unchanged' }
  $weeklyLabel = if ($Weekly) { $Weekly } else { 'unchanged' }
  Write-Ok "Config: daily=$dailyLabel weekly=$weeklyLabel -> $cfgFile"
} elseif (-not (Test-Path $cfgFile)) {
  New-Item -ItemType Directory -Path (Split-Path $cfgFile -Parent) -Force | Out-Null
  Copy-Item (Join-Path $RepoDir 'config.example.json') $cfgFile
  Write-Ok "Config: example config written to $cfgFile (edit to set budgets)"
} else {
  Write-Ok "Config: $cfgFile already exists - unchanged"
}

Write-Host ""
Write-Host "Done. Restart Claude Code and open a new terminal to pick up the status line."
