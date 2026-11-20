import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { parseSessionFile } from './parser';
import { ParseOptions, SessionDoc } from './types';
import { fold } from './text';

/** A session plus pre-folded text used for searching. */
export interface IndexedSession {
  doc: SessionDoc;
  mtimeMs: number;
  size: number;
  foldedTitle: string;
  foldedMessages: string[];
  foldedCwd: string;
}

export interface ScanProgress {
  total: number;
  done: number;
  changed: number;
}

export interface ScanResult {
  total: number;
  parsed: number;
  removed: number;
  errors: number;
  durationMs: number;
}

const CACHE_VERSION = 3;

interface CacheFile {
  version: number;
  optsKey: string;
  entries: Array<{ mtimeMs: number; size: number; doc: SessionDoc }>;
}

function toIndexed(doc: SessionDoc, mtimeMs: number, size: number): IndexedSession {
  return {
    doc,
    mtimeMs,
    size,
    foldedTitle: fold(doc.title),
    foldedMessages: doc.messages.map((m) => fold(m.text)),
    foldedCwd: fold(doc.cwd ?? ''),
  };
}

async function listSessionFiles(projectsDir: string): Promise<string[]> {
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  await Promise.all(
    projectDirs.filter((d) => d.isDirectory()).map(async (d) => {
      const dir = path.join(projectsDir, d.name);
      try {
        for (const f of await fs.promises.readdir(dir, { withFileTypes: true })) {
          // Top-level *.jsonl only: subagent transcripts live in <session>/subagents/ and are skipped.
          if (f.isFile() && f.name.endsWith('.jsonl')) files.push(path.join(dir, f.name));
        }
      } catch { /* unreadable project dir */ }
    }),
  );
  return files;
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/**
 * In-memory index of Claude Code sessions with an on-disk cache.
 * Rescans are incremental: only files whose mtime/size changed are re-parsed.
 */
export class SessionIndex {
  private sessions = new Map<string, IndexedSession>(); // key: file path
  private scanning: Promise<ScanResult> | undefined;
  private readonly optsKey: string;

  constructor(
    private projectsDirs: string[],
    private readonly parseOpts: ParseOptions,
    private readonly cacheFile?: string,
  ) {
    this.optsKey = JSON.stringify(parseOpts);
  }

  get size(): number { return this.sessions.size; }

  all(): IndexedSession[] { return [...this.sessions.values()]; }

  get(sessionId: string): IndexedSession | undefined {
    for (const s of this.sessions.values()) if (s.doc.sessionId === sessionId) return s;
    return undefined;
  }

  setProjectsDirs(dirs: string[]): void { this.projectsDirs = dirs; }

  async loadCache(): Promise<number> {
    if (!this.cacheFile) return 0;
    try {
      const raw = await fs.promises.readFile(this.cacheFile);
      const data = JSON.parse(zlib.gunzipSync(raw).toString('utf8')) as CacheFile;
      if (data.version !== CACHE_VERSION || data.optsKey !== this.optsKey) return 0;
      for (const e of data.entries) this.sessions.set(e.doc.filePath, toIndexed(e.doc, e.mtimeMs, e.size));
      return data.entries.length;
    } catch {
      return 0;
    }
  }

  async saveCache(): Promise<void> {
    if (!this.cacheFile) return;
    const data: CacheFile = {
      version: CACHE_VERSION,
      optsKey: this.optsKey,
      entries: this.all().map((s) => ({ mtimeMs: s.mtimeMs, size: s.size, doc: s.doc })),
    };
    await fs.promises.mkdir(path.dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.promises.writeFile(tmp, zlib.gzipSync(Buffer.from(JSON.stringify(data), 'utf8')));
    await fs.promises.rename(tmp, this.cacheFile);
  }

  async clearCache(): Promise<void> {
    this.sessions.clear();
    if (this.cacheFile) await fs.promises.rm(this.cacheFile, { force: true });
  }

  /** Incremental rescan. Concurrent calls share the same in-flight scan. */
  scan(onProgress?: (p: ScanProgress) => void): Promise<ScanResult> {
    if (!this.scanning) {
      this.scanning = this.doScan(onProgress).finally(() => { this.scanning = undefined; });
    }
    return this.scanning;
  }

  private async doScan(onProgress?: (p: ScanProgress) => void): Promise<ScanResult> {
    const started = Date.now();
    const files = (await Promise.all(this.projectsDirs.map(listSessionFiles))).flat();
    const seen = new Set<string>();
    let parsed = 0;
    let errors = 0;
    let done = 0;

    await mapLimit(files, 8, async (file) => {
      seen.add(file);
      try {
        const st = await fs.promises.stat(file);
        const existing = this.sessions.get(file);
        if (!existing || existing.mtimeMs !== st.mtimeMs || existing.size !== st.size) {
          const doc = await parseSessionFile(file, this.parseOpts);
          if (doc.messages.length > 0) {
            this.sessions.set(file, toIndexed(doc, st.mtimeMs, st.size));
          } else {
            this.sessions.delete(file);
          }
          parsed++;
        }
      } catch {
        errors++;
      }
      done++;
      if (onProgress && (done % 25 === 0 || done === files.length)) {
        onProgress({ total: files.length, done, changed: parsed });
      }
    });

    let removed = 0;
    for (const key of [...this.sessions.keys()]) {
      if (!seen.has(key)) { this.sessions.delete(key); removed++; }
    }

    if (parsed > 0 || removed > 0) {
      try { await this.saveCache(); } catch { /* cache is best-effort */ }
    }

    return { total: this.sessions.size, parsed, removed, errors, durationMs: Date.now() - started };
  }
}
