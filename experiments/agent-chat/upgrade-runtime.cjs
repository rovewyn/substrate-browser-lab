// Runs only inside an explicitly running actor. All content remains actor-local.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
async function read(port, path) {
  try { return await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()); }
  catch { return null; }
}
async function main() {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const bundle = JSON.parse(Buffer.concat(chunks).toString());
  const ports = [8080, 80];
  let port = 80, health;
  for (const candidate of ports) {
    const result = await read(candidate, '/health');
    if (result) { port = candidate; health = result; break; }
  }
  if (health?.runtimeRevision === bundle.revision) return { upgraded: false, runtimeRevision: bundle.revision, port };
  const status = health ? await read(port, '/status') : null;
  if (status?.pendingRequests) return { upgraded: false, busy: true };
  if (status?.busy) {
    // Review can emit different start/completion turn IDs. Consult native thread
    // state before replacing an adapter that still believes the review is active.
    let native;
    try {
      native = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'thread/read', params: { threadId: status.activeThread || status.threadId, includeTurns: false } }),
        signal: AbortSignal.timeout(3000) }).then(r => r.json());
    } catch {}
    if (native?.result?.thread?.status?.type !== 'idle') return { upgraded: false, busy: true };
  }
  const processes = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(pid => {
    try { return { pid: Number(pid), args: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0') }; }
    catch { return null; }
  }).filter(Boolean);
  const launcher = processes.find(process => process.args.includes('/app/launcher.mjs'));
  const legacy = processes.find(process => process.args.includes('/app/actor.mjs'));
  if (!launcher && !legacy) throw new Error('Actor service is unavailable');
  if (!status) {
    // A missing legacy companion has no live turn to complete. Record the failure
    // inside the actor, without replaying the previous message or user response.
    const file = '/state/chat/events.jsonl';
    const events = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const turn = events.findLast(event => ['turn/started', 'turn/completed', 'turn/rejected', 'turn/transportFailed'].includes(event.method));
    if (turn?.method === 'turn/started') {
      const descriptor = fs.openSync(file, 'a', 0o600);
      try {
        fs.writeSync(descriptor, JSON.stringify({ seq: (events.at(-1)?.seq || 0) + 1, time: new Date().toISOString(),
          method: 'turn/transportFailed', params: { threadId: turn.params.threadId, turnId: turn.params.turn?.id,
            error: { message: 'Codex service stopped across suspension; the previous turn was not resent' } } }) + '\n');
        fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
    }
  }
  for (const [path, content] of Object.entries(bundle.files)) {
    if (!['/app/actor.mjs', '/app/common.mjs', '/app/config.toml', '/app/protocol-methods.json', '/app/launcher.mjs'].includes(path)) throw new Error('Invalid runtime file');
    fs.writeFileSync(`${path}.upgrade`, content, { mode: 0o600 }); fs.renameSync(`${path}.upgrade`, path);
  }
  const configPath = '/state/codex/config.toml';
  if (fs.existsSync(configPath)) {
    const config = fs.readFileSync(configPath, 'utf8').replace(/^web_search = "disabled"\n/m, '')
      .replace(/^multi_agent = false\n/m, '').replace(/^shell_snapshot = false\n/m, '');
    fs.writeFileSync(`${configPath}.upgrade`, config, { mode: 0o600 }); fs.renameSync(`${configPath}.upgrade`, configPath);
  }
  if (launcher) process.kill(launcher.pid, 'SIGHUP');
  else {
    port = 8080;
    // Bootstrap older images without replacing their init PID or invoking execve.
    const process = spawn('/usr/local/bin/node', ['/app/launcher.mjs'], {
      detached: true, stdio: 'ignore', env: { ...global.process.env, AGENT_PORT: String(port) },
    });
    process.unref();
  }
  const deadline = Date.now() + 15_000;
  let current;
  while (Date.now() < deadline) {
    current = await read(port, '/health');
    if (current?.runtimeRevision === bundle.revision) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (current?.runtimeRevision !== bundle.revision) throw new Error('Actor service replacement did not complete');
  if (!launcher) {
    // The old init stays present for the lifetime of the container, but cannot issue
    // duplicate Codex work. Neither signal terminates the container or deletes state.
    for (const process of processes) {
      if (process.args.includes('app-server') && process.args.includes('stdio://')) {
        try { global.process.kill(process.pid, 'SIGTERM'); } catch {}
      }
    }
    global.process.kill(legacy.pid, 'SIGSTOP');
  }
  return { upgraded: true, runtimeRevision: current.runtimeRevision, port };
}
const timer = setTimeout(() => process.exit(1), 30_000);
main().then(result => {
  clearTimeout(timer); process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}).catch(() => {
  clearTimeout(timer); process.stderr.write('Actor runtime upgrade failed; state files were preserved\n', () => process.exit(1));
});
