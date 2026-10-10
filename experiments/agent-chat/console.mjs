import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, body, fail, HttpError, json, noStore } from './common.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const state = join(root, 'state/agent-chat');
const playRoot = process.env.AGENT_PLAY_ROOT || '/Users/liuyue/Documents/Codex/substrate-play';
const kubeconfig = join(playRoot, 'state/kubeconfig');
const context = 'kind-substrate-play';
const space = 'ate-demo-agent';
const port = 4189;
const execute = promisify(execFile);
const kubectl = ['--kubeconfig', kubeconfig, '--context', context];
const ateBinary = process.env.KUBECTL_ATE_BIN || join(playRoot, 'bin/kubectl-ate');
const metadataFile = join(state, 'console.json');
mkdirSync(state, { recursive: true, mode: 0o700 });
const metadata = existsSync(metadataFile) ? JSON.parse(readFileSync(metadataFile)) : {};
for (const record of Object.values(metadata)) {
  if (record.operation) { delete record.operation; record.enabled = false; record.blocked = true; }
}
const channels = new Map();
const forwards = new Map();
const creating = new Set();
const upgrades = new Map();
const readyRuntimes = new Set();
const runtimeRevision = 'native-codex-v2.5';
const runtimeUpgrader = readFileSync(join(directory, 'upgrade-runtime.cjs'), 'utf8');
const runtimeConfig = readFileSync(join(directory, 'image/config.toml'), 'utf8');
const runtimeBundle = JSON.stringify({ revision: runtimeRevision, files: {
  '/app/launcher.mjs': readFileSync(join(directory, 'launcher.mjs'), 'utf8'),
  '/app/actor.mjs': readFileSync(join(directory, 'actor.mjs'), 'utf8'),
  '/app/common.mjs': readFileSync(join(directory, 'common.mjs'), 'utf8'),
  '/app/config.toml': runtimeConfig,
  '/app/protocol-methods.json': readFileSync(join(directory, 'protocol-methods.json'), 'utf8'),
} });
const sandboxConfig = JSON.parse(readFileSync(join(directory, 'config/sandbox-config.json'), 'utf8'));
const gvisorDigest = sandboxConfig.spec.versions.find(version => version.name === sandboxConfig.spec.defaultVersion).assets.arm64.gvisor.sha256;
if (!/^[a-f0-9]{64}$/.test(gvisorDigest)) throw new Error('Invalid configured gVisor asset digest');
let credentials = null;
let refreshing = null;
let actorCache = null;

