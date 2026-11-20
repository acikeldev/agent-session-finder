/**
 * Length-preserving text folding for case- and accent-insensitive search.
 *
 * Every UTF-16 code unit maps to exactly one code unit, so an offset found in
 * the folded string is also a valid offset in the original string. That lets us
 * search the folded text and still cut snippets / select ranges in the original.
 *
 * Examples: "İstanbul" -> "istanbul", "Çalışma" -> "calisma", "Ñandú" -> "nandu".
 */

const foldCache = new Map<number, string>();

// Characters whose decomposition does not strip to a plain letter.
const SPECIAL: Record<string, string> = {
  'ı': 'i', // Turkish dotless i
  'İ': 'i', // Turkish dotted capital I
  'ø': 'o', 'Ø': 'o',
  'ł': 'l', 'Ł': 'l',
  'đ': 'd', 'Đ': 'd',
  'ß': 'ß',
};

function foldChar(code: number): string {
  let cached = foldCache.get(code);
  if (cached !== undefined) return cached;
  const ch = String.fromCharCode(code);
  if (SPECIAL[ch] !== undefined) {
    cached = SPECIAL[ch];
  } else if (code >= 0xd800 && code <= 0xdfff) {
    cached = ch; // lone surrogate half: leave untouched
  } else {
    const base = ch.normalize('NFD')[0] ?? ch;
    const lower = base.toLowerCase();
    cached = lower.length === 1 ? lower : base;
  }
  foldCache.set(code, cached);
  return cached;
}

export function fold(input: string): string {
  // Fast path: pure ASCII
  let ascii = true;
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) return input.toLowerCase();

  const out: string[] = new Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    out[i] = c < 128 ? (c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : input[i]) : foldChar(c);
  }
  return out.join('');
}

/** Collapse whitespace so snippets fit on one line. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
