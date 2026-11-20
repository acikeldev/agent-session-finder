/**
 * Runs the real extension.ts against a minimal fake `vscode` API.
 * Covers activation, the QuickPick search flow, and every resume path.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import Module = require('module');
import { makeTree, populate, S1, S2, CWD_3DNET } from './fixtures';

type Listener<T> = (e: T) => any;
class Emitter<T> {
  private ls: Listener<T>[] = [];
  event = (l: Listener<T>) => { this.ls.push(l); return { dispose() {} }; };
  async fire(e: T) { for (const l of this.ls) await l(e); }
}

interface Log { openedExternal: string[]; terminals: { name: string; cwd?: string; sent: string[] }[]; infoMsgs: string[]; warnMsgs: string[]; executed: any[][]; shownDocs: string[]; clipboard: string }

function makeFakeVscode(opts: { claudeDir: string; storage: string; workspace: string[]; claudeExtInstalled: boolean; infoAnswer?: string; warnAnswer?: string }) {
  const log: Log = { openedExternal: [], terminals: [], infoMsgs: [], warnMsgs: [], executed: [], shownDocs: [], clipboard: '' };
  const commands = new Map<string, (...a: any[]) => any>();
  const providers = new Map<string, any>();
  let lastQuickPick: any;

  class Uri {
    constructor(public scheme: string, public path: string, public fsPath: string, private raw: string) {}
    static file(p: string) { return new Uri('file', p, p, 'file://' + p); }
    static parse(s: string) { const m = /^([a-z-]+):(.*)$/i.exec(s)!; const p = m[2].replace(/^\/\/[^/]*/, ''); return new Uri(m[1], p.split('?')[0], p, s); }
    toString() { return this.raw; }
  }
  class ThemeIcon { constructor(public id: string) {} }
  class Range { constructor(public sl: number, public sc: number, public el: number, public ec: number) {} get start() { return { l: this.sl, c: this.sc }; } get end() { return { l: this.el, c: this.ec }; } }
  class Selection { constructor(public anchor: any, public active: any) {} }

  const vscode = {
    Uri, ThemeIcon, Range, Selection,
    ProgressLocation: { Notification: 15 },
    TextEditorRevealType: { InCenter: 2 },
    env: {
      uriScheme: 'vscode',
      openExternal: async (u: any) => { log.openedExternal.push(u.toString()); return true; },
      clipboard: { writeText: async (t: string) => { log.clipboard = t; } },
    },
    extensions: {
      getExtension: (id: string) => (opts.claudeExtInstalled && id === 'anthropic.claude-code' ? { isActive: true, activate: async () => {} } : undefined),
    },
    workspace: {
      workspaceFolders: opts.workspace.map((p) => ({ uri: Uri.file(p) })),
      getConfiguration: () => ({ get: (k: string, d?: any) => (k === 'claudeConfigDirs' ? [opts.claudeDir] : d) }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      registerTextDocumentContentProvider: (scheme: string, p: any) => { providers.set(scheme, p); return { dispose() {} }; },
      openTextDocument: async (u: any) => ({ uri: u, text: providers.get(u.scheme)?.provideTextDocumentContent(u) ?? fs.readFileSync(u.fsPath, 'utf8') }),
    },
    languages: { setTextDocumentLanguage: async (d: any) => d },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      setStatusBarMessage: () => ({ dispose() {} }),
      showInformationMessage: async (m: string) => { log.infoMsgs.push(m); return opts.infoAnswer; },
      showWarningMessage: async (m: string) => { log.warnMsgs.push(m); return opts.warnAnswer; },
      showInputBox: async () => S1,
      withProgress: async (_o: any, fn: any) => fn({ report() {} }),
      showTextDocument: async (d: any) => { log.shownDocs.push(d.text ?? d.toString()); return { selection: undefined, revealRange() {} }; },
      createTerminal: (o: any) => { const t = { name: o.name, cwd: o.cwd, sent: [] as string[], show() {}, sendText(s: string) { t.sent.push(s); } }; log.terminals.push(t); return t; },
      createQuickPick: () => {
        const accept = new Emitter<void>(), value = new Emitter<string>(), hide = new Emitter<void>(), btn = new Emitter<any>(), itemBtn = new Emitter<any>();
        lastQuickPick = {
          items: [] as any[], selectedItems: [] as any[], value: '', busy: false, title: '', placeholder: '', buttons: [],
          onDidAccept: accept.event, onDidChangeValue: value.event, onDidHide: hide.event, onDidTriggerButton: btn.event, onDidTriggerItemButton: itemBtn.event,
          show() {}, hide() { hide.fire(); }, dispose() {},
          _type: async (v: string) => { lastQuickPick.value = v; await value.fire(v); await new Promise((r) => setTimeout(r, 200)); },
          _accept: async (i = 0) => { lastQuickPick.selectedItems = [lastQuickPick.items[i]]; await accept.fire(); },
          _itemButton: async (i: number, tooltipStart: string) => { const item = lastQuickPick.items[i]; await itemBtn.fire({ item, button: item.buttons.find((b: any) => b.tooltip.startsWith(tooltipStart)) }); },
        };
        return lastQuickPick;
      },
    },
    commands: {
      registerCommand: (id: string, fn: any) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (id: string, ...args: any[]) => { log.executed.push([id, ...args]); return commands.get(id)?.(...args); },
    },
  };
  return { vscode, log, commands, qp: () => lastQuickPick };
}

