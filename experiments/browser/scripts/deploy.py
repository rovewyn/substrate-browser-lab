"""Deploy browser-only resources to the existing isolated playground."""
import argparse
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts'))
import play

SPACE = 'ate-demo-browser'
POOL = 'browser-workerpool'
TEMPLATE = 'browser-template-v4'


def deploy(image, template_name):
    (ROOT / 'state/browser').mkdir(parents=True, exist_ok=True)
    existing = json.loads(play.ate(['get', 'atespaces', '-o', 'json'], capture=True))
    names = [row['metadata']['name'] for row in existing.get('atespaces', [])]
    if SPACE not in names:
        play.ate(['create', 'atespace', SPACE])
    templates = json.loads(play.ate(['get', 'actor-templates', '-a', SPACE, '-o', 'json'], capture=True))
    if any(row['metadata']['name'] == template_name for row in templates.get('actorTemplates', [])):
        raise RuntimeError('ActorTemplate exists; preserve it and choose a new --template name')
    if any(row['metadata']['atespace'] == SPACE and row['metadata']['name'] == 'browser-1' for row in play.actors()):
        raise RuntimeError('browser-1 exists; preserve its state before another deployment')
    old_pool = json.loads(play.run(play.KUBE + ['-n', 'ate-demo-sandbox', 'get', 'workerpool', 'sandbox-workerpool', '-o', 'json'], capture=True))
    pool = {'apiVersion':'ate.dev/v1alpha1', 'kind':'WorkerPool',
            'metadata':{'name':POOL, 'namespace':SPACE, 'labels':{'workload':'browser', 'local.substrate-play.owner':'substrate-play'}},
            'spec':{'replicas':2, 'workerImage':old_pool['spec']['workerImage'],
                    'sandboxClasses':[{'name':'gvisor'}],
                    'template':{'resources':{'limits':{'cpu':'2','memory':'4Gi'},
                                             'requests':{'cpu':'500m','memory':'4Gi'}}}}}
    manifest = ROOT / 'state/browser/workerpool.json'
    namespace = {'apiVersion':'v1', 'kind':'Namespace',
                 'metadata':{'name':SPACE, 'labels':{'local.substrate-play.owner':'substrate-play'}}}
    manifest.write_text(json.dumps({'apiVersion':'v1','kind':'List','items':[namespace,pool]}, indent=2)+'\n')
    play.run(play.KUBE + ['apply', '-f', str(ROOT / 'experiments/browser/config/sandbox-config.json')])
    play.run(play.KUBE + ['-n', SPACE, 'apply', '-f', str(manifest)])
    play.run(play.KUBE + ['-n', SPACE, 'rollout', 'status', 'deployment/'+POOL, '--timeout=300s'])
    template = {'metadata':{'atespace':SPACE,'name':template_name},
                'workerSelector':{'matchLabels':{'workload':'browser'}},
                'containers':[{'name':'browser','image':image}],
                'resources':{'limits':[{'name':'cpu','quantity':'2'},{'name':'memory','quantity':'2Gi'}]},
                'snapshotConfig':{'preferredFidelity':'SNAPSHOT_FIDELITY_MEMORY',
                                  'storageLocation':'gs://ate-snapshots/ate-demo-browser/'},
                'sandboxConfig':{'sandboxClass':'SANDBOX_CLASS_GVISOR','configName':'browser-gvisor-20261005'}}
    manifest = ROOT / 'state/browser/actor-template.json'
    manifest.write_text(json.dumps(template, indent=2)+'\n')
    play.ate(['create','actor-template','-f',str(manifest)])
    deadline=time.monotonic()+300
    while True:
        current=json.loads(play.ate(['get','actor-template',template_name,'-a',SPACE,'-o','json'],capture=True))
        (ROOT / 'state/browser/template.json').write_text(json.dumps(current,indent=2)+'\n')
        print(json.dumps(current.get('status',{})),flush=True)
        status=current.get('status',{})
        if status.get('goldenSnapshotStatus', {}).get('takeGoldenSnapshotAt'):
            break
        if time.monotonic()>deadline:
            raise RuntimeError('Golden snapshot was not ready; preserve resources and inspect template status')
        time.sleep(3)
    play.ate(['create','actor','browser-1','-a',SPACE,'--template',template_name])
    play.ate(['resume','actor','browser-1','-a',SPACE])
    (ROOT / 'state/browser/deployed.json').write_text(json.dumps({'atespace':SPACE,'template':template_name,'actor':'browser-1'})+'\n')


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', help='Image digest from the owned local registry')
    parser.add_argument('--template', default=TEMPLATE)
    args=parser.parse_args()
    deploy(args.image,args.template)
