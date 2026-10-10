import { spawn } from 'node:child_process';

// Keep the container init process stable while replacing the idle HTTP adapter.
let service;
let reload = false;
let stopping = false;
function start() {
  service = spawn(process.execPath, ['/app/actor.mjs'], { stdio: ['ignore', 'ignore', 'ignore'], env: process.env });
  service.on('error', () => { process.exitCode = 1; });
  service.on('exit', () => {
    if (reload && !stopping) { reload = false; start(); }
    else process.exit(stopping ? 0 : 1);
  });
}
process.on('SIGHUP', () => { if (!stopping && !reload) { reload = true; service.kill('SIGTERM'); } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; service.kill('SIGTERM'); });
start();
