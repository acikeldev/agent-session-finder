// Builds a fake Claude config dir (<demoRoot>/claude/projects/**/*.jsonl) with demo sessions
// for recording the README GIF. Never touches ~/.claude.
// Usage: node scripts/demo/make-demo-data.js <demoRoot>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

if (!process.argv[2]) { console.error('Usage: node make-demo-data.js <demoRoot>'); process.exit(1); }
// VS Code reports Windows workspace paths with a lower-case drive letter.
const root = path.resolve(process.argv[2]).replace(/^[A-Z]:/, (d) => d.toLowerCase());
const claudeDir = path.join(root, 'claude');
const projectsDir = path.join(claudeDir, 'projects');
// Only the sessions are regenerated; a Claude Code login stored in claudeDir survives.
fs.rmSync(projectsDir, { recursive: true, force: true });

const cwdOf = (name) => path.join(root, name);
for (const p of ['acme-api', 'acme-web', 'infra']) fs.mkdirSync(path.join(root, p), { recursive: true });

const now = Date.now();
function session(project, branch, hoursAgo, title, turns) {
  const cwd = cwdOf(project);
  const sessionId = crypto.randomUUID();
  let parent = null;
  let t = now - hoursAgo * 3_600_000;
  const lines = [];
  const base = () => {
    const uuid = crypto.randomUUID();
    const rec = { parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.329', gitBranch: branch, uuid, timestamp: new Date(t).toISOString() };
    parent = uuid;
    t += 40_000;
    return rec;
  };
  for (const [role, text] of turns) {
    if (role === 'u') lines.push({ ...base(), type: 'user', message: { role: 'user', content: text } });
    else lines.push({ ...base(), type: 'assistant', message: { id: 'msg_' + crypto.randomBytes(8).toString('hex'), type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } } });
  }
  lines.push({ type: 'ai-title', aiTitle: title, sessionId });
  const dir = path.join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionId + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return sessionId;
}

session('acme-api', 'main', 3, 'Add rate limiting to login endpoint', [
  ['u', 'Brute-force attempts are hammering POST /login. Add per-IP rate limiting.'],
  ['a', 'I will add a Redis token bucket middleware: 5 attempts per minute per IP, returning 429 with a Retry-After header.'],
  ['u', 'Make the limit configurable per environment.'],
  ['a', 'Done. RATE_LIMIT_LOGIN_PER_MIN is read from config, defaulting to 5. Tests cover the 429 path.'],
]);
const target = session('acme-api', 'fix/webhooks', 26, 'Webhook delivery fixes', [
  ['u', 'Webhook deliveries to slow customers keep failing and we retry them all at the same moment.'],
  ['a', 'The retry loop uses a fixed 30s delay, so every failed delivery retries in lockstep. I will switch to exponential backoff with full jitter: delay = random(0, min(cap, base * 2^attempt)).'],
  ['u', 'Cap it at 10 minutes and stop after 8 attempts.'],
  ['a', 'Updated WebhookRetryPolicy: base 2s, cap 10 min, max 8 attempts, then the delivery moves to the dead-letter queue. Added a test that seeds the RNG to check the jitter bounds.'],
]);
session('acme-web', 'main', 50, 'Dark mode toggle flickers on load', [
  ['u', 'The page flashes white before dark mode applies.'],
  ['a', 'The theme is applied after hydration. I will inline a tiny script in <head> that reads localStorage and sets data-theme before first paint.'],
]);
session('acme-api', 'chore/db', 80, 'Replace order_status enum with lookup table', [
  ['u', 'We need to add new order statuses without a migration lock every time.'],
  ['a', 'I will move order_status to a lookup table with a foreign key, backfill it in batches, then drop the enum in a follow-up migration.'],
]);
session('infra', 'main', 120, 'Terraform state lock stuck', [
  ['u', 'terraform plan says the state is locked by a CI run that was cancelled yesterday.'],
  ['a', 'Confirm no apply is running, then run terraform force-unlock with the lock ID from the error. I also added a timeout to the CI job so cancelled runs release the lock.'],
]);
session('acme-web', 'feat/search', 200, 'Debounce product search input', [
  ['u', 'Every keystroke in the product search fires an API request.'],
  ['a', 'Added a 250ms debounce with AbortController so stale requests are cancelled when the user keeps typing.'],
]);

console.log(JSON.stringify({ claudeDir, target, workspace: cwdOf('acme-api') }));
