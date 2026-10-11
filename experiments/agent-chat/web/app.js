const element = id => document.getElementById(id);
let selected = null;
let rows = [];
let stream = null;
let lastSeq = 0;
let busy = false;
let authenticated = false;
let nativeAvailable = false;
let lifecycle = false;
let loading = false;
let generation = 0;
let settingsReadAt = 0;
const entries = new Map();
const requestCards = new Map();
let modelCatalog = [];
let selectedThread = null;
let activeTurn = null;
let activeThread = null;
let threadsCursor = null;
let threadsReadAt = 0;

function notice(text, error = false) { element('notice').textContent = text; element('notice').classList.toggle('error', error); }
async function api(path, method = 'GET', value) {
  const response = await fetch(path, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
const path = operation => `/api/actors/${selected}/${operation}`;
function running() { const actor = rows.find(row => row.name === selected); return actor?.state === 'ACTOR_STATE_RUNNING' && actor.enabled; }
function controls() {
  const actor = rows.find(row => row.name === selected);
  element('resume').disabled = !actor || lifecycle || (actor.state === 'ACTOR_STATE_RUNNING' && actor.enabled) || ['ACTOR_STATE_RESUMING', 'ACTOR_STATE_SUSPENDING'].includes(actor.state);
  element('suspend').disabled = !actor || lifecycle || actor.state !== 'ACTOR_STATE_RUNNING';
  element('delete').disabled = !actor || lifecycle;
  element('message').disabled = !running() || !authenticated || busy || lifecycle;
  element('send').disabled = element('message').disabled;
  element('message').placeholder = !running() ? 'Resume this actor to read history and send messages' : !authenticated ? 'Sign in with ChatGPT first' : busy ? 'Waiting for the current reply' : 'Message this agent';
  element('message').disabled = !running() || !authenticated || lifecycle;
  element('send').disabled = element('message').disabled || busy;
  element('steer').disabled = element('message').disabled || !activeTurn;
  element('mode').disabled = !running() || !nativeAvailable || busy || lifecycle;
  element('native-controls').hidden = !running() || !nativeAvailable;
  element('requests').hidden = !running() || !requestCards.size;
  for (const id of ['threads', 'new-thread', 'fork-thread', 'save-settings', 'model-value', 'effort-value', 'review']) element(id).disabled = !running() || busy || lifecycle;
  element('fork-thread').disabled ||= !selectedThread;
  element('review').disabled ||= !selectedThread;
  element('interrupt').disabled = !running() || !activeTurn || lifecycle;
  for (const id of ['rpc-send', 'inspect-native', 'save-network']) element(id).disabled = !running() || lifecycle;
  for (const card of requestCards.values()) for (const control of card.querySelectorAll('button, input, textarea, select')) control.disabled = !running() || lifecycle;
  element('account').hidden = !running();
  element('model-settings').hidden = !running() || !authenticated || !nativeAvailable;
  element('tool-settings').hidden = !running();
  element('login').hidden = authenticated || !running();
  element('login').disabled = lifecycle;
  const previousSource = element('login-source').value;
  const sources = rows.filter(row => row.name !== selected && row.enabled && row.state === 'ACTOR_STATE_RUNNING');
  element('login-source').replaceChildren(...sources.map(row => {
    const option = document.createElement('option'); option.value = row.name; option.textContent = row.name; return option;
  }));
  if (sources.some(row => row.name === previousSource)) element('login-source').value = previousSource;
  element('copy-login').hidden = authenticated || !running() || !sources.length;
  element('copy').disabled = lifecycle;
}
function entry(key, label, kind) {
  if (entries.has(key)) return entries.get(key);
  const block = document.createElement('div');
  block.className = `entry ${kind}`;
  const heading = document.createElement('strong'); heading.textContent = label;
  const text = document.createElement('pre');
  block.append(heading, text); element('history').append(block);
  entries.set(key, { text, heading, command: '', output: '' });
  return entries.get(key);
}
function render(event) {
  if (event.seq <= lastSeq) return;
  lastSeq = event.seq;
  const p = event.params || {};
  element('native-events').textContent = [...element('native-events').textContent.split('\n').filter(Boolean).slice(-99), `${event.seq} ${event.method}`].join('\n');
  const owner = p.threadId || (event.method === 'server/request' ? p.params?.threadId : null);
  if (owner && selectedThread && owner !== selectedThread) return;
  if (event.method === 'server/request' || event.method === 'serverRequest/resolved') {
    refreshRequests().catch(error => notice(error.message, true)); return;
  }
  if (event.method === 'thread/journal') {
    const cursor = lastSeq;
    for (const inherited of p.events || []) {
      render({ ...inherited, seq: lastSeq + 1, params: { ...inherited.params, threadId: selectedThread } });
    }
    lastSeq = cursor; return;
  }
  if (event.method === 'thread/history') { renderNativeTurns(p.turns); return; }
  if (event.method === 'user/message') entry(`user-${event.seq}`, 'You', 'user').text.textContent = p.text;
  else if (event.method === 'item/agentMessage/delta') entry(p.itemId, 'Agent', 'agent').text.textContent += p.delta;
  else if (event.method === 'item/reasoning/summaryTextDelta') entry(`${p.itemId}-summary-${p.summaryIndex || 0}`, 'Thinking summary', 'thinking').text.textContent += p.delta;
  else if (['item/started', 'item/completed'].includes(event.method)) {
    const item = p.item;
    if (item?.type === 'agentMessage') {
      const block = entry(item.id, item.phase === 'commentary' ? 'Progress' : 'Agent', 'agent');
      block.heading.textContent = item.phase === 'commentary' ? 'Progress' : 'Agent';
      if (item.text) block.text.textContent = item.text;
    } else if (item?.type === 'reasoning') {
      (item.summary || []).forEach((text, index) => { entry(`${item.id}-summary-${index}`, 'Thinking summary', 'thinking').text.textContent = typeof text === 'string' ? text : text.text || ''; });
    } else if (item?.type === 'commandExecution') {
      const block = entry(item.id, 'Command', 'system');
      block.command = item.command || block.command;
      if (item.aggregatedOutput !== null && item.aggregatedOutput !== undefined) block.output = item.aggregatedOutput;
      block.heading.textContent = `Command · ${item.status || 'running'}${item.exitCode === null || item.exitCode === undefined ? '' : ` · exit ${item.exitCode}`}`;
      block.text.textContent = `${block.command}\n${block.output}`;
    } else if (item?.type === 'fileChange') {
      const block = entry(item.id, `Files · ${item.status || 'running'}`, 'system');
      block.heading.textContent = `Files · ${item.status || 'completed'}`;
      block.text.textContent = (item.changes || []).map(change => `${change.kind?.type || 'change'} ${change.path}\n${change.diff || ''}`).join('\n');
    } else if (item?.type === 'exitedReviewMode') {
      entry(item.id, 'Review', 'agent').text.textContent = item.review || 'Review completed';
    } else if (item?.type === 'plan') {
      entry(item.id, 'Plan', 'agent').text.textContent = item.text || '';
    } else if (item && !['userMessage', 'reasoning'].includes(item.type)) {
      entry(item.id, 'Process', 'system').text.textContent = `${item.type}: ${item.status || (event.method === 'item/completed' ? 'completed' : 'started')}`;
    }
  } else if (event.method === 'item/commandExecution/outputDelta') {
    const block = entry(p.itemId, 'Command · running', 'system');
    block.output += p.delta;
    block.text.textContent = `${block.command}\n${block.output}`;
  } else if (event.method === 'item/fileChange/outputDelta') {
    entry(p.itemId, 'Files', 'system').text.textContent += p.delta;
  } else if (event.method === 'turn/started') { busy = true; activeTurn = p.turn?.id; activeThread = p.threadId; notice('Agent is responding. Suspend remains available.'); }
  else if (event.method === 'turn/completed') {
    busy = false; activeTurn = null; activeThread = null;
    const text = p.turn?.error?.message || `Reply ${p.turn?.status || 'completed'}.`;
    notice(text, p.turn?.status === 'failed');
    entry(`turn-${event.seq}`, 'Status', 'system').text.textContent = text;
  } else if (['error', 'turn/rejected', 'turn/transportFailed'].includes(event.method)) {
    if (event.method !== 'error') busy = false;
    const text = p.error?.message || p.message || 'Request failed';
    notice(text, true); entry(`error-${event.seq}`, 'Error', 'system').text.textContent = text;
  } else if (event.method === 'auth/completed') {
    element('login-details').hidden = true;
    notice(p.success ? 'Signed in with ChatGPT.' : p.error?.message || 'Sign-in failed', !p.success);
    refreshStatus().catch(error => notice(error.message, true));
  }
  controls();
  element('history').scrollTop = element('history').scrollHeight;
}
function closeStream() { stream?.close(); stream = null; }
async function refreshStatus() {
  if (!running()) return;
  const current = generation;
  const status = await api(path('status'));
  if (current !== generation) return;
  authenticated = status.account?.type === 'chatgpt'; nativeAvailable = Boolean(status.tools?.nativeProtocol);
  busy = status.busy; activeTurn = status.activeTurn; activeThread = status.activeThread;
  selectedThread = status.threadId;
  if (status.pendingRequests || requestCards.size) refreshRequests().catch(() => {});
  if (nativeAvailable && Date.now() - threadsReadAt > 30_000) refreshThreads().catch(() => {});
  element('account-state').textContent = authenticated ? `ChatGPT${status.account.planType ? ` · ${status.account.planType}` : ''}` : 'Not signed in';
  element('tool-value').textContent = status.tools?.commands && status.tools?.files
    ? `Native Codex · commands and files · ${status.tools.workspace}` : 'Runtime update pending';
  if (nativeAvailable && authenticated && Date.now() - settingsReadAt >= 60_000) refreshSettings().catch(() => {});
  controls();
}
function options(select, values, selectedValue) {
  select.replaceChildren(...values.map(({ value, label }) => {
    const option = document.createElement('option'); option.value = value; option.textContent = label; return option;
  }));
  if (values.some(row => row.value === selectedValue)) select.value = selectedValue;
}
function effortOptions(effort = '') {
  const model = modelCatalog.find(row => row.model === element('model-value').value);
  options(element('effort-value'), [{ value: '', label: 'Model default' }, ...(model?.supportedReasoningEfforts || []).map(row => ({ value: row.reasoningEffort, label: row.reasoningEffort }))], effort || '');
  element('default-effort-value').textContent = model?.defaultReasoningEffort || 'Unavailable';
}
async function refreshSettings() {
  if (!running() || !authenticated) return;
  const current = generation; settingsReadAt = Date.now();
  const settings = await api(path('settings'));
  if (current !== generation || !running()) return;
  modelCatalog = settings.models || [];
  options(element('model-value'), modelCatalog.map(row => ({ value: row.model, label: row.displayName || row.model })), settings.model);
  effortOptions(settings.reasoningEffort);
}
function renderNativeTurns(turns = []) {
  // Hydrate actor-owned native history for forks and sessions created by another client.
  for (const turn of turns) for (const item of turn.items || []) {
    if (item.type === 'userMessage') {
      entry(item.id, 'You', 'user').text.textContent = (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    } else {
      const cursor = lastSeq;
      render({ seq: cursor + 1, method: 'item/completed', params: { item } });
      lastSeq = cursor;
    }
  }
}
async function loadConversation() {
  if (!running() || loading) return;
  const current = generation;
  loading = true;
  try {
    await refreshStatus();
    const history = await api(path('history'));
    if (current !== generation || !running()) return;
    selectedThread = history.threadId;
    if (history.nativeThread) renderNativeTurns(history.nativeThread.turns);
    for (const event of history.events) render(event);
    lastSeq = Math.max(lastSeq, history.lastSeq);
    if (nativeAvailable) { await refreshThreads(); await refreshRequests(); }
    closeStream();
    const connection = new EventSource(`${path('events')}?after=${lastSeq}`);
    stream = connection;
    connection.onopen = () => {
      if (current === generation && stream === connection) notice(busy ? 'Agent is responding. Suspend remains available.' : 'Actor connected.');
    };
    connection.onmessage = message => { if (current === generation) render(JSON.parse(message.data)); };
    connection.onerror = () => {
      connection.close();
      if (stream !== connection) return;
      stream = null;
      if (running() && !lifecycle) notice('Actor connection closed. Waiting for its current state.');
    };
  } finally { loading = false; }
}
async function refreshActors() {
  rows = (await api('/api/actors')).actors;
  element('actors').replaceChildren();
  for (const actor of rows) {
    const button = document.createElement('button');
    button.className = `actor${actor.name === selected ? ' selected' : ''}`;
    const name = document.createElement('strong'); name.textContent = actor.name;
    const state = document.createElement('span'); state.textContent = actor.state.replace('ACTOR_STATE_', '');
    button.append(name, state); button.onclick = () => select(actor.name); element('actors').append(button);
  }
  const actor = rows.find(row => row.name === selected);
  if (actor) {
    element('state').textContent = actor.state.replace('ACTOR_STATE_', '') + (!actor.enabled && actor.state === 'ACTOR_STATE_RUNNING' ? ' · Explicit Resume required' : '');
    if (!running()) { closeStream(); authenticated = false; element('login-details').hidden = true; }
  }
  controls();
}
async function select(name) {
  if (selected === name) return;
  closeStream(); generation++; nativeAvailable = false; selected = name; lastSeq = 0; busy = false; authenticated = false; settingsReadAt = 0;
  clearConversation();
  element('name').textContent = name; element('login-details').hidden = true;
  element('state').textContent = rows.find(row => row.name === name)?.state.replace('ACTOR_STATE_', '') || 'Reading Substrate state';
  element('account-state').textContent = '';
  element('rpc-params').value = '{}'; element('rpc-method').value = ''; element('network-hosts').value = '';
  modelCatalog = []; element('model-value').replaceChildren(); element('effort-value').replaceChildren();
  notice('History is read from the actor only while it is running.');
  controls();
  await refreshActors();
  try { if (running()) await loadConversation(); } catch (error) { if (running() && !lifecycle) notice(error.message, true); }
}
element('create-form').onsubmit = async event => {
  event.preventDefault();
  const name = element('actor-name').value.trim();
  element('create').disabled = true;
  notice('Creating a suspended actor.');
  try {
    await api('/api/actors', 'POST', { name });
    element('actor-name').value = '';
    await select(name);
    notice('Actor created in suspended state. Click Resume when ready.');
  } catch (error) { notice(error.message, true); }
  finally { element('create').disabled = false; await refreshActors().catch(() => {}); }
};
element('delete').onclick = async () => {
  const actor = rows.find(row => row.name === selected);
  if (!actor || !confirm(`Delete ${actor.name}? Its conversation history and sign-in state will be removed. This cannot be undone.`)) return;
  lifecycle = true; closeStream(); controls();
  settingsReadAt = 0;
  notice('Deleting the actor.');
  try {
    await api(path('delete'), 'POST', { uid: actor.uid, confirmName: actor.name });
    if (selected === actor.name) {
      generation++; selected = null; lastSeq = 0; busy = false; authenticated = false;
      entries.clear(); element('history').replaceChildren(); element('message').value = '';
      element('name').textContent = 'Select an actor'; element('state').textContent = '';
      element('login-details').hidden = true;
    }
    notice('Actor deleted.');
  } catch (error) { notice(error.message, true); }
  finally { lifecycle = false; await refreshActors().catch(() => {}); controls(); }
};
for (const operation of ['resume', 'suspend']) element(operation).onclick = async () => {
  lifecycle = true; closeStream(); controls();
  settingsReadAt = 0;
  notice(operation === 'suspend' ? 'Suspend requested. Substrate is saving the actor.' : 'Resume requested. Waiting for Substrate.');
  try {
    await api(path(operation), 'POST', {});
    await refreshActors();
    if (operation === 'resume') { await loadConversation(); notice('Actor is running.'); }
    else notice('Actor suspended. The current display is retained; history cannot be read until Resume.');
  } catch (error) { notice(error.message, true); }
  finally { lifecycle = false; await refreshActors().catch(() => {}); controls(); }
};
element('login').onclick = async () => {
  try {
    const result = await api(path('login'), 'POST', {});
    const link = document.createElement('a'); link.href = result.verificationUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open ChatGPT device sign-in';
    const code = document.createElement('code'); code.textContent = result.userCode;
    element('login-details').replaceChildren(link, code); element('login-details').hidden = false;
    notice('Complete sign-in in your browser. Credentials stay in this actor.');
  } catch (error) { notice(error.message, true); }
};
element('copy-login').onsubmit = async event => {
  event.preventDefault();
  element('copy').disabled = true;
  try {
    await api(path('login-copy'), 'POST', { source: element('login-source').value });
    element('login-details').hidden = true;
    await refreshStatus();
    notice('Sign-in reused. This actor keeps its own conversation.');
  } catch (error) { notice(error.message, true); }
  finally { controls(); }
};
element('composer').onsubmit = async event => {
  event.preventDefault();
  const text = element('message').value;
  if (!text.trim() || element('send').disabled) return;
  busy = true; controls();
  try { await api(path('messages'), 'POST', { text, mode: element('mode').value }); element('message').value = ''; }
  catch (error) { busy = false; notice(error.message, true); controls(); }
};
setInterval(async () => {
  try {
    await refreshActors();
    if (running() && !lifecycle) {
      if (!stream) await loadConversation();
      else await refreshStatus();
    }
  } catch (error) { if (!lifecycle && (running() || !error.message.includes('Resume'))) notice(error.message, true); }
}, 3000);
refreshActors().catch(error => notice(error.message, true));
window.addEventListener('pagehide', () => {
  closeStream(); entries.clear(); element('history').replaceChildren(); element('message').value = '';
  element('login-details').replaceChildren(); clearConversation(); element('rpc-params').value = '{}'; element('rpc-method').value = ''; element('network-hosts').value = '';
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  generation++; lastSeq = 0; busy = false; authenticated = false;
  refreshActors().catch(error => notice(error.message, true));
});

function clearConversation() {
  entries.clear(); element('history').replaceChildren(); element('message').value = '';
  requestCards.clear(); element('requests').replaceChildren(); element('rpc-result').textContent = ''; element('native-events').textContent = '';
  selectedThread = null; activeTurn = null; activeThread = null; threadsReadAt = 0; threadsCursor = null;
  element('threads').replaceChildren(); element('capabilities').textContent = 'Read Skills and MCP status from this actor.';
}
async function native(method, params = {}) { return (await api(path('rpc'), 'POST', { method, params })).result; }
async function refreshThreads(more = false) {
  const current = generation;
  const data = await api(`${path('threads')}${more && threadsCursor ? `?cursor=${encodeURIComponent(threadsCursor)}` : ''}`);
  if (current !== generation || !running()) return;
  const select = element('threads');
  if (!more) select.replaceChildren();
  for (const thread of data.data) {
    const option = document.createElement('option'); option.value = thread.id;
    option.textContent = `${thread.name || thread.preview?.slice(0, 60) || 'Untitled'} · ${thread.id.slice(-8)}`;
    select.append(option);
  }
  if (data.selected && ![...select.options].some(option => option.value === data.selected)) {
    const option = document.createElement('option'); option.value = data.selected; option.textContent = data.selected; select.prepend(option);
  }
  select.value = data.selected || ''; selectedThread = data.selected; threadsCursor = data.nextCursor;
  element('more-threads').hidden = !threadsCursor; threadsReadAt = Date.now();
}
async function changeThread(action, threadId) {
  try {
    await api(path('threads'), 'POST', { action, threadId });
    closeStream(); generation++; lastSeq = 0; settingsReadAt = 0; clearConversation();
    await loadConversation(); await refreshSettings();
  } catch (error) { notice(error.message, true); }
}
element('threads').onchange = () => changeThread('select', element('threads').value);
element('new-thread').onclick = () => changeThread('new');
element('fork-thread').onclick = () => changeThread('fork');
element('more-threads').onclick = () => refreshThreads(true).catch(error => notice(error.message, true));
element('model-value').onchange = () => effortOptions();
element('save-settings').onclick = async () => {
  try {
    await api(path('settings'), 'POST', { model: element('model-value').value, effort: element('effort-value').value || null });
    settingsReadAt = Date.now(); notice('Model and effort applied to this conversation.');
  } catch (error) { notice(error.message, true); }
};
element('interrupt').onclick = async () => {
  try { await native('turn/interrupt', { threadId: activeThread || selectedThread, turnId: activeTurn }); }
  catch (error) { notice(error.message, true); }
};
element('steer').onclick = async () => {
  const text = element('message').value;
  if (!text.trim()) return;
  try {
    await native('turn/steer', { threadId: activeThread || selectedThread, expectedTurnId: activeTurn, input: [{ type: 'text', text }] });
    element('message').value = '';
  } catch (error) { notice(error.message, true); }
};
element('review').onclick = async () => {
  try { await native('review/start', { threadId: selectedThread, target: { type: 'uncommittedChanges' }, delivery: 'inline' }); }
  catch (error) { notice(error.message, true); }
};
element('inspect-native').onclick = async () => {
  const current = generation;
  try {
    const skills = await native('skills/list', { cwds: ['/state/workspace'], forceReload: true });
    const mcp = await native('mcpServerStatus/list', {});
    const protocol = await api(path('protocol'));
    const network = await api(path('network'));
    if (current !== generation) return;
    element('network-hosts').value = network.hosts.join(', ');
    element('capabilities').textContent = `Codex ${protocol.codexVersion} · ${protocol.methods.length} native methods · ${skills.data?.flatMap(row => row.skills || []).length || 0} Skills · ${mcp.data?.length || 0} MCP servers`;
    element('rpc-methods').replaceChildren(...protocol.methods.map(method => { const option = document.createElement('option'); option.value = method; return option; }));
    element('rpc-result').textContent = JSON.stringify({ skills, mcp }, null, 2);
  } catch (error) { notice(error.message, true); }
};
element('network-form').onsubmit = async event => {
  event.preventDefault();
  try {
    const hosts = element('network-hosts').value.split(/[\s,]+/).filter(Boolean);
    const result = await api(path('network'), 'POST', { hosts });
    element('network-hosts').value = result.hosts.join(', '); notice('HTTPS destinations updated. Actor state is unchanged.');
  } catch (error) { notice(error.message, true); }
};
element('rpc-form').onsubmit = async event => {
  event.preventDefault(); const current = generation;
  try {
    const result = await native(element('rpc-method').value, JSON.parse(element('rpc-params').value));
    if (current !== generation) return;
    element('rpc-result').textContent = JSON.stringify(result, null, 2);
    if (['thread/start', 'thread/resume', 'thread/fork', 'thread/delete'].includes(element('rpc-method').value)) {
      closeStream(); generation++; lastSeq = 0; settingsReadAt = 0; clearConversation(); await loadConversation();
    } else await refreshStatus();
  } catch (error) { notice(error.message, true); }
};
async function answerRequest(id, result, error) {
  try { await api(path('requests'), 'POST', { id, ...(error ? { error } : { result }) }); await refreshRequests(); }
  catch (failure) { notice(failure.message, true); }
}
function requestCard(request) {
  const card = document.createElement('form'); card.className = 'request-card';
  const title = document.createElement('strong'); title.textContent = request.method;
  const params = document.createElement('pre'); params.textContent = JSON.stringify(request.params, null, 2);
  card.append(title, params);
  const addButton = (label, action) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.onclick = action; card.append(button);
  };
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) {
    const labels = { accept: 'Approve', acceptForSession: 'Approve for session', decline: 'Decline', cancel: 'Cancel turn' };
    const decisions = request.params.availableDecisions || ['accept', 'acceptForSession', 'decline', 'cancel'];
    for (const decision of decisions) {
      const label = typeof decision === 'string' ? labels[decision] || decision
        : decision.acceptWithExecpolicyAmendment ? 'Approve and remember rule' : 'Apply network rule';
      addButton(label, () => answerRequest(request.id, { decision }));
    }
    card.onsubmit = event => event.preventDefault();
  } else if (request.method === 'item/tool/requestUserInput') {
    const fields = [];
    for (const question of request.params.questions) {
      const label = document.createElement('label'); label.textContent = question.question;
      const input = document.createElement('input'); input.required = true; input.type = question.isSecret ? 'password' : 'text';
      input.placeholder = (question.options || []).map(option => option.label).join(' / ');
      label.append(input); card.append(label); fields.push({ id: question.id, input });
    }
    const submit = document.createElement('button'); submit.textContent = 'Answer'; card.append(submit);
    card.onsubmit = event => {
      event.preventDefault(); answerRequest(request.id, { answers: Object.fromEntries(fields.map(field => [field.id, { answers: [field.input.value] }])) });
    };
  } else {
    const label = document.createElement('label'); label.textContent = 'Native result (JSON)';
    const result = document.createElement('textarea'); result.rows = 3;
    result.value = request.method === 'mcpServer/elicitation/request' ? '{"action":"decline","content":null}' : '{}';
    label.append(result); card.append(label);
    const submit = document.createElement('button'); submit.textContent = 'Send response'; card.append(submit);
    addButton('Report unsupported', () => answerRequest(request.id, undefined, { code: -32601, message: 'This client cannot provide the requested operation' }));
    card.onsubmit = event => {
      event.preventDefault(); try { answerRequest(request.id, JSON.parse(result.value)); } catch (error) { notice(error.message, true); }
    };
  }
  return card;
}
async function refreshRequests() {
  if (!running()) return;
  const current = generation; const data = await api(path('requests'));
  if (current !== generation || !running()) return;
  const ids = new Set(data.requests.map(request => request.id));
  for (const [id, card] of requestCards) if (!ids.has(id)) { card.remove(); requestCards.delete(id); }
  for (const request of data.requests) if (!requestCards.has(request.id)) {
    const card = requestCard(request); requestCards.set(request.id, card); element('requests').append(card);
  }
  controls();
}