function loadExtension(fake: any) {
  const origResolve = (Module as any)._resolveFilename;
  (Module as any)._resolveFilename = function (req: string, ...rest: any[]) { return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest); };
  require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: fake } as any;
  const extPath = require.resolve('../extension');
  delete require.cache[extPath];
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}out${path.sep}core${path.sep}`)) delete require.cache[k];
  const ext = require(extPath);
  (Module as any)._resolveFilename = origResolve;
  return ext;
}

async function setup(o: Partial<Parameters<typeof makeFakeVscode>[0]> = {}) {
  const t = makeTree();
  populate(t.projectsDir);
  const storage = path.join(t.root, 'storage');
  const f = makeFakeVscode({ claudeDir: t.root, storage, workspace: [CWD_3DNET], claudeExtInstalled: true, ...o });
  const ext = loadExtension(f.vscode);
  ext.activate({ subscriptions: [], globalStorageUri: { fsPath: storage } });
  return { t, f, ext, storage };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('search command lists sessions and filters as you type', async () => {
  const { t, f } = await setup();
  try {
    await f.commands.get('sessionFinder.search')!();
    await wait(300);
    const qp = f.qp();
    assert.equal(qp.items.length, 3, 'empty query shows recent sessions');
    assert.ok(qp.items.every((i: any) => i.alwaysShow));
    await qp._type('çalışma');
    assert.equal(qp.items.length, 1);
    assert.equal(qp.items[0].session.doc.sessionId, S2);
    assert.ok(qp.items[0].detail.includes('Çalışma'));
    await qp._type('/broken(regex/');
    assert.equal(qp.items.length, 0);
    assert.ok(qp.title.includes('Invalid regex'));
  } finally { t.cleanup(); }
});

test('Enter on a session from this workspace opens it in the Claude Code panel via URI', async () => {
  const { t, f } = await setup();
  try {
    await f.commands.get('sessionFinder.search')!();
    await wait(300);
    const qp = f.qp();
    await qp._type('SliceThickness');
    await qp._accept(0);
    assert.deepEqual(f.log.openedExternal, [`vscode://anthropic.claude-code/open?session=${S1}`]);
  } finally { t.cleanup(); }
});

