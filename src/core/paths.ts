import * as os from 'os';
import * as path from 'path';

/** Claude Code's config dir: $CLAUDE_CONFIG_DIR or ~/.claude */
export function defaultClaudeDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim();
  return fromEnv ? fromEnv : path.join(os.homedir(), '.claude');
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Normalize a filesystem path for equality checks:
 * forward slashes, no trailing slash, case-insensitive on Windows/macOS-style drive paths.
 */
export function normalizeForCompare(p: string, platform: NodeJS.Platform = process.platform): string {
  let n = p.replace(/\\/g, '/');
  if (n.length > 1) n = n.replace(/\/+$/, '');
  // Windows drive letters and paths are case-insensitive; macOS default FS is too.
  if (platform === 'win32' || platform === 'darwin' || /^[a-zA-Z]:\//.test(n)) n = n.toLowerCase();
  return n;
}

export function samePath(a: string | undefined, b: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (!a || !b) return false;
  return normalizeForCompare(a, platform) === normalizeForCompare(b, platform);
}

/** Short display name for a project directory, e.g. "/Users/bilal/code/3dnet" -> "3dnet". */
export function projectLabel(cwd: string | undefined): string {
  if (!cwd) return 'unknown project';
  const parts = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}
