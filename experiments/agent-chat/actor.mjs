import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, body, fail, HttpError, json, noStore } from './common.mjs';

const state = process.env.AGENT_STATE || '/state/chat';
const codexHome = process.env.CODEX_HOME || '/state/codex';
const workspace = '/state/workspace';
const runtimeRevision = 'native-codex-v2.5';
const tools = { commands: true, files: true, webSearch: true, nativeProtocol: true, workspace };
const developerInstructions = 'Run user work inside /state/workspace in this Substrate actor. Preserve /app service files, /state/chat records, and /state/codex credentials. Substrate suspend and resume are controlled outside this process.';
const nativeMethods = new Set(JSON.parse(readFileSync('/app/protocol-methods.json')).methods);
mkdirSync(state, { recursive: true, mode: 0o700 });
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
mkdirSync(workspace, { recursive: true, mode: 0o700 });
mkdirSync(process.env.HOME || '/state/home', { recursive: true, mode: 0o700 });
if (!existsSync(join(codexHome, 'config.toml'))) copyFileSync('/app/config.toml', join(codexHome, 'config.toml'));
const metadataFile = join(state, 'session.json');
const journalFile = join(state, 'events.jsonl');
const metadata = existsSync(metadataFile) ? JSON.parse(readFileSync(metadataFile)) : {};
const events = existsSync(journalFile)
  ? readFileSync(journalFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
let sequence = events.at(-1)?.seq || 0;
// Older journals did not carry a thread ID. Keep their ownership stable after selection.
if (metadata.threadId && !metadata.legacyThreadId) {
  metadata.legacyThreadId = metadata.threadId;
  atomicJson(metadataFile, metadata);
}
let activeTurn = null;
let submitting = false;
const loadedThreads = new Set();
const serverRequests = new Map();
let activeThread = null;
let login = null;
let importing = false;
let completedTurn = null;
const finishedThreads = new Map();
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
    serverRequests.clear();
    loadedThreads.clear();
    if (activeTurn || submitting) record('turn/transportFailed', { turnId: activeTurn, error: { message: 'Codex process stopped' } });
    activeTurn = null;
    submitting = false;
    for (const response of listeners) response.end();
    listeners.clear();
  });
  createInterface({ input: child.stdout }).on('line', handleMessage);
  initialized = rpc('initialize', {
    clientInfo: { name: 'substrate_agent_chat', title: 'Substrate Agent Chat', version: '2.0.0' }, capabilities: { experimentalApi: true },
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
    const timer = timeout > 0 ? setTimeout(() => { pending.delete(id); reject(new HttpError(504, 'Codex request timed out')); }, timeout) : null;
    pending.set(id, { resolve, reject, timer });
    try { send({ id, method, params }); }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
}

function visibleParams(value) {
  const params = structuredClone(value || {});
  function clean(item) {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'reasoning') delete item.content;
    for (const [key, child] of Object.entries(item)) {
      if (key === 'error' && child) item[key] = publicError(typeof child === 'string' ? { message: child } : child);
      else if (child && typeof child === 'object') clean(child);
    }
  }
  clean(params);
  return params;
}
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
    // Native requests remain pending until an explicit client response. Suspend does
    // not resolve or cancel them; the whole process belongs to the actor snapshot.
    serverRequests.set(message.id, { id: message.id, method: message.method, params: visibleParams(message.params) });
    record('server/request', serverRequests.get(message.id));
    return;
  }
  if (message.method === 'account/login/completed') {
    login = null;
    record('auth/completed', { success: message.params.success, error: message.params.error ? publicError({ message: message.params.error }) : null });
    return;
  }
  // Raw reasoning is not an exposed summary. Keep all other native process events.
  if (message.method?.startsWith('item/reasoning/') && !message.method.includes('summary')) return;
  if (message.method?.startsWith('account/')) return;
  const params = visibleParams(message.params);
  if (message.method === 'turn/started' && (!activeThread || activeThread === params.threadId)) { activeTurn = params.turn?.id; activeThread = params.threadId; }
  if (message.method === 'turn/completed') {
    completedTurn = params.turn?.id;
    finishedThreads.set(params.threadId, sequence + 1);
    if (activeThread === params.threadId) { activeTurn = null; activeThread = null; submitting = false; }
    for (const [id, request] of serverRequests) if (request.params.turnId === completedTurn) serverRequests.delete(id);
  }
  if (message.method === 'thread/status/changed' && params.status?.type === 'idle') {
    finishedThreads.set(params.threadId, sequence + 1);
    if (activeThread === params.threadId) { activeTurn = null; activeThread = null; }
  }
  if (message.method === 'serverRequest/resolved') serverRequests.delete(params.requestId);
  record(message.method, params);
}