async function command(binary, args, timeout = 30_000) {
  try {
    return (await execute(binary, args, { timeout, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch { throw new HttpError(503, 'Local cluster command failed'); }
}
async function kube(args) { return command('kubectl', [...kubectl, ...args]); }
async function ate(args, timeout) { return JSON.parse(await command(ateBinary, [...kubectl, ...args, '-o', 'json'], timeout)); }
function save() { atomicJson(metadataFile, metadata); }

async function actors(fresh = false) {
  if (!fresh && actorCache && Date.now() - actorCache.time < 1500) return actorCache.rows;
  const result = await ate(['get', 'actors', '-a', space]);
  const rows = (result.actors || []).map(actor => ({
    name: actor.metadata.name, uid: actor.metadata.uid, state: actor.status.state,
    workerAssignment: actor.status.workerAssignment || null,
    snapshotFidelity: actor.status.externalSnapshot?.fidelity || null,
  }));
  for (const actor of rows) {
    if (!metadata[actor.name] || metadata[actor.name].uid !== actor.uid) {
      metadata[actor.name] = { uid: actor.uid, enabled: false, blocked: true };
    }
  }
  save();
  actorCache = { time: Date.now(), rows };
  return rows;
}
async function getActor(name, fresh = true) {
  const actor = (await actors(fresh)).find(row => row.name === name);
  if (!actor) throw new HttpError(404, 'Actor not found');
  return actor;
}

function writeCredential(name, content) {
  const path = join(state, name);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
async function refreshCredentials() {
  if (credentials && credentials.expires - Date.now() > 5 * 60_000) return credentials;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const names = (await kube(['-n', 'ate-system', 'get', 'pods', '-l', 'app=atenet-router',
      '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}'])).trim().split('\n');
    const pod = names.find(name => /^atenet-router-[a-z0-9-]+$/.test(name));
    if (!pod) throw new HttpError(503, 'Router credentials are unavailable');
    const cert = await kube(['-n', 'ate-system', 'exec', pod, '-c', 'envoy', '--',
      'cat', '/run/podidentity.podcert.ate.dev/credential-bundle.pem']);
    const ca = await kube(['-n', 'ate-system', 'exec', pod, '-c', 'envoy', '--',
      'cat', '/run/podidentity.podcert.ate.dev/trust-bundle.pem']);
    const certificate = new X509Certificate(cert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0] || '');
    if (!certificate.subjectAltName?.includes('URI:spiffe://cluster.local/ns/ate-system/sa/atenet-router')) {
      throw new HttpError(503, 'Unexpected router credential identity');
    }
    writeCredential('client.pem', cert);
    writeCredential('ca.pem', ca);
    credentials = { cert, key: cert, ca, expires: Date.parse(certificate.validTo) };
    return credentials;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// Read the Substrate PodIdentity extension without adding an ASN.1 dependency.
function der(buffer, offset = 0) {
  const tag = buffer[offset++];
  let length = buffer[offset++];
  if (length & 128) {
    const count = length & 127;
    if (!count || count > 4) throw new Error('Invalid DER length');
    length = 0;
    for (let index = 0; index < count; index++) length = length * 256 + buffer[offset++];
  }
  const end = offset + length;
  if (end > buffer.length) throw new Error('Invalid DER bounds');
  return { tag, start: offset, end, value: buffer.subarray(offset, end) };
}
function children(buffer) {
  const result = [];
  for (let offset = 0; offset < buffer.length;) {
    const entry = der(buffer, offset);
    result.push(entry);
    offset = entry.end;
  }
  return result;
}
const podIdentityOid = Buffer.from([0x2b, 6, 1, 4, 1, 0xd6, 0x79, 2, 12, 1]);
function podIdentity(certificate) {
  const tbs = children(der(certificate).value)[0];
  const wrapper = children(tbs.value).find(entry => entry.tag === 0xa3);
  if (!wrapper) throw new Error('Missing Pod identity');
  const extensions = children(der(wrapper.value).value);
  const matches = extensions.map(entry => children(entry.value)).filter(fields => fields[0].value.equals(podIdentityOid));
  if (matches.length !== 1) throw new Error('Invalid Pod identity');
  return JSON.parse(matches[0].at(-1).value.toString());
}
function verifyWorker(expected, certificate) {
  try {
    const identity = podIdentity(certificate.raw);
    const uri = `URI:spiffe://cluster.local/ns/${expected.namespace}/sa/${expected.serviceAccount}`;
    if (identity.PodUID !== expected.uid || identity.PodName !== expected.name ||
        identity.Namespace !== expected.namespace || identity.ServiceAccountName !== expected.serviceAccount ||
        !certificate.subjectaltname?.split(', ').includes(uri)) throw new Error('Worker identity mismatch');
  } catch { return new Error('Worker certificate identity does not match the current assignment'); }
}

async function workerForward(assignment) {
  const key = assignment.workerPodUid;
  if (forwards.has(key)) return forwards.get(key).ready;
  const namespace = assignment.workerNamespace;
  const name = assignment.workerPod;
  const details = (await kube(['-n', namespace, 'get', 'pod', name,
    '-o', 'jsonpath={.metadata.uid}{" "}{.spec.serviceAccountName}'])).trim().split(' ');
  if (details[0] !== key) throw new HttpError(409, 'Worker assignment changed');
  const processHandle = spawn('kubectl', [...kubectl, '-n', namespace, 'port-forward', '--address=127.0.0.1', `pod/${name}`, ':443'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { process: processHandle };
  entry.ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => { processHandle.kill(); reject(new HttpError(503, 'Worker connection timed out')); }, 10_000);
    let output = '';
    processHandle.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Forwarding from 127\.0\.0\.1:(\d+) -> 443/);
      if (match) { clearTimeout(timer); resolveReady({ port: Number(match[1]), namespace, name, uid: key, serviceAccount: details[1] }); }
    });
    processHandle.stderr.on('data', () => {});
    processHandle.on('error', () => { clearTimeout(timer); reject(new HttpError(503, 'Worker connection failed')); });
    processHandle.on('exit', () => { clearTimeout(timer); forwards.delete(key); reject(new HttpError(503, 'Worker connection closed')); });
  });
  forwards.set(key, entry);
  return entry.ready;
}

function stopChannels(name) {
  for (const request of channels.get(name) || []) request.destroy();
}
// Relay authentication only between explicitly enabled Actors; never expose the cache to the browser.
async function actorJson(name, method, path, value) {
  if (path.startsWith('/auth/') && upgrades.has(name)) throw new HttpError(409, 'Wait for the actor runtime update');
  const actor = await getActor(name);
  const record = metadata[name];
  const permitted = () => metadata[name] === record && record.enabled && !record.blocked;
  if (actor.state !== 'ACTOR_STATE_RUNNING' || !permitted()) throw new HttpError(409, 'Explicitly Resume this actor before accessing its service');
  if (!actor.workerAssignment?.workerPodUid) throw new HttpError(503, 'Actor has no current worker');
  const connection = await workerForward(actor.workerAssignment);
  const credential = await refreshCredentials();
  if (!permitted()) throw new HttpError(409, 'Actor is suspending');
  return new Promise((resolveResult, reject) => {
    const upstream = https.request({
      hostname: '127.0.0.1', port: connection.port, path, method, agent: false,
      cert: credential.cert, key: credential.key, ca: credential.ca, rejectUnauthorized: true,
      checkServerIdentity: (_hostname, certificate) => verifyWorker(connection, certificate),
      headers: { 'ate-target-actor': `${space}/${name}`, 'X-Ate-Target-Port': String(record.port || 80), 'Content-Type': 'application/json' },
    }, incoming => {
      const chunks = [];
      let length = 0;
      incoming.on('data', chunk => {
        length += chunk.length;
        if (length > 64 * 1024) upstream.destroy();
        else chunks.push(chunk);
      });
      incoming.on('error', () => reject(new HttpError(503, 'Sign-in transfer connection closed')));
      incoming.on('end', () => {
        if (incoming.statusCode !== 200) {
          reject(new HttpError(incoming.statusCode === 401 ? 401 : 409, 'Sign-in transfer failed; the source must be signed in and the target must be unsigned'));
          return;
        }
        try { resolveResult(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { reject(new HttpError(503, 'Invalid sign-in transfer response')); }
      });
    });
    if (!channels.has(name)) channels.set(name, new Set());
    channels.get(name).add(upstream);
    upstream.on('close', () => channels.get(name)?.delete(upstream));
    upstream.on('error', () => reject(new HttpError(503, 'Sign-in transfer stopped; retry it explicitly')));
    upstream.setTimeout(path === '/health' ? 3000 : 90_000, () => upstream.destroy());
    upstream.end(value === undefined ? undefined : JSON.stringify(value));
  });
}
async function ensureRuntime(name, allowBusy = false) {
  const actor = await getActor(name);
  const record = metadata[name];
  const permitted = () => metadata[name] === record && record.enabled && !record.blocked;
  if (actor.state !== 'ACTOR_STATE_RUNNING' || !permitted()) throw new HttpError(409, 'Explicitly Resume this actor before updating its runtime');
  if (readyRuntimes.has(actor.uid)) return;
  if (upgrades.has(name)) return upgrades.get(name);
  const upgrading = (async () => {
    const health = await actorJson(name, 'GET', '/health').catch(() => null);
    if (health?.runtimeRevision === runtimeRevision) { readyRuntimes.add(actor.uid); return; }
    const status = health ? await actorJson(name, 'GET', '/status') : null;
    if (allowBusy && (status?.busy || status?.pendingRequests)) return;
    if (status?.pendingRequests) throw new HttpError(409, 'Wait for the current reply before updating the runtime');
    const worker = actor.workerAssignment;
    if (!worker?.workerPodUid) throw new HttpError(503, 'Actor has no current worker');
    const podUid = (await kube(['-n', worker.workerNamespace, 'get', 'pod', worker.workerPod, '-o', 'jsonpath={.metadata.uid}'])).trim();
    const current = await getActor(name);
    if (!permitted() || current.uid !== actor.uid || current.state !== 'ACTOR_STATE_RUNNING' ||
        current.workerAssignment?.workerPodUid !== worker.workerPodUid || podUid !== worker.workerPodUid) {
      throw new HttpError(409, 'Actor state or worker assignment changed');
    }
    stopChannels(name);
    const abort = new AbortController();
    const channel = { destroy: () => abort.abort() };
    if (!channels.has(name)) channels.set(name, new Set());
    channels.get(name).add(channel);
    try {
      const result = await new Promise((resolveUpgrade, reject) => {
        const helper = spawn('kubectl', [...kubectl, '-n', worker.workerNamespace, 'exec', '-i', worker.workerPod,
          '-c', 'ateom', '--', `/var/lib/ate/static-files/gvisor-${gvisorDigest}/runsc`,
          `--root=/var/lib/ate/actors/${actor.uid}/runsc-state`, 'exec', 'agent', '/usr/local/bin/node', '-e', runtimeUpgrader],
        { stdio: ['pipe', 'pipe', 'pipe'], signal: abort.signal });
        let output = '';
        const timer = setTimeout(() => helper.kill(), 30_000);
        helper.stdout.on('data', chunk => { if (output.length < 4096) output += chunk; else helper.kill(); });
        helper.stderr.on('data', () => {});
        helper.stdin.on('error', () => {});
        helper.on('error', reject);
        helper.on('close', code => {
          clearTimeout(timer);
          try { if (code !== 0) throw new Error('Runtime upgrade stopped'); resolveUpgrade(JSON.parse(output)); }
          catch (error) { reject(error); }
        });
        helper.stdin.end(runtimeBundle);
      });
      if (!permitted()) throw new HttpError(409, 'Actor is suspending');
      if (result.busy) throw new HttpError(409, 'Wait for the current reply before updating the runtime');
      if (result.runtimeRevision !== runtimeRevision) throw new Error('Unexpected runtime revision');
      if (![80, 8080].includes(result.port)) throw new Error('Unexpected actor port');
      record.port = result.port; save();
      readyRuntimes.add(actor.uid);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'Actor runtime update stopped; no message was sent. Retry explicitly while running');
    } finally { channels.get(name)?.delete(channel); }
  })().finally(() => { if (upgrades.get(name) === upgrading) upgrades.delete(name); });
  upgrades.set(name, upgrading);
  return upgrading;
}
async function proxy(name, path, request, response) {
  if (!path.startsWith('/events')) await ensureRuntime(name, path !== '/messages');
  else if (upgrades.has(name)) throw new HttpError(409, 'Actor runtime is being updated; Suspend remains available');
  const actor = await getActor(name);
  const record = metadata[name];
  const permitted = () => record.enabled && !record.blocked && metadata[name] === record;
  if (actor.state !== 'ACTOR_STATE_RUNNING' || !permitted()) throw new HttpError(409, 'Explicitly Resume this actor before reading or sending messages');
  const assignment = actor.workerAssignment;
  if (!assignment?.workerPodUid) throw new HttpError(503, 'Actor has no current worker');
  const connection = await workerForward(assignment);
  const credential = await refreshCredentials();
  const input = request.method === 'POST' ? await body(request) : null;
  if (!permitted()) throw new HttpError(409, 'Actor is suspending');
  await new Promise(resolveProxy => {
    const upstream = https.request({
      hostname: '127.0.0.1', port: connection.port, path, method: request.method, agent: false,
      cert: credential.cert, key: credential.key, ca: credential.ca, rejectUnauthorized: true,
      checkServerIdentity: (_hostname, certificate) => verifyWorker(connection, certificate),
      headers: { 'ate-target-actor': `${space}/${name}`, 'X-Ate-Target-Port': String(record.port || 80), 'Content-Type': 'application/json', Accept: request.headers.accept || 'application/json' },
    }, incoming => {
      noStore(response);
      response.writeHead(incoming.statusCode, { 'Content-Type': incoming.headers['content-type'] || 'application/json' });
      incoming.pipe(response);
      incoming.on('end', resolveProxy);
      incoming.on('error', () => { response.destroy(); resolveProxy(); });
    });
    if (!channels.has(name)) channels.set(name, new Set());
    channels.get(name).add(upstream);
    const cleanup = () => { channels.get(name)?.delete(upstream); resolveProxy(); };
    upstream.on('close', cleanup);
    upstream.on('error', () => { fail(response, new HttpError(503, 'Actor connection closed; no message was automatically resent')); cleanup(); });
    response.on('close', () => upstream.destroy());
    if (path !== '/rpc' && path !== '/events' && !path.startsWith('/events?')) upstream.setTimeout(90_000, () => upstream.destroy());
    upstream.end(input === null ? undefined : JSON.stringify(input));
  });
}

const assets = new Map([['/', ['web/index.html', 'text/html']], ['/app.js', ['web/app.js', 'text/javascript']], ['/style.css', ['web/style.css', 'text/css']]]);
const server = createServer(async (request, response) => {
  noStore(response);
  try {
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host)) throw new HttpError(403, 'Invalid local Host');
    const origin = request.headers.origin;
    if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) throw new HttpError(403, 'Invalid local Origin');
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site request rejected');
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (request.method === 'GET' && assets.has(url.pathname)) {
      const [file, type] = assets.get(url.pathname);
      response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      response.end(readFileSync(join(directory, file)));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/actors') {
      json(response, 200, { actors: (await actors()).map(actor => ({ name: actor.name, uid: actor.uid, state: actor.state, enabled: metadata[actor.name]?.enabled && !metadata[actor.name]?.blocked })) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/actors') {
      const { name } = await body(request);
      if (typeof name !== 'string' || name.length > 63 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
        throw new HttpError(400, 'Use a name of up to 63 lowercase letters, digits, and hyphens, starting with a letter');
      }
      if (creating.has(name)) throw new HttpError(409, 'Actor creation is already in progress');
      creating.add(name);
      try {
        if ((await actors(true)).some(actor => actor.name === name)) throw new HttpError(409, 'Actor already exists');
        const deployment = JSON.parse(readFileSync(join(state, 'deployed.json')));
        if (deployment.atespace !== space) throw new HttpError(503, 'Unexpected deployment metadata');
        const created = await ate(['create', 'actor', name, '-a', space, '--template', deployment.template], 180_000);
        const actor = created.actor || created;
        metadata[name] = { uid: actor.metadata.uid, enabled: false, blocked: true };
        save();
        actorCache = null;
        if (actor.status.state !== 'ACTOR_STATE_SUSPENDED') throw new HttpError(503, 'Unexpected initial state; inspect the new actor');
        const policyFile = join(state, `${name}-egress.json`);
        atomicJson(policyFile, { metadata: { atespace: space, name: 'default' }, rules: [
          { tlsPassthrough: { hostnames: ['chatgpt.com', 'auth.openai.com', 'api.openai.com'], ports: { numbers: [443] } } },
        ] });
        await ate(['create', 'egress-policy', name, '-a', space, '-f', policyFile]);
        json(response, 201, { name, uid: actor.metadata.uid, state: actor.status.state });
      } finally { creating.delete(name); }
      return;
    }
    const match = url.pathname.match(/^\/api\/actors\/([a-z0-9-]+)\/(resume|suspend|delete|login-copy|status|settings|threads|requests|rpc|protocol|network|login|history|events|messages)$/);
    if (!match) throw new HttpError(404, 'Not found');
    const [, name, operation] = match;
    if (operation === 'network') {
      if (!['GET', 'POST'].includes(request.method)) throw new HttpError(405, 'Use GET or POST');
      const actor = await getActor(name);
      if (actor.uid !== metadata[name]?.uid) throw new HttpError(409, 'Actor identity changed');
      const policy = await ate(['get', 'egress-policy', name, '-a', space]);
      if (request.method === 'GET') json(response, 200, { hosts: policy.rules.flatMap(rule => rule.tlsPassthrough?.hostnames || []) });
      else {
        const input = await body(request);
        if (!Array.isArray(input.hosts) || input.hosts.length > 40 || !input.hosts.every(host => typeof host === 'string' && host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host))) throw new HttpError(400, 'Enter exact DNS hostnames without protocols, ports, or wildcards');
        // Preserve non-TLS rules and the required subscription destinations.
        const hosts = [...new Set(['chatgpt.com', 'auth.openai.com', 'api.openai.com', ...input.hosts])];
        policy.rules = [...policy.rules.filter(rule => !rule.tlsPassthrough), { tlsPassthrough: { hostnames: hosts, ports: { numbers: [443] } } }];
        const file = join(state, `${name}-egress.json`); atomicJson(file, policy);
        await ate(['update', 'egress-policy', name, '-a', space, '-f', file]);
        json(response, 200, { hosts });
      }
    } else if (operation === 'login-copy') {
      if (request.method !== 'POST') throw new HttpError(405, 'Use POST');
      const { source } = await body(request);
      if (typeof source !== 'string' || !/^[a-z0-9-]+$/.test(source) || source === name) throw new HttpError(400, 'Select another actor as the sign-in source');
      // Check the target first, so a rejected copy does not read any source credential.
      await actorJson(name, 'GET', '/status');
      const cache = await actorJson(source, 'GET', '/auth/export');
      json(response, 200, await actorJson(name, 'POST', '/auth/import', cache));
    } else if (['resume', 'suspend', 'delete'].includes(operation)) {
      if (request.method !== 'POST') throw new HttpError(405, 'Use POST');
      const record = metadata[name];
      if (!record) throw new HttpError(404, 'Select an existing actor first');
      if (record.operation) throw new HttpError(409, 'A lifecycle operation is already in progress');
      record.blocked = true;
      record.operation = operation;
      readyRuntimes.delete(record.uid);
      save();
      stopChannels(name);
      try {
        const actor = await getActor(name);
        if (actor.uid !== record.uid) throw new HttpError(409, 'Actor identity changed');
        if (operation === 'delete') {
          const confirmation = await body(request);
          if (confirmation.uid !== actor.uid || confirmation.confirmName !== name) throw new HttpError(409, 'Confirm the current actor name and identity');
          await command(ateBinary, [...kubectl, 'delete', 'actor', name, '-a', space, '--any-state'], 180_000);
          delete metadata[name];
          json(response, 200, { deleted: name });
          return;
        }
        // Lifecycle calls do not wait for the agent or its reply stream.
        const result = await ate([operation, 'actor', name, '-a', space], 180_000);
        const current = result.actor || result;
        if (current.metadata?.uid && current.metadata.uid !== actor.uid) throw new HttpError(409, 'Actor identity changed');
        if (operation === 'resume' && current.status?.state === 'ACTOR_STATE_RUNNING') {
          record.enabled = true;
          record.blocked = false;
        } else record.enabled = false;
        json(response, 200, { state: current.status?.state });
      } finally { delete record.operation; save(); actorCache = null; }
      if (operation === 'resume' && record.enabled && !record.blocked) ensureRuntime(name).catch(() => {});
    } else {
      const allowedMethods = ['settings', 'threads', 'requests'].includes(operation) ? ['GET', 'POST'] : ['login', 'messages', 'rpc'].includes(operation) ? ['POST'] : ['GET'];
      if (!allowedMethods.includes(request.method)) throw new HttpError(405, 'Unsupported method');
      await proxy(name, `/${operation}${url.search}`, request, response);
    }
  } catch (error) { fail(response, error); }
});
server.requestTimeout = 30_000;
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Port 4189 is already occupied; existing listener was preserved' : 'Console startup failed'); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`Agent console: http://127.0.0.1:${port}/`);
  const timer = setInterval(() => refreshCredentials().catch(() => {}), 60_000);
  timer.unref();
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  for (const requests of channels.values()) for (const request of requests) request.destroy();
  for (const entry of forwards.values()) entry.process.kill();
  server.close(() => process.exit(0));
});
