const element = id => document.getElementById(id);
let selected = null;
let rows = [];
let stream = null;
let lastSeq = 0;
let busy = false;
let authenticated = false;
let lifecycle = false;
let loading = false;
let generation = 0;
const entries = new Map();

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
  element('account').hidden = !running();
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
  entries.set(key, { text, heading });
  return entries.get(key);
}
function render(event) {
  if (event.seq <= lastSeq) return;
  lastSeq = event.seq;
  const p = event.params || {};
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
    } else if (item && !['userMessage', 'reasoning'].includes(item.type)) {
      entry(item.id, 'Process', 'system').text.textContent = `${item.type}: ${item.status || (event.method === 'item/completed' ? 'completed' : 'started')}`;
    }
  } else if (event.method === 'turn/started') { busy = true; notice('Agent is responding. Suspend remains available.'); }
  else if (event.method === 'turn/completed') {
    busy = false;
    const text = p.turn?.error?.message || `Reply ${p.turn?.status || 'completed'}.`;
    notice(text, p.turn?.status === 'failed');
    entry(`turn-${event.seq}`, 'Status', 'system').text.textContent = text;
  } else if (['error', 'turn/rejected', 'turn/transportFailed'].includes(event.method)) {
    busy = false;
    const text = p.error?.message || 'Request failed';
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
  authenticated = status.account?.type === 'chatgpt';
  busy = status.busy;
  element('account-state').textContent = authenticated ? `ChatGPT${status.account.planType ? ` · ${status.account.planType}` : ''}${status.model ? ` · ${status.model}` : ''}` : 'Not signed in';
  controls();
}
async function loadConversation() {
  if (!running() || loading) return;
  const current = generation;
  loading = true;
  try {
    await refreshStatus();
    const history = await api(path('history'));
    if (current !== generation || !running()) return;
    for (const event of history.events) render(event);
    closeStream();
    const connection = new EventSource(`${path('events')}?after=${lastSeq}`);
    stream = connection;
    connection.onmessage = message => { if (current === generation) render(JSON.parse(message.data)); };
    connection.onerror = () => {
      connection.close();
      if (stream !== connection) return;
      stream = null;
      notice('Actor connection closed. Waiting for its current state.');
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
  closeStream(); generation++; selected = name; lastSeq = 0; busy = false; authenticated = false;
  entries.clear(); element('history').replaceChildren(); element('message').value = '';
  element('name').textContent = name; element('login-details').hidden = true;
  notice('History is read from the actor only while it is running.');
  await refreshActors();
  try { if (running()) await loadConversation(); } catch (error) { notice(error.message, true); }
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
  try { await api(path('messages'), 'POST', { text }); element('message').value = ''; }
  catch (error) { busy = false; notice(error.message, true); controls(); }
};
setInterval(async () => {
  try {
    await refreshActors();
    if (running() && !lifecycle) {
      if (!stream) await loadConversation();
      else await refreshStatus();
    }
  } catch (error) { notice(error.message, true); }
}, 3000);
refreshActors().catch(error => notice(error.message, true));
window.addEventListener('pagehide', () => {
  closeStream(); entries.clear(); element('history').replaceChildren(); element('message').value = '';
  element('login-details').replaceChildren();
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  generation++; lastSeq = 0; busy = false; authenticated = false;
  refreshActors().catch(error => notice(error.message, true));
});
