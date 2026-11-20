# Opens an isolated VS Code window with fake demo sessions, for recording the README GIF.
# Your real ~/.claude and your normal VS Code profile are not touched.
#
# Usage (from the repo root, after `npm run package`):
#   pwsh scripts/demo/launch-demo.ps1 [-DemoRoot <dir>]
param([string]$DemoRoot = (Join-Path $HOME 'csf-demo'))
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$vsix = Join-Path $repo "agent-session-finder-$version.vsix"
if (-not (Test-Path $vsix)) { throw "$vsix not found. Run 'npm run package' first." }

$info = node (Join-Path $PSScriptRoot 'make-demo-data.js') $DemoRoot | ConvertFrom-Json
$data = Join-Path $DemoRoot 'vscode-data'
$exts = Join-Path $DemoRoot 'vscode-ext'
# Start from a clean demo profile every time, so no older build of the extension is installed alongside.
Remove-Item -Recurse -Force $data, $exts -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $data 'User'), $exts | Out-Null

@{
  'workbench.colorTheme' = 'Default Dark Modern'
  'workbench.startupEditor' = 'none'
  'workbench.tips.enabled' = $false
  'workbench.secondarySideBar.defaultVisibility' = 'hidden'
  'window.restoreWindows' = 'none'
  'security.workspace.trust.enabled' = $false
  'telemetry.telemetryLevel' = 'off'
  'update.mode' = 'none'
  'extensions.autoUpdate' = $false
  'extensions.ignoreRecommendations' = $true
  'chat.disableAIFeatures' = $true
  'editor.minimap.enabled' = $false
  'sessionFinder.claudeConfigDirs' = @($info.claudeDir)
} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $data 'User\settings.json')

# Inherited from a VS Code extension host / terminal, these would make Code.exe run as Node
# or hand the window to your already-open VS Code.
Get-ChildItem env: | Where-Object { $_.Name -like 'ELECTRON_*' -or $_.Name -like 'VSCODE_*' } |
  ForEach-Object { Remove-Item "env:$($_.Name)" }

$common = @('--user-data-dir', $data, '--extensions-dir', $exts)
code @common --install-extension $vsix --force
code @common --install-extension anthropic.claude-code

# Claude Code reads its sessions from CLAUDE_CONFIG_DIR, so the panel resumes the demo sessions.
# It has no login there, so the panel may ask you to sign in; the GIF can end on the resumed transcript.
$env:CLAUDE_CONFIG_DIR = $info.claudeDir
code @common --new-window $info.workspace

Write-Host "Demo window opening on $($info.workspace)."
Write-Host "Suggested recording: Ctrl+Alt+Shift+F, type 'backoff jitter', Enter."
