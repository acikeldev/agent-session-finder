import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SessionIndex, IndexedSession } from './core/indexer';
import { parseQuery, search, recentSessions, SearchHit } from './core/search';
import { defaultClaudeDir, expandHome, projectLabel, samePath } from './core/paths';
import { renderTranscript } from './core/transcript';
import { ParseOptions } from './core/types';

const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';
const TRANSCRIPT_SCHEME = 'session-finder';
const PENDING_RESUME_FILE = 'pending-resume.json';
const PENDING_RESUME_MAX_AGE_MS = 3 * 60_000;

let index: SessionIndex | undefined;
let indexReady: Promise<void> | undefined;
let output: vscode.OutputChannel;
let storageDir: string;

// ───────────────────────────── configuration ─────────────────────────────

function cfg() {
  const c = vscode.workspace.getConfiguration('sessionFinder');
  const dirs = (c.get<string[]>('claudeConfigDirs') ?? []).map((d) => expandHome(d.trim())).filter(Boolean);
  return {
    claudeDirs: dirs.length ? dirs : [defaultClaudeDir()],
    includeToolContent: c.get<boolean>('includeToolContent', false),
    resumeTarget: c.get<'panel' | 'terminal'>('resumeTarget', 'panel'),
    terminalCommand: c.get<string>('terminalCommand', 'claude --resume ${sessionId}'),
    persistIndex: c.get<boolean>('persistIndex', true),
    maxResults: c.get<number>('maxResults', 200),
  };
}

function parseOptions(): ParseOptions {
  return { includeToolContent: cfg().includeToolContent, maxCharsPerMessage: 20000 };
}

function createIndex(): SessionIndex {
  const c = cfg();
  const projectsDirs = c.claudeDirs.map((d) => path.join(d, 'projects'));
  const cacheFile = c.persistIndex ? path.join(storageDir, 'index-cache.json.gz') : undefined;
  return new SessionIndex(projectsDirs, parseOptions(), cacheFile);
}

function ensureIndex(): { idx: SessionIndex; ready: Promise<void> } {
  if (!index) {
    index = createIndex();
    const idx = index;
    indexReady = (async () => {
      const cached = await idx.loadCache();
      output.appendLine(`Loaded ${cached} sessions from cache.`);
    })();
  }
  return { idx: index, ready: indexReady! };
}

async function refreshIndex(onProgress?: (msg: string) => void): Promise<void> {
  const { idx, ready } = ensureIndex();
  await ready;
  const res = await idx.scan((p) => onProgress?.(`Indexing ${p.done}/${p.total} session files…`));
  output.appendLine(
    `Scan: ${res.total} sessions, ${res.parsed} (re)parsed, ${res.removed} removed, ${res.errors} errors, ${res.durationMs} ms`,
  );
}

// ───────────────────────────── helpers ─────────────────────────────

function relativeTime(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24); if (d < 30) return `${d} d ago`;
  return new Date(t).toLocaleDateString();
}

function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

function sessionBelongsToThisWindow(s: IndexedSession): boolean {
  return workspaceFolderPaths().some((f) => samePath(f, s.doc.cwd));
}

function folderExists(p?: string): boolean {
  if (!p) return false;
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ───────────────────────────── resume ─────────────────────────────

function claudeCodeUri(sessionId: string): vscode.Uri {
  return vscode.Uri.parse(`${vscode.env.uriScheme}://${CLAUDE_CODE_EXTENSION_ID}/open?session=${encodeURIComponent(sessionId)}`);
}

async function openInClaudePanel(sessionId: string): Promise<boolean> {
  const ext = vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID);
  if (!ext) return false;
  if (!ext.isActive) {
    try { await ext.activate(); } catch { /* the URI handler activates it anyway */ }
  }
  output.appendLine(`Opening session ${sessionId} in the Claude Code panel.`);
  return vscode.env.openExternal(claudeCodeUri(sessionId));
}

