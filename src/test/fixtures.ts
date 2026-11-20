import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Build a fake ~/.claude/projects tree with realistic Claude Code records. */

let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;

function base(sessionId: string, cwd: string, ts: string, extra: object = {}) {
  return { parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.329', gitBranch: 'main', uuid: uuid(), timestamp: ts, ...extra };
}

export function user(sessionId: string, cwd: string, ts: string, content: unknown, extra: object = {}) {
  return JSON.stringify({ ...base(sessionId, cwd, ts, extra), type: 'user', message: { role: 'user', content } });
}

export function assistant(sessionId: string, cwd: string, ts: string, content: unknown, extra: object = {}) {
  return JSON.stringify({ ...base(sessionId, cwd, ts, extra), type: 'assistant', message: { id: 'msg_' + uuidN, role: 'assistant', model: 'claude-opus-5-5', content } });
}

export interface FakeTree { root: string; projectsDir: string; cleanup(): void }

export function makeTree(): FakeTree {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csf-'));
  const projectsDir = path.join(root, 'projects');
  fs.mkdirSync(projectsDir);
  return { root, projectsDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function writeSession(projectsDir: string, cwd: string, sessionId: string, lines: string[]): string {
  const dir = path.join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

export const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';
export const S2 = 'bbbbbbbb-2222-4222-8222-222222222222';
export const S3 = 'cccccccc-3333-4333-8333-333333333333';
export const CWD_3DNET = '/Users/bilal/code/3dnet';
export const CWD_EXT = '/Users/bilal/code/autotrader-extension';

export function populate(projectsDir: string): void {
  // Session 1: 3dnet, DICOM bug, custom title, tool use, system reminder noise
  writeSession(projectsDir, CWD_3DNET, S1, [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: S1 }),
    user(S1, CWD_3DNET, '2026-11-10T09:00:00.000Z', 'The DICOM viewer crashes when loading a series with missing SliceThickness. <system-reminder>secret-noise-token</system-reminder>'),
    assistant(S1, CWD_3DNET, '2026-11-10T09:00:05.000Z', [{ type: 'thinking', thinking: 'hidden-thought-xyz' }, { type: 'text', text: 'Let me look at the series loader.' }]),
    assistant(S1, CWD_3DNET, '2026-11-10T09:00:06.000Z', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep -rn SliceThickness src/' } }]),
    user(S1, CWD_3DNET, '2026-11-10T09:00:07.000Z', [{ type: 'tool_result', tool_use_id: 't1', content: 'src/loader.ts:42: const thickness = ds.SliceThickness!; // tool-output-marker' }]),
    assistant(S1, CWD_3DNET, '2026-11-10T09:00:10.000Z', [{ type: 'text', text: 'Found it: the non-null assertion on SliceThickness in loader.ts. I will fall back to SpacingBetweenSlices.' }]),
    user(S1, CWD_3DNET, '2026-11-10T09:01:00.000Z', 'Caveat: meta message', { isMeta: true }),
    user(S1, CWD_3DNET, '2026-11-10T09:02:00.000Z', '[Request interrupted by user]'),
    user(S1, CWD_3DNET, '2026-11-10T09:03:00.000Z', 'sidechain-only-text', { isSidechain: true }),
    '{this is not valid json',
    JSON.stringify({ type: 'custom-title', customTitle: 'DICOM slice thickness crash', sessionId: S1 }),
  ]);

  // Session 2: autotrader extension, Turkish text, slash command
  writeSession(projectsDir, CWD_EXT, S2, [
    user(S2, CWD_EXT, '2026-11-18T20:00:00.000Z', '<command-name>/init</command-name>\n<command-message>init</command-message>\n<command-args></command-args>'),
    user(S2, CWD_EXT, '2026-11-18T20:01:00.000Z', 'Arama sonuçlarından belirli markaları hariç tutan bir Çalışma modu ekleyelim. İstanbul örneği de olsun.'),
    assistant(S2, CWD_EXT, '2026-11-18T20:01:30.000Z', [{ type: 'text', text: 'Sure — I will add an "exclude makes" filter to the content script using a MutationObserver.' }]),
    JSON.stringify({ type: 'summary', summary: 'AutoTrader exclude makes filter', leafUuid: 'x' }),
  ]);

  // Session 3: same 3dnet folder, older, only prompt title
  writeSession(projectsDir, CWD_3DNET, S3, [
    user(S3, CWD_3DNET, '2025-06-01T12:00:00.000Z', 'Write unit tests for the redis connection pool timeout handling'),
    assistant(S3, CWD_3DNET, '2025-06-01T12:00:30.000Z', [{ type: 'text', text: 'Here are tests covering connection refused and timeout cases for the redis pool.' }]),
  ]);

  // Subagent transcript (must be skipped by the indexer)
  const sub = path.join(projectsDir, CWD_3DNET.replace(/[^a-zA-Z0-9]/g, '-'), S1, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), user('agent-1', CWD_3DNET, '2026-11-10T09:00:00.000Z', 'subagent-only-marker') + '\n');

  // Empty session (no messages) must be skipped
  writeSession(projectsDir, CWD_EXT, 'dddddddd-4444-4444-8444-444444444444', [JSON.stringify({ type: 'queue-operation', operation: 'dequeue' })]);
}