test('session from another folder: opens folder in new window and leaves a pending resume that the new window consumes', async () => {
  const { t, f, storage } = await setup({ workspace: ['/somewhere/else'], infoAnswer: 'Open Folder in New Window' });
  try {
    // make the session's folder exist on disk
    const realCwd = path.join(t.root, 'work', '3dnet');
    fs.mkdirSync(realCwd, { recursive: true });
    const file = fs.readdirSync(t.projectsDir).map((d) => path.join(t.projectsDir, d, `${S1}.jsonl`)).find((p) => fs.existsSync(p))!;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(CWD_3DNET).join(JSON.stringify(realCwd).slice(1, -1)));

    await f.commands.get('sessionFinder.search')!();
    await wait(300);
    const qp = f.qp();
    await qp._type('SliceThickness');
    await qp._accept(0);
    const open = f.log.executed.find((e) => e[0] === 'vscode.openFolder')!;
    assert.ok(open, 'vscode.openFolder called');
    assert.equal(open[1].fsPath, realCwd);
    assert.deepEqual(open[2], { forceNewWindow: true });
    assert.equal(f.log.openedExternal.length, 0);
    const pending = JSON.parse(fs.readFileSync(path.join(storage, 'pending-resume.json'), 'utf8'));
    assert.equal(pending.sessionId, S1);

    // Simulate the new window starting with that folder.
    const f2 = makeFakeVscode({ claudeDir: t.root, storage, workspace: [realCwd], claudeExtInstalled: true });
    const ext2 = loadExtension(f2.vscode);
    ext2.activate({ subscriptions: [], globalStorageUri: { fsPath: storage } });
    await wait(2300);
    assert.deepEqual(f2.log.openedExternal, [`vscode://anthropic.claude-code/open?session=${S1}`]);
    assert.ok(!fs.existsSync(path.join(storage, 'pending-resume.json')), 'pending file consumed');
  } finally { t.cleanup(); }
});

test('missing session folder: offers transcript / terminal instead', async () => {
  const { t, f } = await setup({ workspace: ['/somewhere/else'], warnAnswer: 'Try in Terminal' });
  try {
    await f.commands.get('sessionFinder.search')!();
    await wait(300);
    const qp = f.qp();
    await qp._type('SliceThickness');
    await qp._accept(0);
    assert.ok(f.log.warnMsgs[0].includes('no longer exists'));
    assert.deepEqual(f.log.terminals[0].sent, [`claude --resume ${S1}`]);
  } finally { t.cleanup(); }
});

test('Claude Code extension not installed: falls back to terminal', async () => {
  const { t, f } = await setup({ claudeExtInstalled: false, warnAnswer: 'Resume in Terminal' });
  try {
    await f.commands.get('sessionFinder.search')!();
    await wait(300);
    const qp = f.qp();
    await qp._type('redis');
    await qp._accept(0);
    assert.ok(f.log.warnMsgs[0].includes('not installed'));
    assert.equal(f.log.terminals.length, 1);
    assert.equal(f.log.openedExternal.length, 0);
  } finally { t.cleanup(); }
});

test('item buttons: copy ID, transcript, terminal', async () => {
  const { t, f } = await setup();
  try {
    await f.commands.get('sessionFinder.search')!();
    await wait(300);
    const qp = f.qp();
    await qp._type('SpacingBetweenSlices');
    await qp._itemButton(0, 'Copy');
    assert.equal(f.log.clipboard, S1);
    await qp._itemButton(0, 'Open transcript');
    assert.ok(f.log.shownDocs[0].includes('# DICOM slice thickness crash'));
    assert.ok(f.log.shownDocs[0].includes('SpacingBetweenSlices'));
    await qp._itemButton(0, 'Resume in terminal');
    assert.equal(f.log.terminals[0].sent[0], `claude --resume ${S1}`);
  } finally { t.cleanup(); }
});

test('resume by ID command', async () => {
  const { t, f } = await setup();
  try {
    await f.commands.get('sessionFinder.resumeById')!();
    assert.deepEqual(f.log.openedExternal, [`vscode://anthropic.claude-code/open?session=${S1}`]);
  } finally { t.cleanup(); }
});
