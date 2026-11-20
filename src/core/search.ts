import { IndexedSession } from './indexer';
import { Role } from './types';
import { fold, oneLine } from './text';
import { samePath } from './paths';

/**
 * Query syntax
 *   redis timeout          all words must appear somewhere in the session (any order)
 *   "connection refused"   exact phrase
 *   -docker                exclude sessions containing the word
 *   project:3dnet          only sessions whose folder path contains "3dnet"
 *   role:user / role:claude  only match text written by you / by Claude
 *   /err(or)?\s+42/        regular expression (whole query, JavaScript syntax)
 * Matching is case- and accent-insensitive ("calisma" finds "Çalışma").
 */
export interface ParsedQuery {
  terms: string[];        // folded, positive (words and phrases)
  excludes: string[];     // folded
  projects: string[];     // folded
  role?: Role;
  regex?: RegExp;
  error?: string;
  isEmpty: boolean;
}

export function parseQuery(input: string): ParsedQuery {
  const q: ParsedQuery = { terms: [], excludes: [], projects: [], isEmpty: true };
  const trimmed = input.trim();
  if (!trimmed) return q;

  const re = /^\/(.+)\/([a-z]*)$/s.exec(trimmed);
  if (re) {
    try {
      const flags = re[2].includes('i') ? re[2] : re[2] + 'i';
      q.regex = new RegExp(re[1], flags.replace(/g/g, '') + 'g');
      q.isEmpty = false;
    } catch (e) {
      q.error = `Invalid regex: ${(e as Error).message}`;
    }
    return q;
  }

  const tokenRe = /(-?)(?:(\w+):)?(?:"([^"]*)"?|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(trimmed))) {
    const negate = m[1] === '-';
    const key = m[2]?.toLowerCase();
    const value = m[3] ?? m[4] ?? '';
    if (!value) continue;

    if (key === 'project' || key === 'p') { q.projects.push(fold(value)); continue; }
    if (key === 'role' || key === 'from') {
      const v = value.toLowerCase();
      if (v === 'user' || v === 'me' || v === 'you') q.role = 'user';
      else if (v === 'claude' || v === 'assistant' || v === 'ai') q.role = 'assistant';
      continue;
    }
    // Unknown "key:" prefix → treat whole thing as a term (e.g. "http://..." or "c:foo")
    const term = fold(key ? `${m[2]}:${value}` : value);
    if (!term) continue;
    (negate ? q.excludes : q.terms).push(term);
  }
  q.isEmpty = q.terms.length === 0 && q.excludes.length === 0 && q.projects.length === 0 && !q.role;
  return q;
}

export interface SearchHit {
  session: IndexedSession;
  score: number;
  /** Total number of term occurrences across the session */
  hitCount: number;
  /** Index of the best matching message, -1 if only the title matched */
  messageIndex: number;
  /** Offset of the first match inside that message (original text) */
  matchStart: number;
  matchLength: number;
  snippet: string;
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to sessions whose cwd equals one of these folders. */
  onlyFolders?: string[];
  now?: number;
}

function countOccurrences(hay: string, needle: string, cap: number): { count: number; first: number } {
  let count = 0;
  let first = -1;
  let idx = hay.indexOf(needle);
  while (idx !== -1 && count < cap) {
    if (first === -1) first = idx;
    count++;
    idx = hay.indexOf(needle, idx + needle.length);
  }
  return { count, first };
}

export function makeSnippet(text: string, start: number, length: number, width = 160): string {
  if (start < 0) return oneLine(text).slice(0, width);
  const before = Math.floor((width - length) / 3);
  let from = Math.max(0, start - before);
  let to = Math.min(text.length, from + width);
  from = Math.max(0, Math.min(from, to - width));
  // Avoid cutting words at the left edge.
  if (from > 0) {
    const sp = text.lastIndexOf(' ', from);
    if (sp !== -1 && from - sp < 15) from = sp + 1;
  }
  let s = oneLine(text.slice(from, to));
  if (from > 0) s = '…' + s;
  if (to < text.length) s = s + '…';
  return s;
}

function recencyBoost(updatedAt: string | undefined, now: number): number {
  if (!updatedAt) return 0;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return 0;
  const days = Math.max(0, (now - t) / 86_400_000);
  return 3 / (1 + days / 14); // up to +3 for today, ~+1.5 at two weeks
}

/** Sessions sorted by last activity (used when the query is empty). */
export function recentSessions(sessions: IndexedSession[], opts: SearchOptions = {}): IndexedSession[] {
  const filtered = opts.onlyFolders ? sessions.filter((s) => opts.onlyFolders!.some((f) => samePath(f, s.doc.cwd))) : sessions;
  return [...filtered]
    .sort((a, b) => (b.doc.updatedAt ?? '').localeCompare(a.doc.updatedAt ?? ''))
    .slice(0, opts.limit ?? 200);
}

