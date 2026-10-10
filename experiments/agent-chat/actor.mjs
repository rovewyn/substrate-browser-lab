import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, body, fail, HttpError, json, noStore } from './common.mjs';

const state = process.env.AGENT_STATE || '/state/chat';
const codexHome = process.env.CODEX_HOME || '/state/codex';
mkdirSync(state, { recursive: true, mode: 0o700 });
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
mkdirSync(process.env.HOME || '/state/home', { recursive: true, mode: 0o700 });
if (!existsSync(join(codexHome, 'config.toml'))) copyFileSync('/app/config.toml', join(codexHome, 'config.toml'));
const metadataFile = join(state, 'session.json');
const journalFile = join(state, 'events.jsonl');
const metadata = existsSync(metadataFile) ? JSON.parse(readFileSync(metadataFile)) : {};
const events = existsSync(journalFile)
  ? readFileSync(journalFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
let sequence = events.at(-1)?.seq || 0;
let activeTurn = null;
let submitting = false;
let loaded = false;
let login = null;
let importing = false;
let completedTurn = null;
let child;
let initialized;
const listeners = new Set();
const pending = new Map();
let nextId = 1;

function record(method, params) {
  const event = { seq: ++sequence, time: new Date().toISOString(), method, params };
  const descriptor = openSync(journalFile, 'a', 0o600);
  try {
    appendFileSync(descriptor, `${JSON.stringify(event)}\n`);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  events.push(event);
  for (const response of listeners) {
    if (!response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)) {
      listeners.delete(response);
      response.destroy();
    }
  }
}

function publicError(error) {
  return {
    message: String(error?.message || 'Codex request failed').slice(0, 1024)
      .replace(/Bearer\s+\S+/gi, 'Bearer <REDACTED>')
      .replace(/\bsk-[\w-]+/g, '<REDACTED>'),
    code: error?.codexErrorInfo || error?.code || null,
  };
}

function startCodex() {
  child = spawn('/app/node_modules/.bin/codex', ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
  });
  // Drain diagnostics without copying potentially sensitive text to Pod logs.
  child.stderr.on('data', () => {});
  child.on('error', () => {});
  child.on('exit', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Codex stopped')); }
    pending.clear();
    if (activeTurn || submitting) record('turn/transportFailed', { turnId: activeTurn, error: { message: 'Codex process stopped' } });
    activeTurn = null;
    submitting = false;
    for (const response of listeners) response.end();
    listeners.clear();
  });
  createInterface({ input: child.stdout }).on('line', handleMessage);
  initialized = rpc('initialize', {
    clientInfo: { name: 'substrate_agent_chat', title: 'Substrate Agent Chat', version: '1.0.0' },
  }).then(() => send({ method: 'initialized' }));
  initialized.catch(() => {});
}

function send(message) {
  if (child.exitCode !== null || child.stdin.destroyed) throw new HttpError(503, 'Codex is unavailable');
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function rpc(method, params = {}, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new HttpError(504, 'Codex request timed out')); }, timeout);
    pending.set(id, { resolve, reject, timer });
    try { send({ id, method, params }); }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
}

const recordedMethods = new Set([
  'turn/started', 'turn/completed', 'item/started', 'item/completed',
  'item/agentMessage/delta', 'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded', 'item/plan/delta',
  'item/commandExecution/outputDelta', 'turn/plan/updated',
  'thread/tokenUsage/updated', 'model/rerouted', 'error', 'warning',
]);
function handleMessage(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && !message.method) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new HttpError(502, publicError(message.error).message));
    else entry.resolve(message.result);
    return;
  }
  if (message.id !== undefined) {
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      send({ id: message.id, result: { decision: 'decline' } });
    } else send({ id: message.id, error: { code: -32601, message: 'Interactive tools are not enabled' } });
    return;
  }
  if (message.method === 'account/login/completed') {
    login = null;
    record('auth/completed', { success: message.params.success, error: message.params.error ? publicError({ message: message.params.error }) : null });
    return;
  }
  if (!recordedMethods.has(message.method)) return;
  const params = structuredClone(message.params || {});
  if (message.method === 'turn/started') activeTurn = params.turn?.id;
  if (message.method === 'turn/completed') { completedTurn = params.turn?.id; activeTurn = null; submitting = false; }
  // Display summaries only; do not duplicate model reasoning blocks.
  if (params.item?.type === 'reasoning') delete params.item.content;
  if (params.turn?.error) params.turn.error = publicError(params.turn.error);
  if (params.error) params.error = publicError(params.error);
  record(message.method, params);
}

startCodex();

async function account() {
  if (importing) throw new HttpError(409, 'Sign-in import is in progress');
  await initialized;
  const result = await rpc('account/read', { refreshToken: false });
  return result.account ? { type: result.account.type, planType: result.account.planType } : null;
}

