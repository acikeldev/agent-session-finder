# CLAUDE.md — Session Finder for Claude Code

VS Code extension: full-text search across local Claude Code sessions (`~/.claude/projects/**/*.jsonl`) with one-click resume in the official Claude Code panel.

## Status
- v0.1.0 works on the author's Windows machine (installed from .vsix). Search, keyboard shortcut and resume confirmed working.
- Tests so far: 18 unit and mocked-VS Code tests (`npm test`), all passing on Windows. **No real VS Code integration tests yet.**
- Publisher: `acikeldev` (VS Code Marketplace and Open VSX). Repo: github.com/acikeldev/agent-session-finder.

## Commands
```bash
npm install
npm test             # tsc + node --test out/test/*.test.js
npm run package      # builds agent-session-finder-<version>.vsix
code --install-extension agent-session-finder-<version>.vsix --force
npm run publish:vsce # VS Code Marketplace (needs `vsce login acikeldev` or VSCE_PAT)
npm run publish:ovsx # Open VSX (needs OVSX_PAT); update the .vsix name in the script when the version changes
pwsh scripts/demo/launch-demo.ps1  # isolated VS Code with fake sessions, for recording media/demo.gif
```
- Package with `--no-dependencies` (the scripts do). The extension has no runtime dependencies, and vsce's npm-based dependency detection breaks when the folder path contains a UUID (npm masks it as `***`).
- Test fixtures that write paths into JSONL must JSON-escape them (`JSON.stringify(p).slice(1, -1)`), or Windows backslashes make the line invalid.

## Architecture
- `src/core/` — pure Node, no `vscode` import, unit-testable
  - `parser.ts` — streaming JSONL parser (`SessionParser`). Format is undocumented; be tolerant. It skips `isSidechain`, `isMeta`, thinking, system-reminder blocks, and attachment records. Titles: `custom-title` > `ai-title` > `summary` > first prompt. Consecutive assistant chunks get merged.
  - `indexer.ts` — `SessionIndex`: incremental rescan by mtime+size, gzip JSON cache in globalStorage (keyed by parse options + `CACHE_VERSION`). Indexes top-level `*.jsonl` only (subagents live in `<session>/subagents/`).
  - `search.ts` — query parser (words AND, "phrase", -exclude, project:, role:user|claude, /regex/) and scoring.
  - `text.ts` — `fold()`: length-preserving case/accent folding (Turkish ı/İ handled), so offsets map back to the original text.
  - `transcript.ts` — Markdown render with message line offsets.
- `src/extension.ts` — QuickPick UI (`alwaysShow` + `sortByLabel=false`; we filter ourselves), transcript content provider, resume logic.

## Resume mechanics (the fragile part)
- Panel: `vscode.env.openExternal(\`${uriScheme}://anthropic.claude-code/open?session=<id>\`)`. This is an undocumented Claude Code URI handler. It only works if the session's `cwd` is the folder open in the window.
- Other folder: write `pending-resume.json` to globalStorage, then `vscode.openFolder` (new window). The new window's `activate()` (`onStartupFinished`) consumes it, waits 2s, and opens the URI. Max age is 3 min.
- Fallback: terminal `claude --resume <id>`.

## Next steps
1. Real integration tests with `@vscode/test-electron` against the author's real sessions (read-only!).
2. Validate the parser against many real session files from different Claude Code versions, especially `custom-title`/`ai-title` field names.
3. Possible features: `fs.watch` live updates, status bar entry, sidebar tree view, date filters (`after:`/`before:`), multi-root workspace edge cases, WSL/remote testing.
4. Publishing: record `media/demo.gif` (README already links it; vsce rewrites the link to the GitHub raw URL, so the GIF must be pushed before publishing), then `npm run publish:vsce` and `npm run publish:ovsx`.

## Rules
- Never write to or delete anything under `~/.claude`. The extension and its tests are read-only there.
- Keep `src/core` free of `vscode` imports.
- No network calls and no telemetry; this is a selling point.
- Naming: the extension ID (`agent-session-finder`), repo name and the `sessionFinder.*` setting/command prefix are deliberately agent-neutral so other agents (e.g. Codex) can be added without breaking installs or user settings. Only `displayName`, keywords and command titles mention Claude Code; change those when another agent is supported.
- Name/branding: independent community extension. Don't use Anthropic logos, and keep the disclaimer in the README.
