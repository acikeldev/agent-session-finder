import { SessionDoc } from './types';

export interface RenderedTranscript {
  markdown: string;
  /** 0-based line where each message starts */
  messageLines: number[];
}

function fmtDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Render a session as Markdown, remembering where each message starts so we can jump to a hit. */
export function renderTranscript(doc: SessionDoc): RenderedTranscript {
  const lines: string[] = [];
  const messageLines: number[] = [];
  lines.push(`# ${doc.title}`);
  lines.push('');
  lines.push(`- **Session ID:** \`${doc.sessionId}\``);
  if (doc.cwd) lines.push(`- **Folder:** \`${doc.cwd}\``);
  if (doc.gitBranch) lines.push(`- **Branch:** ${doc.gitBranch}`);
  if (doc.startedAt) lines.push(`- **Started:** ${fmtDate(doc.startedAt)}`);
  if (doc.updatedAt) lines.push(`- **Last activity:** ${fmtDate(doc.updatedAt)}`);
  lines.push(`- **Messages:** ${doc.messages.length}`);
  lines.push('');

  for (const m of doc.messages) {
    lines.push('---');
    lines.push('');
    messageLines.push(lines.length);
    lines.push(`## ${m.role === 'user' ? '🧑 You' : '🤖 Claude'}${m.ts ? `  ·  ${fmtDate(m.ts)}` : ''}`);
    lines.push('');
    for (const l of m.text.split(/\r?\n/)) lines.push(l);
    lines.push('');
  }
  return { markdown: lines.join('\n'), messageLines };
}