function resumeInTerminal(s: IndexedSession): void {
  const cmd = cfg().terminalCommand.replace(/\$\{sessionId\}/g, s.doc.sessionId);
  const cwd = folderExists(s.doc.cwd) ? s.doc.cwd : undefined;
  const term = vscode.window.createTerminal({ name: `Claude: ${s.doc.title.slice(0, 40)}`, cwd });
  term.show();
  term.sendText(cmd);
}

async function writePendingResume(sessionId: string, cwd: string): Promise<void> {
  await fs.promises.mkdir(storageDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(storageDir, PENDING_RESUME_FILE),
    JSON.stringify({ sessionId, cwd, createdAt: Date.now() }),
  );
}

/** Called on activation: if another window asked us to resume a session for this folder, do it. */
async function consumePendingResume(): Promise<void> {
  const file = path.join(storageDir, PENDING_RESUME_FILE);
  let data: { sessionId: string; cwd: string; createdAt: number };
  try {
    data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return;
  }
  if (Date.now() - data.createdAt > PENDING_RESUME_MAX_AGE_MS) {
    await fs.promises.rm(file, { force: true });
    return;
  }
  if (!workspaceFolderPaths().some((f) => samePath(f, data.cwd))) return; // meant for another window
  await fs.promises.rm(file, { force: true });

  // Give Claude Code a moment to restore its own UI before we ask it to open a session.
  await new Promise((r) => setTimeout(r, 2000));
  const ok = await openInClaudePanel(data.sessionId);
  if (!ok) vscode.window.showWarningMessage('Claude Code extension not found — could not resume the session in the panel.');
}

async function resumeSession(s: IndexedSession, forceTarget?: 'panel' | 'terminal'): Promise<void> {
  const target = forceTarget ?? cfg().resumeTarget;
  if (target === 'terminal') { resumeInTerminal(s); return; }

  const hasClaudeExt = !!vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID);
  if (!hasClaudeExt) {
    const pick = await vscode.window.showWarningMessage(
      'The Claude Code extension is not installed, so the session cannot open in its panel. Resume it with the Claude CLI in a terminal instead?',
      'Resume in Terminal', 'Open Transcript',
    );
    if (pick === 'Resume in Terminal') resumeInTerminal(s);
    if (pick === 'Open Transcript') await openTranscript(s);
    return;
  }

  // The Claude Code panel can only resume sessions that belong to the folder open in this window.
  if (sessionBelongsToThisWindow(s) || !s.doc.cwd) {
    await openInClaudePanel(s.doc.sessionId);
    return;
  }

  const cwd = s.doc.cwd;
  if (!folderExists(cwd)) {
    const pick = await vscode.window.showWarningMessage(
      `This session ran in "${cwd}", which no longer exists on this machine. Claude Code can only resume it from that folder.`,
      'Open Transcript', 'Try in Terminal',
    );
    if (pick === 'Open Transcript') await openTranscript(s);
    if (pick === 'Try in Terminal') resumeInTerminal(s);
    return;
  }

  const pick = await vscode.window.showInformationMessage(
    `This session belongs to "${projectLabel(cwd)}" (${cwd}). Claude Code resumes sessions from their own folder.`,
    'Open Folder in New Window', 'Open Folder Here', 'Resume in Terminal',
  );
  if (pick === 'Resume in Terminal') { resumeInTerminal(s); return; }
  if (pick === 'Open Folder in New Window' || pick === 'Open Folder Here') {
    await writePendingResume(s.doc.sessionId, cwd);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(cwd), {
      forceNewWindow: pick === 'Open Folder in New Window',
    });
  }
}

// ───────────────────────────── transcript view ─────────────────────────────

class TranscriptProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const id = path.basename(uri.path, '.md');
    const s = index?.get(id);
    return s ? renderTranscript(s.doc).markdown : `Session ${id} is not in the index.`;
  }
}

