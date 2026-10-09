#!/usr/bin/env python3
"""Capture unrelated container identities and ambient settings in ignored state."""
import hashlib
import json
from pathlib import Path

import play


def capture():
    target = play.ROOT / 'state/baseline.json'
    if target.exists():
        raise RuntimeError('A baseline already exists; preserve it before another run')
    ids = play.run(play.DOCKER + ['ps', '-aq'], capture=True).split()
    rows = json.loads(play.run(play.DOCKER + ['inspect', *ids], capture=True)) if ids else []
    containers = []
    for row in rows:
        labels = row['Config']['Labels'] or {}
        if labels.get('io.x-k8s.kind.cluster') == 'substrate-play' or labels.get('local.substrate-play.owner') == 'substrate-play':
            continue
        containers.append({'name': row['Name'].lstrip('/'), 'id': row['Id'],
                           'running': row['State']['Running'],
                           'health': row['State'].get('Health', {}).get('Status'),
                           'restart_policy': row['HostConfig']['RestartPolicy']})
    config = Path.home() / '.kube/config'
    baseline = {'containers': containers,
                'kubeconfig_sha256': hashlib.sha256(config.read_bytes()).hexdigest() if config.exists() else None,
                'kubernetes_current_context': play.run(['kubectl', '--kubeconfig', str(config), 'config', 'current-context'], capture=True).strip() if config.exists() else None,
                'source_commit': '288694ef2297bb5d6fab30eca328ddaa89015f91'}
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('x') as handle:
        json.dump(baseline, handle, indent=2)
        handle.write('\n')
    print('Captured local baseline for', len(containers), 'unrelated containers')


if __name__ == '__main__':
    capture()
