import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson } from './common.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const playRoot = process.env.AGENT_PLAY_ROOT || '/Users/liuyue/Documents/Codex/substrate-play';
const state = join(root, 'state/agent-chat');
const target = ['--kubeconfig', join(playRoot, 'state/kubeconfig'), '--context', 'kind-substrate-play'];
const binary = process.env.KUBECTL_ATE_BIN || join(playRoot, 'bin/kubectl-ate');
const execute = promisify(execFile);
async function ate(args) {
  return JSON.parse((await execute(binary, [...target, ...args, '-o', 'json'], { timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout);
}
const file = join(state, 'deployed.json');
const deployment = JSON.parse(readFileSync(file, 'utf8'));
if (deployment.atespace !== 'ate-demo-agent') throw new Error('Unexpected deployment Atespace');
const image = readFileSync(join(state, 'image.txt'), 'utf8').trim();
if (!/^localhost:5001\/substrate-agent-chat@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Build the owned image first');
const name = 'agent-chat-codex-0-162-1-v5';
const existing = (await ate(['get', 'actor-templates', '-a', deployment.atespace])).actorTemplates || [];
const current = existing.find(template => template.metadata.name === name);
if (current && current.containers?.[0]?.image !== image) throw new Error('Template name already uses another image; preserve it');
if (!current) {
  const template = {
    metadata: { atespace: deployment.atespace, name },
    workerSelector: { matchLabels: { workload: 'sandbox' } },
    containers: [{ name: 'agent', image }],
    resources: { limits: [{ name: 'cpu', quantity: '1' }, { name: 'memory', quantity: '1Gi' }] },
    snapshotConfig: { preferredFidelity: 'SNAPSHOT_FIDELITY_MEMORY', storageLocation: `gs://ate-snapshots/${deployment.atespace}/` },
    sandboxConfig: { sandboxClass: 'SANDBOX_CLASS_GVISOR', configName: 'agent-chat-gvisor-20261005' },
  };
  const templateFile = join(state, 'actor-template-v5.json');
  atomicJson(templateFile, template);
  await ate(['create', 'actor-template', '-f', templateFile]);
}
const deadline = Date.now() + 300_000;
while (true) {
  const template = await ate(['get', 'actor-template', name, '-a', deployment.atespace]);
  if (template.status?.goldenSnapshotStatus?.takeGoldenSnapshotAt) break;
  if (Date.now() > deadline) throw new Error('Golden snapshot is not ready; deployment metadata was preserved');
  console.log('Waiting for the unauthenticated golden snapshot');
  await new Promise(resolveWait => setTimeout(resolveWait, 3000));
}
atomicJson(file, { ...deployment, template: name, image });
console.log('New actors use the updated template. Existing actors and snapshots were preserved.');