async function openTranscript(s: IndexedSession, hit?: SearchHit): Promise<void> {
  const uri = vscode.Uri.parse(`${TRANSCRIPT_SCHEME}:/${s.doc.sessionId}.md`);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
  const editor = await vscode.window.showTextDocument(doc, { preview: true });

  if (hit && hit.messageIndex >= 0 && hit.matchStart >= 0) {
    const { messageLines } = renderTranscript(s.doc);
    const msgText = s.doc.messages[hit.messageIndex].text;
    const before = msgText.slice(0, hit.matchStart);
    const lineInMsg = (before.match(/\n/g) ?? []).length;
    const col = hit.matchStart - (before.lastIndexOf('\n') + 1);
    const line = messageLines[hit.messageIndex] + 2 + lineInMsg; // header + blank line
    const range = new vscode.Range(line, col, line, col + hit.matchLength);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }
}

// ───────────────────────────── search UI ─────────────────────────────

interface SessionItem extends vscode.QuickPickItem {
  session: IndexedSession;
  hit?: SearchHit;
}

const BTN_TERMINAL: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('terminal'), tooltip: 'Resume in terminal (claude --resume)' };
const BTN_TRANSCRIPT: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('book'), tooltip: 'Open transcript at the match' };
const BTN_COPY: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('copy'), tooltip: 'Copy session ID' };
const BTN_FILE: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: 'Open raw .jsonl file' };

function toItem(s: IndexedSession, hit?: SearchHit, thisWindow?: boolean): SessionItem {
  const meta = [
    projectLabel(s.doc.cwd),
    s.doc.gitBranch && s.doc.gitBranch !== 'HEAD' ? `⎇ ${s.doc.gitBranch}` : undefined,
    relativeTime(s.doc.updatedAt),
    hit && hit.hitCount ? `${hit.hitCount} match${hit.hitCount === 1 ? '' : 'es'}` : `${s.doc.messages.length} msgs`,
  ].filter(Boolean).join('  ·  ');
  return {
    label: `${thisWindow ? '$(folder-active)' : '$(comment-discussion)'} ${s.doc.title}`,
    description: meta,
    detail: hit ? hit.snippet : s.doc.firstPrompt,
    alwaysShow: true, // we do our own filtering
    buttons: [BTN_TRANSCRIPT, BTN_TERMINAL, BTN_COPY, BTN_FILE],
    session: s,
    hit,
  };
}

