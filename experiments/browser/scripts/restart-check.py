"""Verify owned gateway and node restart without reloading browser pages."""
import hashlib
import json
from pathlib import Path
import sys
import time

import lab
import play


def external_containers():
    ids=play.run(play.DOCKER+['ps','-aq'],capture=True).split()
    if not ids:return []
    rows=json.loads(play.run(play.DOCKER+['inspect',*ids],capture=True))
    rows=[r for r in rows if not ((r['Config']['Labels'] or {}).get('io.x-k8s.kind.cluster')=='substrate-play' or (r['Config']['Labels'] or {}).get('local.substrate-play.owner')=='substrate-play')]
    return sorted([{'id':r['Id'],'name':r['Name'],'running':r['State']['Running'],
                    'health':r['State'].get('Health',{}).get('Status')} for r in rows],key=lambda r:r['name'])


def config_hash():
    return hashlib.sha256((Path.home() / '.kube/config').read_bytes()).hexdigest() if (Path.home() / '.kube/config').exists() else None


def main():
    c=lab.client()
    before=c.run_code(lab.STATE_CODE)
    path=lab.cgroup_path(lab.record['actorUid'])
    result={'before':before,'externalContainersBefore':external_containers(),'kubeconfigBefore':config_hash(),
            'gatewayBefore':play.gateway_health(),'runningResources':lab.cgroup_sample(path)}
    lab.record['restartCheck']=result
    try:
        play.suspend_all()
        paused=lab.actor()
        assert paused['status']['state']=='ACTOR_STATE_SUSPENDED'
        assert paused['status']['externalSnapshot']['fidelity']=='SNAPSHOT_FIDELITY_MEMORY'
        result['snapshot']=paused['status']['externalSnapshot']
        result['snapshotDisk']=lab.snapshot_disk(result['snapshot'])
        # The owned actor's former cgroup is either absent or empty after suspension.
        output=play.run(play.DOCKER+['exec',play.NODE,'sh','-c',
            'if test -f "$1/memory.current"; then cat "$1/memory.current" "$1/cgroup.events"; else echo absent; fi',
            'browser-idle-check',path],capture=True)
        result['suspendedCgroup']=output.strip()
        if output.strip()!='absent':
            result['suspendedResources']=lab.cgroup_sample(path)
            memory=result['suspendedResources']['memory.stat']
            # Empty cgroups can retain one kernel metadata page after processes exit.
            assert 'populated 0' in output and memory['anon']==0 and memory['shmem']==0 and memory['file']==0
        lab.save('restart_paused')
        play.stop()
        result['nodeStopped']=play.inspect_owned(play.NODE)['State']['Running'] is False
        result['registryStopped']=play.inspect_owned(play.REGISTRY)['State']['Running'] is False
        assert result['nodeStopped'] and result['registryStopped']
        lab.save('restart_stopped')
        started=time.perf_counter();play.start()
        result['clusterStartSeconds']=time.perf_counter()-started
        play.ate(['resume','actor','browser-1','-a',lab.SPACE],capture=True)
        after=c.run_code(lab.STATE_CODE)
        result['after']=after
        assert after==before,{'before':before,'after':after}
        result['gatewayAfter']=play.gateway_health()
        result['externalContainersAfter']=external_containers()
        result['kubeconfigAfter']=config_hash()
        assert result['externalContainersAfter']==result['externalContainersBefore']
        assert result['kubeconfigAfter']==result['kubeconfigBefore']
        result['resourcesAfter']=lab.cgroup_sample(lab.cgroup_path(lab.record['actorUid']))
        result['passed']=True
        lab.record['checks']['stop_start_browser_restore']='passed'
        lab.record['checks']['suspended_actor_memory_released']='passed'
        lab.record['checks']['external_containers_preserved']='passed'
        lab.record['checks']['ambient_kubeconfig_preserved']='passed'
        lab.record.pop('failure',None)
        lab.save('verified')
        print(json.dumps({k:result[k] for k in ['passed','suspendedCgroup','clusterStartSeconds']},indent=2))
    except Exception as error:
        lab.record['failure']={'stage':lab.record['stage'],'type':type(error).__name__,'message':str(error)}
        lab.save('failed')
        raise


if __name__ == '__main__':
    main()
