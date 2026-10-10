// Runs inside an already-running actor. No conversation or credential data leaves it.
const fs = require('node:fs');

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const bundle = JSON.parse(Buffer.concat(chunks).toString());
  const health = await fetch('http://127.0.0.1/health').then(response => response.json());
  if (health.runtimeRevision === bundle.revision) return { upgraded: false, runtimeRevision: bundle.revision };
  const status = await fetch('http://127.0.0.1/status').then(response => response.json());
  if (status.busy) return { upgraded: false, busy: true };
  if (typeof process.execve !== 'function') throw new Error('Actor Node runtime does not support replacement');
  const pid = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).find(name => {
    try { return fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').includes('/app/actor.mjs'); }
    catch { return false; }
  });
  if (!pid) throw new Error('Actor HTTP process is unavailable');
  // Replace only service code and its managed configuration, preserving /state data.
  for (const [path, content] of Object.entries(bundle.files)) {
    if (!['/app/actor.mjs', '/app/common.mjs', '/app/config.toml', '/state/codex/config.toml'].includes(path)) throw new Error('Invalid runtime file');
    fs.writeFileSync(`${path}.upgrade`, content, { mode: 0o600 });
    fs.renameSync(`${path}.upgrade`, path);
  }
  // Bootstrap older adapters through their loopback-only Node inspector. execve keeps
  // the container's init PID, closes the old Codex transport, and disables the inspector.
  process.kill(Number(pid), 'SIGUSR1');
  const deadline = Date.now() + 15_000;
  let endpoint;
  while (!endpoint && Date.now() < deadline) {
    try { endpoint = (await fetch('http://127.0.0.1:9229/json/list').then(response => response.json()))[0]?.webSocketDebuggerUrl; } catch {}
    if (!endpoint) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!endpoint) throw new Error('Actor runtime replacement channel is unavailable');
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Actor runtime replacement connection failed')), { once: true });
  });
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: 'process.execve(process.execPath, [process.execPath, "/app/actor.mjs"], process.env)',
  } }));
  let current;
  while (Date.now() < deadline) {
    try { current = await fetch('http://127.0.0.1/health').then(response => response.json()); } catch {}
    if (current?.runtimeRevision === bundle.revision) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  socket.close();
  if (current?.runtimeRevision !== bundle.revision) throw new Error('Actor runtime replacement did not complete');
  return { upgraded: true, runtimeRevision: current.runtimeRevision };
}
const timer = setTimeout(() => process.exit(1), 25_000);
main().then(result => {
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}).catch(() => {
  clearTimeout(timer);
  process.stderr.write('Actor runtime upgrade failed; state files were preserved\n', () => process.exit(1));
});
