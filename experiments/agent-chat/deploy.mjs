import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { atomicJson } from './common.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const playRoot = process.env.AGENT_PLAY_ROOT || '/Users/liuyue/Documents/Codex/substrate-play';
const state = join(root, 'state/agent-chat');
const target = ['--kubeconfig', join(playRoot, 'state/kubeconfig'), '--context', 'kind-substrate-play'];
const binary = process.env.KUBECTL_ATE_BIN || join(playRoot, 'bin/kubectl-ate');
const space = 'ate-demo-agent';
const templateName = 'agent-chat-codex-0-162-1-v11';
const actorNames = ['chat-1', 'chat-2'];
const execute = promisify(execFile);
async function command(binaryName, args) {
  return (await execute(binaryName, args, { timeout: 360_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
}
async function ate(args) { return JSON.parse(await command(binary, [...target, ...args, '-o', 'json'])); }
const deploymentFile = join(state, 'deployed.json');
if (existsSync(deploymentFile)) throw new Error('Deployment metadata already exists; preserve the actors and their state');
const image = readFileSync(join(state, 'image.txt'), 'utf8').trim();
if (!/^localhost:5001\/substrate-agent-chat@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Build and push the owned image before deployment');

const spaces = await ate(['get', 'atespaces']);
if ((spaces.atespaces || []).some(row => row.metadata.name === space)) {
  throw new Error('ate-demo-agent already exists; preserve it and inspect ownership before deployment');
}
const existingActors = await ate(['get', 'actors', '-A']);
const workers = await ate(['get', 'workers']);
atomicJson(join(state, 'baseline.json'), {
  time: new Date().toISOString(),
  actors: (existingActors.actors || []).map(row => ({ atespace: row.metadata.atespace, name: row.metadata.name, uid: row.metadata.uid, state: row.status.state })),
  workers: (workers.workers || []).map(row => ({ name: row.metadata.name, namespace: row.workerNamespace, state: row.status.state })),
});
await ate(['create', 'atespace', space]);
await command('kubectl', [...target, 'apply', '-f', join(root, 'experiments/agent-chat/config/sandbox-config.json')]);
const template = {
  metadata: { atespace: space, name: templateName },
  workerSelector: { matchLabels: { workload: 'sandbox' } },
  containers: [{ name: 'agent', image }],
  resources: { limits: [{ name: 'cpu', quantity: '1' }, { name: 'memory', quantity: '1Gi' }] },
  snapshotConfig: { preferredFidelity: 'SNAPSHOT_FIDELITY_MEMORY', storageLocation: `gs://ate-snapshots/${space}/` },
  sandboxConfig: { sandboxClass: 'SANDBOX_CLASS_GVISOR', configName: 'agent-chat-gvisor-20261005' },
};
const templateFile = join(state, 'actor-template.json');
atomicJson(templateFile, template);
await ate(['create', 'actor-template', '-f', templateFile]);
const deadline = Date.now() + 300_000;
while (true) {
  const current = await ate(['get', 'actor-template', templateName, '-a', space]);
  if (current.status?.goldenSnapshotStatus?.takeGoldenSnapshotAt) break;
  if (Date.now() > deadline) throw new Error('Golden snapshot is not ready; preserve resources and inspect the template');
  console.log('Waiting for the unauthenticated golden snapshot');
  await new Promise(resolveWait => setTimeout(resolveWait, 3000));
}
const identities = [];
for (const name of actorNames) {
  const result = await ate(['create', 'actor', name, '-a', space, '--template', templateName]);
  const actor = result.actor || result;
  if (actor.status.state !== 'ACTOR_STATE_SUSPENDED') throw new Error(`Unexpected initial state for ${name}; inspect it before proceeding`);
  identities.push({ name, uid: actor.metadata.uid });
  const policy = { metadata: { atespace: space, name: 'default' }, rules: [
    { tlsPassthrough: { hostnames: ['chatgpt.com', 'auth.openai.com', 'api.openai.com'], ports: { numbers: [443] } } },
  ] };
  const policyFile = join(state, `${name}-egress.json`);
  atomicJson(policyFile, policy);
  await ate(['create', 'egress-policy', name, '-a', space, '-f', policyFile]);
}
atomicJson(deploymentFile, { atespace: space, template: templateName, image, actors: identities });
console.log('Created chat-1 and chat-2 in SUSPENDED state. Resume only through the console.');