startCodex();

async function account() {
  if (importing) throw new HttpError(409, 'Sign-in import is in progress');
  await initialized;
  const result = await rpc('account/read', { refreshToken: false });
  return result.account ? { type: result.account.type, planType: result.account.planType } : null;
}

function threadEvents(threadId) {
  return events.filter(event => {
    const owner = event.params?.threadId || (event.method === 'server/request' ? event.params.params?.threadId : null);
    return owner ? owner === threadId : !threadId || threadId === metadata.legacyThreadId || event.method.startsWith('auth/');
  });
}
function idle() {
  if (submitting || activeTurn || serverRequests.size) throw new HttpError(409, 'Wait for the active turn and pending requests');
}
function selectThread(result) {
  metadata.threadId = result.thread.id;
  metadata.model = result.model || metadata.model;
  atomicJson(metadataFile, metadata);
  loadedThreads.add(result.thread.id);
  return result.thread.id;
}
async function thread() {
  if (!metadata.threadId) {
    const result = await rpc('thread/start', { model: metadata.model || undefined,
      ...(metadata.effort ? { config: { model_reasoning_effort: metadata.effort } } : {}), cwd: workspace, approvalPolicy: 'on-request',
      sandbox: 'danger-full-access', developerInstructions });
    selectThread(result);
  } else if (!loadedThreads.has(metadata.threadId)) {
    const result = await rpc('thread/resume', { threadId: metadata.threadId, cwd: workspace,
      model: metadata.model || undefined, approvalPolicy: 'on-request', sandbox: 'danger-full-access', developerInstructions });
    selectThread(result);
  }
  return metadata.threadId;
}
async function nativeCall(method, params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new HttpError(400, 'Native parameters must be a JSON object');
  if (!nativeMethods.has(method) || method === 'initialize') throw new HttpError(400, 'Unknown native method');
  // Subscription credentials stay actor-local and use the existing device-code flow.
  if ((method.startsWith('account/') && !['account/read', 'account/rateLimits/read'].includes(method)) || method === 'attestation/generate') throw new HttpError(400, 'Use the actor sign-in controls');
  if (['thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'review/start'].includes(method)) idle();
  const turnOperation = ['turn/start', 'review/start'].includes(method);
  const sessionOperation = ['thread/start', 'thread/resume', 'thread/fork'].includes(method);
  if (turnOperation || sessionOperation) submitting = true;
  const startedAt = sequence;
  const forkHistory = method === 'thread/fork' ? threadEvents(params.threadId) : null;
  try {
    await initialized;
    if (turnOperation && (await account())?.type !== 'chatgpt') throw new HttpError(401, 'Sign in with ChatGPT first');
    if (method === 'turn/start' || method === 'turn/steer') {
      record('user/message', { threadId: params.threadId,
        text: (params.input || []).filter(item => item.type === 'text').map(item => item.text).join('\n') });
    }
    if (turnOperation) activeThread = params.threadId;
    const result = await rpc(method, method === 'thread/fork' ? { excludeTurns: true, ...params } : params, 0);
    if (sessionOperation) selectThread(result);
    if (method === 'thread/fork') {
      record('thread/journal', { threadId: result.thread.id, events: forkHistory.filter(event => !event.method.startsWith('server')) });
    }
    if (turnOperation && result.turn?.status === 'inProgress' && (finishedThreads.get(result.reviewThreadId || params.threadId) || 0) <= startedAt) {
      activeTurn = result.turn.id; activeThread = result.reviewThreadId || params.threadId;
    }
    if (method === 'thread/delete') {
      loadedThreads.delete(params.threadId);
      if (metadata.threadId === params.threadId) { delete metadata.threadId; delete metadata.model; delete metadata.effort; }
      if (metadata.legacyThreadId === params.threadId) delete metadata.legacyThreadId;
      atomicJson(metadataFile, metadata);
    }
    return visibleParams(result);
  } finally { if (turnOperation || sessionOperation) submitting = false; if (turnOperation && !activeTurn) activeThread = null; }
}

const server = createServer(async (request, response) => {
  noStore(response);
  const url = new URL(request.url, 'http://actor');
  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, { service: 'substrate-agent-chat', codexVersion: '0.162.1', runtimeRevision, tools });
    } else if (request.method === 'GET' && url.pathname === '/status') {
      json(response, 200, { account: await account(), busy: submitting || Boolean(activeTurn), model: metadata.model || null, threadId: metadata.threadId || null, activeTurn, activeThread, pendingRequests: serverRequests.size, lastSeq: sequence, runtimeRevision, tools });
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
        loadedThreads.clear();
        startCodex();
        await initialized;
        const result = await rpc('account/read', { refreshToken: false });
        if (result.account?.type !== 'chatgpt') throw new HttpError(401, 'Imported sign-in is unavailable');
        record('auth/completed', { success: true, error: null });
        json(response, 200, { imported: true });
      } finally { importing = false; }
    } else if (request.method === 'GET' && url.pathname === '/settings') {
      await initialized;
      const models = await rpc('model/list', {});
      let model = metadata.model || models.data.find(row => row.isDefault)?.model;
      let reasoningEffort = metadata.effort ?? null;
      if (metadata.threadId) {
        const read = await rpc('thread/read', { threadId: metadata.threadId, includeTurns: false });
        model = read.thread.model || model;
        reasoningEffort = metadata.effort ?? read.thread.reasoningEffort ?? null;
      }
      json(response, 200, { models: models.data, model, reasoningEffort,
        modelDefaultReasoningEffort: models.data.find(row => row.model === model)?.defaultReasoningEffort ?? null });
    } else if (request.method === 'POST' && url.pathname === '/settings') {
      idle();
      const input = await body(request);
      const models = (await rpc('model/list', {})).data;
      const model = models.find(row => row.model === input.model);
      if (!model || (input.effort !== null && !model.supportedReasoningEfforts.some(row => row.reasoningEffort === input.effort))) throw new HttpError(400, 'Select an available model and effort');
      if (metadata.threadId) {
        selectThread(await rpc('thread/resume', { threadId: metadata.threadId, model: input.model,
          config: { model_reasoning_effort: input.effort ?? model.defaultReasoningEffort } }));
      }
      metadata.model = input.model; metadata.effort = input.effort;
      atomicJson(metadataFile, metadata);
      json(response, 200, { updated: true });
    } else if (request.method === 'GET' && url.pathname === '/threads') {
      await initialized;
      const result = await rpc('thread/list', { limit: 100, cursor: url.searchParams.get('cursor') || undefined });
      // Preserve access to older client origins excluded by native list defaults.
      if (!url.searchParams.get('cursor') && metadata.legacyThreadId && !result.data.some(row => row.id === metadata.legacyThreadId)) {
        result.data.push((await rpc('thread/read', { threadId: metadata.legacyThreadId, includeTurns: false })).thread);
      }
      json(response, 200, { ...result, selected: metadata.threadId || null });
    } else if (request.method === 'POST' && url.pathname === '/threads') {
      idle();
      const input = await body(request);
      if (input.action === 'select') {
        const result = await rpc('thread/read', { threadId: input.threadId, includeTurns: false });
        metadata.threadId = result.thread.id; metadata.model = result.thread.model || null; metadata.effort = result.thread.reasoningEffort ?? null;
        atomicJson(metadataFile, metadata);
      } else if (['new', 'fork'].includes(input.action)) {
        await nativeCall(input.action === 'new' ? 'thread/start' : 'thread/fork', {
          ...(input.action === 'fork' ? { threadId: metadata.threadId } : {}), cwd: workspace,
          model: metadata.model || undefined, approvalPolicy: 'on-request', sandbox: 'danger-full-access', developerInstructions,
        });
      } else throw new HttpError(400, 'Use new, select, or fork');
      json(response, 200, { threadId: metadata.threadId });
    } else if (request.method === 'GET' && url.pathname === '/requests') {
      json(response, 200, { requests: [...serverRequests.values()] });
    } else if (request.method === 'POST' && url.pathname === '/requests') {
      const input = await body(request);
      if (!serverRequests.has(input.id)) throw new HttpError(409, 'Native request is no longer pending');
      if ((input.result === undefined) === (input.error === undefined)) throw new HttpError(400, 'Provide one native result or error');
      send({ id: input.id, ...(input.error === undefined ? { result: input.result } : { error: input.error }) });
      serverRequests.delete(input.id);
      record('serverRequest/resolved', { requestId: input.id });
      json(response, 200, { answered: true });
    } else if (request.method === 'POST' && url.pathname === '/rpc') {
      const input = await body(request);
      json(response, 200, { result: await nativeCall(input.method, input.params), lastSeq: sequence });
    } else if (request.method === 'GET' && url.pathname === '/protocol') {
      json(response, 200, { codexVersion: '0.162.1', methods: [...nativeMethods].filter(method => method !== 'initialize' && (!method.startsWith('account/') || ['account/read', 'account/rateLimits/read'].includes(method))), experimentalApi: true });
    } else if (request.method === 'GET' && url.pathname === '/history') {
      const threadId = metadata.threadId;
      const selectedEvents = threadEvents(threadId);
      // Native sessions created by other clients are readable without resuming them.
      let nativeThread = null;
      if (threadId && !selectedEvents.some(event => ['user/message', 'thread/history', 'thread/journal', 'item/started'].includes(event.method))) {
        const info = (await rpc('thread/read', { threadId, includeTurns: false })).thread;
        if (info.preview) nativeThread = visibleParams((await rpc('thread/read', { threadId, includeTurns: true })).thread);
        else nativeThread = info;
        if (nativeThread.turns?.length) record('thread/history', { threadId, turns: nativeThread.turns });
      }
      json(response, 200, { events: selectedEvents, nativeThread, threadId, lastSeq: sequence });
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
      if (input.mode && !['default', 'plan'].includes(input.mode)) throw new HttpError(400, 'Use default or plan mode');
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16_000) throw new HttpError(400, 'Enter a message of at most 16000 characters');
      if (submitting || activeTurn) throw new HttpError(409, 'Wait for the current reply');
      submitting = true;
      try {
        const signedIn = await account();
        if (signedIn?.type !== 'chatgpt') throw new HttpError(401, 'Sign in with ChatGPT first');
        const threadId = await thread();
        record('user/message', { text: input.text, threadId });
        activeThread = threadId;
        const startedAt = sequence;
        const result = await rpc('turn/start', { threadId, input: [{ type: 'text', text: input.text }],
          cwd: workspace, effort: metadata.effort ?? undefined, approvalPolicy: 'on-request',
          sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' }, summary: 'auto',
          collaborationMode: { mode: input.mode || 'default', settings: { model: metadata.model, reasoning_effort: metadata.effort ?? null, developer_instructions: null } } });
        if (result.turn.status === 'inProgress' && (finishedThreads.get(threadId) || 0) <= startedAt) { activeTurn = result.turn.id; activeThread = threadId; }
        submitting = false;
        json(response, 202, { turnId: result.turn.id });
      } catch (error) {
        submitting = false; if (!activeTurn) activeThread = null;
        record('turn/rejected', { threadId: metadata.threadId, error: publicError(error) });
        throw error;
      }
    } else throw new HttpError(404, 'Not found');
  } catch (error) { fail(response, error); }
});
server.requestTimeout = 30_000;
server.listen(Number(process.env.AGENT_PORT || 80), '0.0.0.0');
process.on('SIGTERM', () => { child.kill('SIGTERM'); server.close(); setTimeout(() => process.exit(0), 500).unref(); });