export function search(sessions: IndexedSession[], query: ParsedQuery, opts: SearchOptions = {}): SearchHit[] {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 200;
  const hits: SearchHit[] = [];
  if (query.error) return hits;

  for (const s of sessions) {
    if (opts.onlyFolders && !opts.onlyFolders.some((f) => samePath(f, s.doc.cwd))) continue;
    if (query.projects.length && !query.projects.every((p) => s.foldedCwd.includes(p))) continue;

    const msgs = s.doc.messages;
    const eligible = (i: number) => !query.role || msgs[i].role === query.role;

    // Exclusions apply to the whole session.
    if (query.excludes.length) {
      let excluded = false;
      for (const ex of query.excludes) {
        if (s.foldedTitle.includes(ex) || s.foldedMessages.some((m, i) => eligible(i) && m.includes(ex))) { excluded = true; break; }
      }
      if (excluded) continue;
    }

    // Filter-only query (e.g. "project:foo" or "-docker"): list matching sessions.
    if (!query.regex && query.terms.length === 0) {
      hits.push({ session: s, score: recencyBoost(s.doc.updatedAt, now), hitCount: 0, messageIndex: -1, matchStart: -1, matchLength: 0, snippet: s.doc.firstPrompt ?? '' });
      continue;
    }

    if (query.regex) {
      const hit = regexSearch(s, query.regex, eligible, now);
      if (hit) hits.push(hit);
      continue;
    }

    // Every term must occur in the title or in some eligible message.
    let score = 0;
    let hitCount = 0;
    const perMessageTerms = new Map<number, number>(); // message index -> distinct terms matched
    const firstMatch = new Map<number, { start: number; len: number }>();
    let allFound = true;

    for (const term of query.terms) {
      let found = false;
      const t = countOccurrences(s.foldedTitle, term, 10);
      if (t.count) { found = true; score += 8; hitCount += t.count; }
      for (let i = 0; i < s.foldedMessages.length; i++) {
        if (!eligible(i)) continue;
        const c = countOccurrences(s.foldedMessages[i], term, 20);
        if (!c.count) continue;
        found = true;
        hitCount += c.count;
        score += Math.min(c.count, 5) * (msgs[i].role === 'user' ? 1.5 : 1);
        perMessageTerms.set(i, (perMessageTerms.get(i) ?? 0) + 1);
        const prev = firstMatch.get(i);
        if (!prev || c.first < prev.start) firstMatch.set(i, { start: c.first, len: term.length });
      }
      if (!found) { allFound = false; break; }
    }
    if (!allFound) continue;

    // Bonus when several terms co-occur in one message (proximity proxy).
    let best = -1;
    let bestTerms = 0;
    for (const [i, n] of perMessageTerms) {
      if (n > bestTerms || (n === bestTerms && i < best)) { best = i; bestTerms = n; }
    }
    if (query.terms.length > 1 && bestTerms === query.terms.length) score += 6;
    score += recencyBoost(s.doc.updatedAt, now);

    const fm = best >= 0 ? firstMatch.get(best)! : undefined;
    hits.push({
      session: s,
      score,
      hitCount,
      messageIndex: best,
      matchStart: fm?.start ?? -1,
      matchLength: fm?.len ?? 0,
      snippet: best >= 0 ? makeSnippet(msgs[best].text, fm!.start, fm!.len) : (s.doc.firstPrompt ?? ''),
    });
  }

  hits.sort((a, b) => b.score - a.score || (b.session.doc.updatedAt ?? '').localeCompare(a.session.doc.updatedAt ?? ''));
  return hits.slice(0, limit);
}

function regexSearch(s: IndexedSession, re: RegExp, eligible: (i: number) => boolean, now: number): SearchHit | undefined {
  // Regex runs on the original text (case-insensitive flag is on by default).
  let hitCount = 0;
  let best = -1;
  let bestStart = -1;
  let bestLen = 0;
  re.lastIndex = 0;
  const titleHit = re.test(s.doc.title);
  re.lastIndex = 0;
  for (let i = 0; i < s.doc.messages.length; i++) {
    if (!eligible(i)) continue;
    const text = s.doc.messages[i].text;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(text)) && n < 50) {
      if (best === -1) { best = i; bestStart = m.index; bestLen = m[0].length; }
      n++;
      if (m[0].length === 0) re.lastIndex++;
    }
    hitCount += n;
  }
  if (!titleHit && hitCount === 0) return undefined;
  return {
    session: s,
    score: (titleHit ? 8 : 0) + Math.min(hitCount, 20) + recencyBoost(s.doc.updatedAt, now),
    hitCount,
    messageIndex: best,
    matchStart: bestStart,
    matchLength: bestLen,
    snippet: best >= 0 ? makeSnippet(s.doc.messages[best].text, bestStart, bestLen) : (s.doc.firstPrompt ?? ''),
  };
}
