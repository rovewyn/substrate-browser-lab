// Run inside an already-running Actor. Print model metadata only.
const { spawn } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const sessionFile = '/state/chat/session.json';
const session = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8')) : {};
const child = spawn('/app/node_modules/.bin/codex', ['app-server', '--listen', 'stdio://'], {
  env: { ...process.env, CODEX_HOME: '/state/codex', HOME: '/state/home' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', () => {});
let nextId = 0;
const pending = new Map();
function stopped() {
  for (const entry of pending.values()) entry.reject(new Error('Settings reader stopped'));
  pending.clear();
}
child.on('error', stopped);
child.on('exit', stopped);
child.stdin.on('error', stopped);
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || message.method) return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error('Settings request failed'));
  else entry.resolve(message.result);
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}
const timeout = setTimeout(() => { child.kill('SIGKILL'); stopped(); }, 15_000);
(async () => {
  try {
    await rpc('initialize', { clientInfo: { name: 'actor_settings_reader', version: '1.0.0' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const thread = session.threadId
      ? (await rpc('thread/read', { threadId: session.threadId, includeTurns: false })).thread : null;
    const catalog = await rpc('model/list', {});
    const selectedModel = thread?.model || session.model;
    const model = selectedModel ? catalog.data.find(row => row.model === selectedModel) : catalog.data.find(row => row.isDefault);
    console.log(JSON.stringify({
      model: selectedModel || model?.model || null,
      reasoningEffort: thread?.reasoningEffort ?? null,
      modelDefaultReasoningEffort: model?.defaultReasoningEffort ?? null,
    }));
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
})().catch(() => { console.error('Model settings are unavailable'); process.exitCode = 1; });
