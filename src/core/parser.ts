import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { DEFAULT_PARSE_OPTIONS, ParseOptions, SessionDoc, SessionMessage } from './types';
import { oneLine, truncate } from './text';

/**
 * Parser for Claude Code session transcripts (~/.claude/projects/<project>/<sessionId>.jsonl).
 *
 * The format is undocumented and changes between Claude Code versions, so the parser is
 * deliberately forgiving: unknown record types are ignored, malformed lines are skipped,
 * and every field is optional.
 */

const SYSTEM_TAG_BLOCKS = /<(system-reminder|local-command-stdout|local-command-stderr|command-message|command-args|local-command-caveat)>[\s\S]*?<\/\1>/g;
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const NOISE_PROMPTS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
  'No response requested.',
]);

function cleanUserText(raw: string): string {
  const cmd = COMMAND_NAME.exec(raw);
  let text = raw.replace(SYSTEM_TAG_BLOCKS, '').replace(/<command-name>[\s\S]*?<\/command-name>/g, '');
  text = text.trim();
  if (cmd) {
    const name = cmd[1].trim();
    text = text ? `${name} ${text}` : name;
  }
  return NOISE_PROMPTS.has(text) ? '' : text;
}

function stringifyToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>;
    // Most useful fields first; fall back to JSON.
    for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt']) {
      if (typeof o[k] === 'string') return o[k] as string;
    }
    try { return JSON.stringify(o); } catch { return ''; }
  }
  return String(input);
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && (c as any).type === 'text' ? String((c as any).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

interface Extracted { text: string; isToolResultOnly: boolean }

function extractContent(content: unknown, role: 'user' | 'assistant', opts: ParseOptions): Extracted {
  if (typeof content === 'string') {
    return { text: role === 'user' ? cleanUserText(content) : content.trim(), isToolResultOnly: false };
  }
  if (!Array.isArray(content)) return { text: '', isToolResultOnly: false };

  const parts: string[] = [];
  let sawNonTool = false;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, any>;
    switch (b.type) {
      case 'text': {
        sawNonTool = true;
        const t = String(b.text ?? '');
        const cleaned = role === 'user' ? cleanUserText(t) : t.trim();
        if (cleaned) parts.push(cleaned);
        break;
      }
      case 'tool_use':
        sawNonTool = true;
        if (opts.includeToolContent) {
          const inp = stringifyToolInput(b.input);
          parts.push(`[${b.name ?? 'tool'}] ${truncate(inp, 2000)}`);
        }
        break;
      case 'tool_result':
        if (opts.includeToolContent) {
          const t = toolResultText(b.content);
          if (t) parts.push(truncate(t, 4000));
        }
        break;
      default:
        // thinking, image, document, etc. are not indexed
        if (b.type !== 'tool_result') sawNonTool = true;
    }
  }
  return { text: parts.join('\n\n'), isToolResultOnly: !sawNonTool };
}

/**
 * Incremental parser: feed lines one by one with push(), then call finish().
 * Keeps only extracted text in memory, never the raw file.
 */
export class SessionParser {
  private messages: SessionMessage[] = [];
  private sessionId?: string;
  private cwd?: string;
  private gitBranch?: string;
  private version?: string;
  private entrypoint?: string;
  private customTitle?: string;
  private aiTitle?: string;
  private summary?: string;
  private firstPrompt?: string;
  private lastPrompt?: string;
  private startedAt?: string;
  private updatedAt?: string;

  constructor(private readonly filePath: string, private readonly opts: ParseOptions = DEFAULT_PARSE_OPTIONS) {}

  push(line: string): void {
    if (!line || line.charCodeAt(0) !== 123 /* { */) return;
    let r: Record<string, any>;
    try { r = JSON.parse(line); } catch { return; }
    if (!r || typeof r !== 'object') return;

    const type = r.type as string | undefined;

    // Metadata records
    if (type === 'summary' && typeof r.summary === 'string') { this.summary = r.summary; return; }
    if (type === 'custom-title') { this.customTitle = r.customTitle ?? r.title ?? this.customTitle; return; }
    if (type === 'ai-title') { this.aiTitle = r.aiTitle ?? r.title ?? this.aiTitle; return; }
    if (type === 'last-prompt' && typeof r.lastPrompt === 'string') { this.lastPrompt = r.lastPrompt; return; }

    if (type !== 'user' && type !== 'assistant') return;
    if (r.isSidechain === true) return; // subagent turns
    if (r.isMeta === true) return;      // injected caveats etc.
    if (r.isCompactSummary === true) return;

    this.sessionId ??= r.sessionId;
    this.cwd ??= r.cwd;
    this.gitBranch ??= r.gitBranch;
    this.version ??= r.version;
    this.entrypoint ??= r.entrypoint;
    if (typeof r.timestamp === 'string') {
      this.startedAt ??= r.timestamp;
      if (!this.updatedAt || r.timestamp > this.updatedAt) this.updatedAt = r.timestamp;
    }

    const msg = r.message;
    if (!msg || typeof msg !== 'object') return;
    const role: 'user' | 'assistant' = type === 'user' ? 'user' : 'assistant';
    const { text, isToolResultOnly } = extractContent(msg.content, role, this.opts);
    if (!text) return;

    const max = this.opts.maxCharsPerMessage;
    const capped = text.length > max ? text.slice(0, max) + '…' : text;

    // Merge consecutive assistant chunks (Claude Code writes one record per content block)
    // and fold tool results into the preceding turn.
    const prev = this.messages[this.messages.length - 1];
    if (prev && (role === 'assistant' || isToolResultOnly) && (prev.role === 'assistant' || isToolResultOnly)) {
      if (prev.text.length < max) prev.text += '\n\n' + capped;
      return;
    }
    if (role === 'user' && !this.firstPrompt) this.firstPrompt = capped;
    this.messages.push({ role, text: capped, ts: r.timestamp });
  }

  finish(): SessionDoc {
    const sessionId = this.sessionId ?? path.basename(this.filePath, '.jsonl');
    const promptTitle = this.firstPrompt ?? this.lastPrompt;

    let title: string;
    let titleSource: SessionDoc['titleSource'];
    if (this.customTitle) { title = this.customTitle; titleSource = 'custom'; }
    else if (this.aiTitle) { title = this.aiTitle; titleSource = 'ai'; }
    else if (this.summary) { title = this.summary; titleSource = 'summary'; }
    else if (promptTitle) { title = promptTitle; titleSource = 'prompt'; }
    else { title = '(untitled session)'; titleSource = 'none'; }

    return {
      sessionId,
      filePath: this.filePath,
      cwd: this.cwd,
      gitBranch: this.gitBranch,
      title: truncate(oneLine(title), 120),
      titleSource,
      firstPrompt: this.firstPrompt ? truncate(oneLine(this.firstPrompt), 300) : undefined,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      messages: this.messages,
      version: this.version,
      entrypoint: this.entrypoint,
    };
  }
}

/** Parse a session from an iterable of JSONL lines (used by tests). */
export function parseLines(lines: Iterable<string>, filePath: string, opts: ParseOptions = DEFAULT_PARSE_OPTIONS): SessionDoc {
  const p = new SessionParser(filePath, opts);
  for (const line of lines) p.push(line);
  return p.finish();
}

/** Stream-parse a session file without loading the whole file into memory. */
export async function parseSessionFile(filePath: string, opts: ParseOptions = DEFAULT_PARSE_OPTIONS): Promise<SessionDoc> {
  const p = new SessionParser(filePath, opts);
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) p.push(line);
  } finally {
    rl.close();
    stream.destroy();
  }
  return p.finish();
}
