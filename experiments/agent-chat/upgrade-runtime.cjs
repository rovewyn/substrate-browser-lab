// Runs only inside an explicitly running actor. All content remains actor-local.
const fs = require('node:fs');
async function read(port, path) {
  try { return await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()); }
  catch { return null; }
}
async function main() {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const bundle = JSON.parse(Buffer.concat(chunks).toString());
  const port = 80;
  const health = await read(port, '/health');
  if (!health) throw new Error('Actor service is unavailable');
  if (health.runtimeRevision === bundle.revision) return { upgraded: false, runtimeRevision: bundle.revision };
  const status = await read(port, '/status');
  if (!status) throw new Error('Actor status is unavailable');
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
  if (!fs.readFileSync('/proc/1/cmdline', 'utf8').split('\0').includes('/app/launcher.mjs')) {
    throw new Error('Actor image must use the native launcher');
  }
  for (const [path, content] of Object.entries(bundle.files)) {
    if (!['/app/actor.mjs', '/app/common.mjs', '/app/config.toml', '/app/protocol-methods.json', '/app/launcher.mjs'].includes(path)) throw new Error('Invalid runtime file');
    fs.writeFileSync(`${path}.upgrade`, content, { mode: 0o600 }); fs.renameSync(`${path}.upgrade`, path);
  }
  process.kill(1, 'SIGHUP');
  const deadline = Date.now() + 15_000;
  let current;
  while (Date.now() < deadline) {
    current = await read(port, '/health');
    if (current?.runtimeRevision === bundle.revision) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (current?.runtimeRevision !== bundle.revision) throw new Error('Actor service replacement did not complete');
  return { upgraded: true, runtimeRevision: current.runtimeRevision };
}
const timer = setTimeout(() => process.exit(1), 30_000);
main().then(result => {
  clearTimeout(timer); process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}).catch(() => {
  clearTimeout(timer); process.stderr.write('Actor runtime upgrade failed; state files were preserved\n', () => process.exit(1));
});