async function thread() {
  if (loaded) return metadata.threadId;
  if (metadata.threadId) {
    await rpc('thread/resume', { threadId: metadata.threadId, approvalPolicy: 'never', sandbox: 'readOnly' });
  } else {
    const models = await rpc('model/list', {});
    const model = models.data.find(row => row.isDefault);
    if (!model) throw new HttpError(409, 'No default model is available');
    const result = await rpc('thread/start', {
      model: model.model, cwd: state, approvalPolicy: 'never', sandbox: 'readOnly',
      baseInstructions: 'You are a conversational assistant. Reply in the user\'s language. This experiment is for text conversation only. Do not run commands, use tools, or modify files. Share concise progress updates when useful.',
    });
    metadata.threadId = result.thread.id;
    metadata.model = model.model;
    atomicJson(metadataFile, metadata);
  }
  loaded = true;
  return metadata.threadId;
}

const server = createServer(async (request, response) => {
  noStore(response);
  const url = new URL(request.url, 'http://actor');
  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, { service: 'substrate-agent-chat', codexVersion: '0.162.1' });
    } else if (request.method === 'GET' && url.pathname === '/status') {
      json(response, 200, { account: await account(), busy: submitting || Boolean(activeTurn), model: metadata.model || null, lastSeq: sequence });
    } else if (request.method === 'POST' && url.pathname === '/login') {
      if (await account()) throw new HttpError(409, 'Already signed in');
      if (!login) login = await rpc('account/login/start', { type: 'chatgptDeviceCode' });
      json(response, 200, { verificationUrl: login.verificationUrl, userCode: login.userCode });
    } else if (request.method === 'GET' && url.pathname === '/auth/export') {
      if ((await account())?.type !== 'chatgpt') throw new HttpError(401, 'Source actor must be signed in with ChatGPT');
      await rpc('account/read', { refreshToken: true });
      const auth = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8'));
      if (!auth.tokens?.refresh_token || auth.OPENAI_API_KEY) throw new HttpError(409, 'Source has no reusable ChatGPT login cache');
      json(response, 200, { auth });
    } else if (request.method === 'POST' && url.pathname === '/auth/import') {
      const { auth } = await body(request);
      if (submitting || activeTurn) throw new HttpError(409, 'Wait for the current reply');
      if (await account()) throw new HttpError(409, 'Target actor is already signed in');
      if (submitting || activeTurn || importing) throw new HttpError(409, 'Actor is processing another request');
      if (!auth || auth.OPENAI_API_KEY || !['id_token', 'access_token', 'refresh_token'].every(key => typeof auth.tokens?.[key] === 'string' && auth.tokens[key].length > 0)) {
        throw new HttpError(400, 'A ChatGPT login cache is required');
      }
      importing = true;
      try {
        if (login?.loginId) await rpc('account/login/cancel', { loginId: login.loginId });
        login = null;
        const stopped = new Promise(resolveStopped => child.once('close', resolveStopped));
        child.kill('SIGTERM');
        await stopped;
        atomicJson(join(codexHome, 'auth.json'), auth);
        loaded = false;
        startCodex();
        await initialized;
        const result = await rpc('account/read', { refreshToken: false });
        if (result.account?.type !== 'chatgpt') throw new HttpError(401, 'Imported sign-in is unavailable');
        record('auth/completed', { success: true, error: null });
        json(response, 200, { imported: true });
      } finally { importing = false; }
    } else if (request.method === 'GET' && url.pathname === '/history') {
      json(response, 200, { events, lastSeq: sequence });
    } else if (request.method === 'GET' && url.pathname === '/events') {
      const after = Number(url.searchParams.get('after') || request.headers['last-event-id'] || 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'Invalid event cursor');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      for (const event of events) if (event.seq > after) response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      listeners.add(response);
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 10_000);
      response.on('close', () => { clearInterval(heartbeat); listeners.delete(response); });
    } else if (request.method === 'POST' && url.pathname === '/messages') {
      const input = await body(request);
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16_000) throw new HttpError(400, 'Enter a message of at most 16000 characters');
      if (submitting || activeTurn) throw new HttpError(409, 'Wait for the current reply');
      submitting = true;
      try {
        const signedIn = await account();
        if (signedIn?.type !== 'chatgpt') throw new HttpError(401, 'Sign in with ChatGPT first');
        const threadId = await thread();
        record('user/message', { text: input.text });
        const result = await rpc('turn/start', { threadId, input: [{ type: 'text', text: input.text }], summary: 'auto' });
        if (result.turn.status === 'inProgress' && completedTurn !== result.turn.id) activeTurn = result.turn.id;
        submitting = false;
        json(response, 202, { turnId: result.turn.id });
      } catch (error) {
        submitting = false;
        record('turn/rejected', { error: publicError(error) });
        throw error;
      }
    } else throw new HttpError(404, 'Not found');
  } catch (error) { fail(response, error); }
});
server.requestTimeout = 30_000;
server.listen(80, '0.0.0.0', () => console.log('Agent HTTP service listening on port 80'));
