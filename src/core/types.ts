export type Role = 'user' | 'assistant';

export interface SessionMessage {
  role: Role;
  text: string;
  /** ISO timestamp, if the record had one */
  ts?: string;
}

export interface SessionDoc {
  sessionId: string;
  filePath: string;
  /** Working directory the session ran in (the Claude Code "project"). */
  cwd?: string;
  gitBranch?: string;
  /** Best available title: custom > AI title > summary > first prompt. */
  title: string;
  titleSource: 'custom' | 'ai' | 'summary' | 'prompt' | 'none';
  firstPrompt?: string;
  startedAt?: string;
  updatedAt?: string;
  messages: SessionMessage[];
  /** Claude Code version that wrote the file */
  version?: string;
  entrypoint?: string;
}

export interface ParseOptions {
  /** Include tool calls and tool results in the searchable text. */
  includeToolContent: boolean;
  /** Hard cap per message to keep memory bounded. */
  maxCharsPerMessage: number;
}

export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
  includeToolContent: false,
  maxCharsPerMessage: 20000,
};