async function showSearch(initialScope: 'all' | 'workspace'): Promise<void> {
  const { idx, ready } = ensureIndex();
  let scope = initialScope;

  const qp = vscode.window.createQuickPick<SessionItem>();
  (qp as any).sortByLabel = false; // keep our ranking
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  qp.ignoreFocusOut = false;

  const scopeButton = (): vscode.QuickInputButton => scope === 'all'
    ? { iconPath: new vscode.ThemeIcon('globe'), tooltip: 'Searching all projects — click for this workspace only' }
    : { iconPath: new vscode.ThemeIcon('folder-active'), tooltip: 'Searching this workspace — click for all projects' };
  const refreshButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Re-index sessions' };
  const helpButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('question'), tooltip: 'Search syntax: words · "exact phrase" · -exclude · project:name · role:user|claude · /regex/' };

  const setTitle = (extra = '') => {
    qp.title = `Claude Sessions — ${scope === 'all' ? 'all projects' : 'this workspace'} (${idx.size} indexed)${extra ? '  ·  ' + extra : ''}`;
    qp.buttons = [helpButton, scopeButton(), refreshButton];
  };
  qp.placeholder = 'Search inside your Claude Code sessions: words, "phrase", -exclude, project:name, role:user, /regex/';

  let debounce: NodeJS.Timeout | undefined;
  const render = () => {
    const folders = scope === 'workspace' ? workspaceFolderPaths() : undefined;
    const limit = cfg().maxResults;
    const query = parseQuery(qp.value);
    const all = idx.all();
    if (query.error) {
      qp.items = [];
      setTitle(query.error);
      return;
    }
    if (query.isEmpty) {
      qp.items = recentSessions(all, { onlyFolders: folders, limit }).map((s) => toItem(s, undefined, sessionBelongsToThisWindow(s)));
      setTitle();
      return;
    }
    const hits = search(all, query, { onlyFolders: folders, limit });
    qp.items = hits.map((h) => toItem(h.session, h, sessionBelongsToThisWindow(h.session)));
    setTitle(`${hits.length}${hits.length === limit ? '+' : ''} result${hits.length === 1 ? '' : 's'}`);
  };

  qp.onDidChangeValue(() => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(render, 120);
  });

  qp.onDidTriggerButton(async (b) => {
    if (b === refreshButton) {
      qp.busy = true;
      await idx.clearCache();
      await refreshIndex((m) => setTitle(m));
      qp.busy = false;
      render();
    } else if (b === helpButton) {
      vscode.commands.executeCommand('sessionFinder.showHelp');
    } else {
      scope = scope === 'all' ? 'workspace' : 'all';
      render();
    }
  });

  qp.onDidTriggerItemButton(async (e) => {
    const s = e.item.session;
    if (e.button === BTN_TERMINAL) { qp.hide(); resumeInTerminal(s); }
    else if (e.button === BTN_TRANSCRIPT) { qp.hide(); await openTranscript(s, e.item.hit); }
    else if (e.button === BTN_COPY) {
      await vscode.env.clipboard.writeText(s.doc.sessionId);
      vscode.window.setStatusBarMessage(`Copied session ID ${s.doc.sessionId}`, 3000);
    } else if (e.button === BTN_FILE) {
      qp.hide();
      await vscode.window.showTextDocument(vscode.Uri.file(s.doc.filePath), { preview: true });
    }
  });

  qp.onDidAccept(async () => {
    const item = qp.selectedItems[0];
    if (!item) return;
    qp.hide();
    await resumeSession(item.session);
  });

  qp.onDidHide(() => qp.dispose());

  setTitle('loading…');
  qp.busy = true;
  qp.show();

  await ready;
  render();
  // Incremental refresh in the background; results update when it finishes.
  refreshIndex((m) => setTitle(m))
    .catch((e) => output.appendLine(`Scan failed: ${e}`))
    .finally(() => { qp.busy = false; render(); });
}

// ───────────────────────────── activation ─────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Session Finder');
  storageDir = context.globalStorageUri.fsPath;

  context.subscriptions.push(
    output,
    vscode.workspace.registerTextDocumentContentProvider(TRANSCRIPT_SCHEME, new TranscriptProvider()),
    vscode.commands.registerCommand('sessionFinder.search', () => showSearch('all')),
    vscode.commands.registerCommand('sessionFinder.searchWorkspace', () => showSearch('workspace')),
    vscode.commands.registerCommand('sessionFinder.reindex', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Session Finder' },
        async (progress) => {
          const { idx } = ensureIndex();
          await idx.clearCache();
          await refreshIndex((m) => progress.report({ message: m }));
          vscode.window.showInformationMessage(`Indexed ${idx.size} Claude Code sessions.`);
        },
      );
    }),
    vscode.commands.registerCommand('sessionFinder.resumeById', async () => {
      const id = (await vscode.window.showInputBox({ prompt: 'Claude Code session ID to resume', placeHolder: 'e.g. 2467221b-892d-4e4b-be8c-bf527419d4b8' }))?.trim();
      if (!id) return;
      await refreshIndex();
      const s = index?.get(id);
      if (s) await resumeSession(s);
      else if (!(await openInClaudePanel(id))) vscode.window.showWarningMessage(`Session ${id} was not found.`);
    }),
    vscode.commands.registerCommand('sessionFinder.showHelp', () => {
      vscode.window.showInformationMessage(
        'Search syntax — redis timeout: all words · "exact phrase" · -docker: exclude · project:3dnet · role:user or role:claude · /regex/ . Matching ignores case and accents.',
        { modal: true },
      );
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sessionFinder')) {
        index = undefined; // rebuilt lazily with the new settings
        indexReady = undefined;
      }
    }),
  );

  consumePendingResume().catch((e) => output.appendLine(`Pending resume failed: ${e}`));
}

export function deactivate(): void { /* nothing to clean up */ }
