# Opens an isolated VS Code window with fake demo sessions, for recording the README GIF.
# Your real ~/.claude and your normal VS Code profile are not touched.
#
# Usage (from the repo root, after `npm run package`):
#   pwsh scripts/demo/launch-demo.ps1 [-DemoRoot <dir>]
param([string]$DemoRoot = (Join-Path $HOME 'csf-demo'), [switch]$Fresh)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $repo   # so node resolves @vscode/test-electron from the repo's node_modules
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$vsix = Join-Path $repo "agent-session-finder-$version.vsix"
if (-not (Test-Path $vsix)) { throw "$vsix not found. Run 'npm run package' first." }

$info = node (Join-Path $PSScriptRoot 'make-demo-data.js') $DemoRoot | ConvertFrom-Json
$data = Join-Path $DemoRoot 'vscode-data'
$exts = Join-Path $DemoRoot 'vscode-ext'
# -Fresh wipes the demo VS Code profile (settings, "do not ask again" answers, installed extensions).
# Without it they are kept and only the extension .vsix is reinstalled.
if ($Fresh) { Remove-Item -Recurse -Force $data, $exts -ErrorAction SilentlyContinue }
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

# Use a separate stable VS Code build (downloaded once by @vscode/test-electron), not the installed one:
# the installed VS Code refuses to start a new instance while it has a pending background update.
$exe = node -e "require('@vscode/test-electron').downloadAndUnzipVSCode({version:'stable',cachePath:process.argv[1]}).then(p=>console.log(p))" (Join-Path $DemoRoot 'vscode-portable') |
  Select-Object -Last 1
$cli = Join-Path (Split-Path $exe) 'bin\code.cmd'

$common = @('--user-data-dir', $data, '--extensions-dir', $exts)
& $cli @common --install-extension $vsix --force
& $cli @common --install-extension anthropic.claude-code

# Claude Code reads its sessions from CLAUDE_CONFIG_DIR, so the panel resumes the demo sessions.
# It has no login there, so the panel may ask you to sign in; the GIF can end on the resumed transcript.
$env:CLAUDE_CONFIG_DIR = $info.claudeDir
Start-Process -FilePath $exe -ArgumentList ($common + @('--new-window', $info.workspace))

Write-Host "Demo window opening on $($info.workspace)."
Write-Host "Suggested recording: Ctrl+Alt+Shift+F, type 'backoff jitter', Enter."
