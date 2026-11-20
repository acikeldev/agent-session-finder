import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fold } from '../core/text';
import { parseLines, parseSessionFile } from '../core/parser';
import { SessionIndex } from '../core/indexer';
import { parseQuery, search, recentSessions } from '../core/search';
import { samePath, normalizeForCompare } from '../core/paths';
import { renderTranscript } from '../core/transcript';
import { DEFAULT_PARSE_OPTIONS } from '../core/types';
import { makeTree, populate, S1, S2, S3, CWD_3DNET } from './fixtures';

const NOW = Date.parse('2026-11-20T12:00:00Z');

test('fold is length-preserving and accent/case-insensitive', () => {
  for (const s of ['İstanbul Çalışma', 'Ñandú Øre straße', 'emoji 😀 ok', 'ASCII Only']) {
    assert.equal(fold(s).length, s.length, s);
  }
  assert.equal(fold('İstanbul Çalışma ŞĞÜÖ'), 'istanbul calisma sguo');
});

test('parser extracts clean user/assistant text and metadata', async () => {
  const t = makeTree();
  try {
    populate(t.projectsDir);
    const file = path.join(t.projectsDir, CWD_3DNET.replace(/[^a-zA-Z0-9]/g, '-'), `${S1}.jsonl`);
    const doc = await parseSessionFile(file);
    assert.equal(doc.sessionId, S1);
    assert.equal(doc.cwd, CWD_3DNET);
    assert.equal(doc.title, 'DICOM slice thickness crash');
    assert.equal(doc.titleSource, 'custom');
    const all = doc.messages.map((m) => m.text).join('\n');
    assert.ok(all.includes('missing SliceThickness'));
    assert.ok(!all.includes('secret-noise-token'), 'system reminders stripped');
    assert.ok(!all.includes('hidden-thought-xyz'), 'thinking not indexed');
    assert.ok(!all.includes('tool-output-marker'), 'tool output off by default');
    assert.ok(!all.includes('Caveat: meta'), 'meta skipped');
    assert.ok(!all.includes('interrupted'), 'interrupt noise skipped');
    assert.ok(!all.includes('sidechain-only-text'), 'sidechain skipped');
    // two assistant chunks merged into one turn
    assert.deepEqual(doc.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(doc.startedAt, '2026-11-10T09:00:00.000Z');
  } finally { t.cleanup(); }
});

test('parser optionally indexes tool content', async () => {
  const t = makeTree();
  try {
    populate(t.projectsDir);
    const file = path.join(t.projectsDir, CWD_3DNET.replace(/[^a-zA-Z0-9]/g, '-'), `${S1}.jsonl`);
    const doc = await parseSessionFile(file, { ...DEFAULT_PARSE_OPTIONS, includeToolContent: true });
    const all = doc.messages.map((m) => m.text).join('\n');
    assert.ok(all.includes('grep -rn SliceThickness'));
    assert.ok(all.includes('tool-output-marker'));
  } finally { t.cleanup(); }
});

test('slash commands become readable, summary used as title', async () => {
  const t = makeTree();
  try {
    populate(t.projectsDir);
    const idx = new SessionIndex([t.projectsDir], DEFAULT_PARSE_OPTIONS);
    await idx.scan();
    const s2 = idx.get(S2)!;
    assert.equal(s2.doc.messages[0].text, '/init');
    assert.equal(s2.doc.title, 'AutoTrader exclude makes filter');
    assert.equal(idx.get(S3)!.doc.titleSource, 'prompt');
  } finally { t.cleanup(); }
});

test('parses the real Claude Code fixture', () => {
  const file = path.join(__dirname, '..', '..', 'fixtures', 'real-min.jsonl');
  const doc = parseLines(fs.readFileSync(file, 'utf8').split('\n'), file);
  assert.equal(doc.sessionId, '2467221b-892d-4e4b-be8c-bf527419d4b8');
  assert.equal(doc.cwd, '/tmp/cctest');
  assert.ok(doc.title.startsWith('Say the word pineapple-zebra'));
  assert.equal(doc.messages[0].role, 'user');
  assert.ok(!doc.messages.some((m) => m.text.includes('system-reminder')));
});

test('indexer skips subagents and empty sessions, rescans incrementally, uses cache', async () => {
  const t = makeTree();
  try {
    populate(t.projectsDir);
    const cache = path.join(t.root, 'cache', 'index.json.gz');
    const idx = new SessionIndex([t.projectsDir], DEFAULT_PARSE_OPTIONS, cache);
    const r1 = await idx.scan();
    assert.equal(r1.total, 3);
    assert.equal(r1.parsed, 4); // 3 sessions + 1 empty file parsed
    assert.ok(!idx.all().some((s) => s.doc.messages.some((m) => m.text.includes('subagent-only-marker'))));

    const r2 = await idx.scan();
    assert.equal(r2.parsed, 1, 'only the empty (never cached) file is re-parsed');

    // A fresh index loads from cache without parsing the unchanged sessions
    const idx2 = new SessionIndex([t.projectsDir], DEFAULT_PARSE_OPTIONS, cache);
    assert.equal(await idx2.loadCache(), 3);
    const r3 = await idx2.scan();
    assert.equal(r3.parsed, 1);

    // Deleting a file removes it from the index
    const f = idx2.get(S3)!.doc.filePath;
    fs.rmSync(f);
    const r4 = await idx2.scan();
    assert.equal(r4.removed, 1);
    assert.equal(idx2.get(S3), undefined);

    // Cache keyed by parse options: different options => ignored
    const idx3 = new SessionIndex([t.projectsDir], { ...DEFAULT_PARSE_OPTIONS, includeToolContent: true }, cache);
    assert.equal(await idx3.loadCache(), 0);
  } finally { t.cleanup(); }
});

test('query parsing', () => {
  const q = parseQuery('redis "Connection Refused" -docker project:3dnet role:claude');
  assert.deepEqual(q.terms, ['redis', 'connection refused']);
  assert.deepEqual(q.excludes, ['docker']);
  assert.deepEqual(q.projects, ['3dnet']);
  assert.equal(q.role, 'assistant');
  assert.ok(parseQuery('/err(or/').error);
  assert.ok(parseQuery('/slice\\w+/').regex);
  assert.deepEqual(parseQuery('https://example.com').terms, ['https://example.com']);
  assert.ok(parseQuery('   ').isEmpty);
});

test('search: AND semantics across messages, ranking, snippets, filters', async () => {
  const t = makeTree();
  try {
    populate(t.projectsDir);
    const idx = new SessionIndex([t.projectsDir], DEFAULT_PARSE_OPTIONS);
    await idx.scan();
    const all = idx.all();
    const ids = (q: string, o = {}) => search(all, parseQuery(q), { now: NOW, ...o }).map((h) => h.session.doc.sessionId);

    assert.deepEqual(ids('slicethickness'), [S1]);
    assert.deepEqual(ids('loader fallback'), []); // "fallback" not present
    assert.deepEqual(ids('loader SpacingBetweenSlices'), [S1]);
    assert.deepEqual(ids('redis timeout'), [S3]);
    assert.deepEqual(ids('"connection refused"'), [S3]);
    assert.deepEqual(ids('"refused connection"'), []);
    assert.deepEqual(ids('calisma istanbul'), [S2], 'accent/case-insensitive Turkish');
    assert.deepEqual(ids('ÇALIŞMA'), [S2]);
    assert.deepEqual(ids('project:3dnet').sort(), [S1, S3].sort());
    assert.deepEqual(ids('project:3dnet -redis'), [S1]);
    assert.deepEqual(ids('mutationobserver role:user'), []);
    assert.deepEqual(ids('mutationobserver role:claude'), [S2]);
    assert.deepEqual(ids('/Slice\\w+ss/'), [S1]);
    assert.deepEqual(ids('secret-noise-token'), []);
    assert.deepEqual(ids('thickness', { onlyFolders: ['/Users/bilal/code/3dnet/'] }), [S1]);
    assert.deepEqual(ids('thickness', { onlyFolders: ['/Users/bilal/other'] }), []);

    const hit = search(all, parseQuery('SpacingBetweenSlices'), { now: NOW })[0];
    assert.equal(hit.session.doc.messages[hit.messageIndex].role, 'assistant');
    assert.ok(hit.snippet.toLowerCase().includes('spacingbetweenslices'));
    const msg = hit.session.doc.messages[hit.messageIndex].text;
    assert.equal(msg.slice(hit.matchStart, hit.matchStart + hit.matchLength), 'SpacingBetweenSlices');

    // Title match outranks a body-only match; recent sessions first for empty query
    const recent = recentSessions(all).map((s) => s.doc.sessionId);
    assert.deepEqual(recent, [S2, S1, S3]);
  } finally { t.cleanup(); }
});

test('path comparison', () => {
  assert.ok(samePath('C:\\Users\\Bilal\\code\\', 'c:/users/bilal/code', 'win32'));
  assert.ok(!samePath('/home/a/Code', '/home/a/code', 'linux'));
  assert.ok(samePath('/home/a/code/', '/home/a/code', 'linux'));
  assert.equal(normalizeForCompare('/', 'linux'), '/');
});

test('transcript rendering keeps message line offsets', async () => {
  const t = makeTree();
  try {
    populate(t.projectsDir);
    const idx = new SessionIndex([t.projectsDir], DEFAULT_PARSE_OPTIONS);
    await idx.scan();
    const doc = idx.get(S1)!.doc;
    const r = renderTranscript(doc);
    const lines = r.markdown.split('\n');
    assert.equal(r.messageLines.length, doc.messages.length);
    assert.ok(lines[r.messageLines[1]].includes('Claude'));
    assert.equal(lines[r.messageLines[1] + 2], doc.messages[1].text.split('\n')[0]);
  } finally { t.cleanup(); }
});

test('performance: 2,000 sessions index and search quickly', async () => {
  const t = makeTree();
  try {
    const { writeSession, user, assistant } = await import('./fixtures');
    const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda redis docker dicom viewer react'.split(' ');
    for (let i = 0; i < 2000; i++) {
      const cwd = `/Users/bilal/code/proj${i % 40}`;
      const id = `ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const lines: string[] = [];
      for (let j = 0; j < 20; j++) {
        const txt = Array.from({ length: 60 }, (_, k) => words[(i * 7 + j * 3 + k) % words.length]).join(' ') + (i === 1234 && j === 10 ? ' needle-unique-xyz' : '');
        lines.push(j % 2 ? assistant(id, cwd, `2026-01-01T00:00:${String(j).padStart(2, '0')}.000Z`, [{ type: 'text', text: txt }]) : user(id, cwd, `2026-01-01T00:00:${String(j).padStart(2, '0')}.000Z`, txt));
      }
      writeSession(t.projectsDir, cwd, id, lines);
    }
    const idx = new SessionIndex([t.projectsDir], DEFAULT_PARSE_OPTIONS);
    const t0 = Date.now();
    await idx.scan();
    const tIndex = Date.now() - t0;
    const t1 = Date.now();
    const hits = search(idx.all(), parseQuery('needle-unique-xyz'));
    const hits2 = search(idx.all(), parseQuery('redis dicom'));
    const tSearch = Date.now() - t1;
    assert.equal(hits.length, 1);
    assert.ok(hits2.length > 0);
    console.log(`  indexed 2000 sessions in ${tIndex} ms; two searches in ${tSearch} ms`);
    assert.ok(tSearch < 1500, `search too slow: ${tSearch} ms`);
  } finally { t.cleanup(); }
});
