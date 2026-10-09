"""Browser checks and sequential SuspendActor/ResumeActor measurements."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import statistics
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[3]
OUTPUTS = ROOT / 'outputs'
sys.path.insert(0, str(ROOT / 'scripts'))
import play
from client import MCPClient, SPACE, DEFAULT_ACTOR

RECORD = ROOT / 'state/browser/verification.json'
SESSION = ROOT / 'state/browser/client-session.json'
record = json.loads(RECORD.read_text()) if RECORD.exists() else {'actor':DEFAULT_ACTOR,'atespace':SPACE,'checks':{}}


def save(stage):
    record['stage'] = stage
    record['updatedAt'] = datetime.now(timezone.utc).isoformat()
    RECORD.parent.mkdir(parents=True, exist_ok=True)
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    RECORD.write_text(json.dumps(record, indent=2)+'\n')
    (OUTPUTS / 'substrate-browser-evidence.json').write_text(json.dumps(record, indent=2)+'\n')


def actor(name=DEFAULT_ACTOR):
    return json.loads(play.ate(['get','actor',name,'-a',SPACE,'-o','json'], capture=True))


def client(name=DEFAULT_ACTOR, fresh=False):
    SESSION.parent.mkdir(parents=True, exist_ok=True)
    existing = json.loads(SESSION.read_text()) if SESSION.exists() and name == DEFAULT_ACTOR else {}
    c = MCPClient(name, session=None if fresh else existing.get('session'))
    if not c.session:
        deadline=time.monotonic()+30
        while True:
            try:
                c.initialize();break
            except RuntimeError as error:
                if 'HTTP 503' not in str(error) or time.monotonic()>deadline:raise
                time.sleep(.2)
        if name == DEFAULT_ACTOR:
            SESSION.write_text(json.dumps({'session':c.session})+'\n')
    return c


def text(result):
    return '\n'.join(row.get('text','') for row in result.get('content',[]) if row.get('type')=='text')


def screenshot(c, filename):
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    result = c.call('browser_take_screenshot', {'type':'png','fullPage':True,'scale':'css'})
    for item in result.get('content',[]):
        if item.get('type')=='image':
            (OUTPUTS / filename).write_bytes(base64.b64decode(item['data']))
            return {'path':str(OUTPUTS / filename), 'bytes':(OUTPUTS / filename).stat().st_size}
    match=re.search(r'\]\(([^)]+\.(?:png|jpeg|webp))\)',text(result))
    if match:
        image=c.http('/artifacts/'+Path(match.group(1)).name)
        (OUTPUTS / filename).write_bytes(image)
        return {'path':str(OUTPUTS / filename), 'bytes':len(image)}
    raise RuntimeError('Screenshot did not return image bytes or a file: '+text(result))


def snapshot_tree(c,result):
    value=text(result)
    match=re.search(r'\[Snapshot\]\(([^)]+)\)',value)
    return c.http('/artifacts/'+Path(match.group(1)).name).decode() if match else value


def cgroup_path(uid):
    output = play.run(play.DOCKER+['exec',play.NODE,'find','/sys/fs/cgroup','-type','d','-name',uid+'-_pause'],capture=True)
    paths=output.strip().splitlines()
    current=actor()
    assert current['metadata']['uid']==uid
    worker_uid=current['status']['workerAssignment']['workerPodUid']
    # Empty leaves from a prior assignment can remain briefly after suspend.
    # Measure only the cgroup below the actor's current worker pod.
    paths=[p for p in paths if worker_uid in p or worker_uid.replace('-','_') in p]
    if len(paths)!=1:
        raise RuntimeError('Expected one sandbox cgroup: '+repr(paths))
    return paths[0]


def cgroup_sample(path):
    command='for name in memory.current memory.peak memory.events cpu.stat memory.stat; do printf "%s\\n" "$name"; cat "$1/$name"; done'
    output=play.run(play.DOCKER+['exec',play.NODE,'sh','-c',command,'browser-lab',path],capture=True)
    data={'time':datetime.now(timezone.utc).isoformat()}
    field=None
    for line in output.splitlines():
        if line in {'memory.current','memory.peak','memory.events','cpu.stat','memory.stat'}:
            field=line; data[field]={} if field.endswith(('stat','events')) else None
        elif isinstance(data.get(field),dict):
            key,value=line.split();data[field][key]=int(value)
        else:
            data[field]=int(line)
    return data


def snapshot_disk(snapshot):
    uri=urlparse(snapshot['snapshotUri'])
    target='/data/'+uri.netloc+uri.path
    output=play.run(play.KUBE+['-n','ate-system','exec','deployment/rustfs','--','du','-sk',target],capture=True)
    return {'uri':snapshot['snapshotUri'],'diskBytes':int(output.split()[0])*1024}


STATE_CODE = """async (page) => {
  return await Promise.all(page.context().pages().map(async p => ({
    url:p.url(), state:await p.evaluate(()=>({lab:window.lab??null,
      input:document.querySelector('#note')?.value??null,cookie:document.cookie,
      frontProof:window.frontProof??null,marker:document.querySelector('#volatile-marker')?.textContent??null,
      timeOrigin:performance.timeOrigin,
      localStorageNote:localStorage.getItem('note'),sessionStorageNote:sessionStorage.getItem('note')}))
  })));
}"""

PROOF_CODE = """() => {
  window.frontProof={nonce:crypto.randomUUID(),timeOrigin:performance.timeOrigin};
  document.querySelector('#note').value='Unsaved draft '+window.frontProof.nonce;
  const marker=document.createElement('div');marker.id='volatile-marker';marker.textContent=window.frontProof.nonce;
  document.querySelector('main').appendChild(marker);
  return window.frontProof;
}"""


def verify():
    record.clear()
    record.update({'actor':DEFAULT_ACTOR,'atespace':SPACE,'checks':{}})
    c=client(fresh=True)
    c.run_code('async (page) => {const pages=page.context().pages();for (const p of pages.slice(1)) await p.close();return pages.length}')
    c.call('browser_tabs', {'action':'select','index':0})
    record['initialize']={'session':c.session}
    tools=c.rpc('tools/list')
    (ROOT / 'state/browser/tools.json').write_text(json.dumps(tools,indent=2)+'\n')
    record['tools']=[row['name'] for row in tools['tools']]
    print('MCP tools:', ', '.join(record['tools']),flush=True)
    save('mcp_connected')
    start=time.perf_counter()
    result=c.call('browser_navigate',{'url':'http://127.0.0.1/fixture'})
    record['firstNavigationSeconds']=time.perf_counter()-start
    tree=snapshot_tree(c,result)
    print(tree,flush=True)
    record['checks']['navigate']='passed'
    field=re.search(r'textbox "Draft note" \[ref=(\w+)\]',tree)
    if not field:
        raise RuntimeError('Draft note reference missing in page snapshot')
    c.call('browser_type',{'element':'Draft note','target':field.group(1),'text':'This draft survived a browser checkpoint.'})
    tree=snapshot_tree(c,c.call('browser_snapshot'))
    save_button=re.search(r'button "Save note" \[ref=(\w+)\]',tree)
    c.call('browser_click',{'element':'Save note','target':save_button.group(1)})
    record['checks']['type_and_click']='passed'
    state=c.evaluate('() => {window.lab.counter=42;document.querySelector("#increment").click();return window.lab}')
    assert state['counter']==43,state
    record['checks']['javascript']='passed'
    c.call('browser_tabs',{'action':'new'})
    c.call('browser_navigate',{'url':'http://127.0.0.1/fixture?tab=2'})
    c.evaluate('() => {window.lab.counter=7;return window.lab}')
    c.call('browser_tabs',{'action':'select','index':0})
    c.evaluate(PROOF_CODE)
    record['checks']['two_tabs']='passed'
    record['screenshotBefore']=screenshot(c,'substrate-browser-before.png')
    record['checks']['screenshot']='passed'
    record['before']=c.run_code(STATE_CODE)
    record['diagnosticsBefore']=c.http('/diagnostics')
    uid=actor()['metadata']['uid']
    record['actorUid']=uid
    record['resourcesBefore']=cgroup_sample(cgroup_path(uid))
    record['toolTimings']=c.samples
    save('functional_verified')
    print(json.dumps({'state':record['before'],'resources':record['resourcesBefore']},indent=2),flush=True)


def wait_workers(timeout=60):
    """Pod readiness precedes control-plane registration; require both."""
    deadline=time.monotonic()+timeout
    while True:
        pods=json.loads(play.run(play.KUBE+['-n',SPACE,'get','pods','-l',
                        'ate.dev/worker-pool=browser-workerpool','-o','json'],capture=True))['items']
        pods=[p for p in pods if not p['metadata'].get('deletionTimestamp')]
        workers=json.loads(play.ate(['get','workers','-o','json'],capture=True))['workers']
        active={w['workerPodUid']:w for w in workers if w['workerNamespace']==SPACE and
                w['status']['state']=='WORKER_STATE_ACTIVE'}
        ready=[]
        for p in pods:
            w=active.get(p['metadata']['uid'])
            statuses=p['status'].get('containerStatuses',[])
            ips={i['ip'] for i in p['status'].get('podIPs',[])}
            if w and statuses and all(s.get('ready') for s in statuses) and ips==set(w['ips']):
                ready.append(w)
        if len(pods)==2 and len(ready)==2:
            return ready
        if time.monotonic()>=deadline:
            raise RuntimeError('Browser worker registration did not converge')
        time.sleep(.25)


def suspend_resume():
    assert record['stage'] in {'functional_verified','checkpoint_verified','benchmark_verified','verified'},record['stage']
    c=client()
    before=c.run_code(STATE_CODE)
    record['before']=before
    record['diagnosticsBefore']=c.http('/diagnostics')
    record['resourcesBefore']=cgroup_sample(cgroup_path(record['actorUid']))
    record['screenshotBefore']=screenshot(c,'substrate-browser-before.png')
    old=actor()['status']['workerAssignment']
    start=time.perf_counter();play.ate(['suspend','actor',DEFAULT_ACTOR,'-a',SPACE],capture=True)
    record['suspendSeconds']=time.perf_counter()-start
    suspended=actor()
    snapshot=suspended['status']['externalSnapshot']
    assert snapshot['fidelity']=='SNAPSHOT_FIDELITY_MEMORY',snapshot
    record['snapshot']=snapshot
    record['snapshotDisk']=snapshot_disk(snapshot)
    record['workerBefore']=old
    save('checkpoint_saved')
    others=[a['metadata'] for a in play.actors() if a['metadata']['name']!=DEFAULT_ACTOR and
            a.get('status',{}).get('workerAssignment',{}).get('workerPodUid')==old['workerPodUid']]
    if others:
        raise RuntimeError('Old worker still has other actors; preserve it: '+repr(others))
    pod=json.loads(play.run(play.KUBE+['-n',SPACE,'get','pod',old['workerPod'],'-o','json'],capture=True))
    assert pod['metadata']['uid']==old['workerPodUid']
    play.run(play.KUBE+['-n',SPACE,'delete','pod',old['workerPod'],'--wait=true'])
    play.run(play.KUBE+['-n',SPACE,'rollout','status','deployment/browser-workerpool','--timeout=300s'])
    resume_saved()


def resume_saved():
    c=client()
    before=record['before']
    old=record['workerBefore']
    current=actor()
    assert current['metadata']['uid']==record['actorUid']
    assert current['status']['externalSnapshot']['snapshotUri']==record['snapshot']['snapshotUri']
    wait_workers()
    start=time.perf_counter();play.ate(['resume','actor',DEFAULT_ACTOR,'-a',SPACE],capture=True)
    record['resumeSeconds']=time.perf_counter()-start
    new=actor()['status']['workerAssignment'];record['workerAfter']=new
    assert new['workerPodUid']!=old['workerPodUid']
    # Reuse the original MCP session after restoring the server's in-memory session map.
    after=c.run_code(STATE_CODE)
    assert after==before,{'before':before,'after':after}
    record['after']=after
    record['checks']['cross_worker_memory_restore']='passed'
    record['checks']['mcp_session_restore']='passed'
    record['checks']['frontend_not_reloaded']='passed'
    record['diagnosticsAfter']=c.http('/diagnostics')
    assert record['diagnosticsBefore']['startedAt']==record['diagnosticsAfter']['startedAt']
    assert record['diagnosticsBefore']['token']==record['diagnosticsAfter']['token']
    record['screenshotAfter']=screenshot(c,'substrate-browser-after.png')
    previous_counter=after[0]['state']['lab']['counter']
    state=c.evaluate('() => {document.querySelector("#increment").click();return window.lab}')
    assert state['counter']==previous_counter+1,state
    record['checks']['post_restore_interaction']='passed'
    record['resourcesAfter']=cgroup_sample(cgroup_path(record['actorUid']))
    record.pop('failure',None)
    save('checkpoint_verified')
    print(json.dumps({'checks':record['checks'],'suspendSeconds':record['suspendSeconds'],
                     'resumeSeconds':record['resumeSeconds'],'snapshotDisk':record['snapshotDisk']},indent=2),flush=True)


def benchmark(iterations):
    assert record['checks'].get('frontend_not_reloaded')=='passed'
    if iterations<1:
        raise ValueError('Iterations must be positive')
    c=client()
    path=cgroup_path(actor()['metadata']['uid'])
    warm=[];cold=[];cold_actors=[];cycles=[]
    # Shared MCP contexts cannot be closed. Each trial starts a separate actor
    # from the browser-free golden snapshot, then launches Chromium once.
    for i in range(iterations):
        name=f'browser-bench-{uuid.uuid4().hex[:12]}'
        template=actor()['actorTemplate']['name']
        play.ate(['create','actor',name,'-a',SPACE,'--template',template],capture=True)
        trial_uid=actor(name)['metadata']['uid']
        start=time.perf_counter();play.ate(['resume','actor',name,'-a',SPACE],capture=True)
        control_seconds=time.perf_counter()-start
        trial=client(name,fresh=True)
        assert not any(p['name']=='chrome' for p in trial.http('/diagnostics')['processes'])
        navigation_start=time.perf_counter()
        trial.call('browser_navigate',{'url':'http://127.0.0.1/fixture'})
        cold.append(time.perf_counter()-navigation_start)
        cold_actors.append({'actor':name,'uid':trial_uid,'resumeControlSeconds':control_seconds,
                            'firstNavigationSeconds':cold[-1],
                            'resumeToLoadedPageSeconds':time.perf_counter()-start})
        assert actor(name)['metadata']['uid']==trial_uid
        play.ate(['delete','actor',name,'-a',SPACE,'--any-state'],capture=True)
        start=time.perf_counter();c.call('browser_snapshot')
        warm.append(time.perf_counter()-start)
        record['benchmark']={'iterations':iterations,'completed':0,'browserLaunchSeconds':cold,
                            'coldActors':cold_actors,'warmSnapshotToolSeconds':warm,'checkpointCycles':[]}
        save('benchmark_running')
        print(json.dumps({'phase':'browser_launch','iteration':i+1,'seconds':cold[-1]}),flush=True)
    c.evaluate('() => {window.lab.counter=99;document.querySelector("#increment").click();return window.lab}')
    benchmark_state=c.run_code(STATE_CODE)
    sample_before=cgroup_sample(path);wall_start=time.perf_counter()
    for i in range(iterations):
        before=c.run_code(STATE_CODE)
        start=time.perf_counter();play.ate(['suspend','actor',DEFAULT_ACTOR,'-a',SPACE],capture=True)
        suspend_seconds=time.perf_counter()-start
        paused=actor()
        assert paused['status']['externalSnapshot']['fidelity']=='SNAPSHOT_FIDELITY_MEMORY'
        disk=snapshot_disk(paused['status']['externalSnapshot'])
        start=time.perf_counter();play.ate(['resume','actor',DEFAULT_ACTOR,'-a',SPACE],capture=True)
        control_seconds=time.perf_counter()-start
        tool_start=time.perf_counter();after=c.run_code(STATE_CODE);tool_seconds=time.perf_counter()-tool_start
        assert after==before,{'iteration':i+1,'before':before,'after':after}
        c.evaluate('() => {document.querySelector("#increment").click();return window.lab.counter}')
        sample=cgroup_sample(cgroup_path(record['actorUid']))
        cycles.append({'iteration':i+1,'suspendSeconds':suspend_seconds,'resumeControlSeconds':control_seconds,
                       'firstToolSeconds':tool_seconds,'resumeToFirstToolSeconds':control_seconds+tool_seconds,
                       'snapshotDiskBytes':disk['diskBytes'],'resources':sample,'snapshotUri':disk['uri'],
                       'frontendStatePreserved':True,'before':before,'after':after})
        record['benchmark']={'iterations':iterations,'completed':len(cycles),'browserLaunchSeconds':cold,
                             'coldActors':cold_actors,'warmSnapshotToolSeconds':warm,'checkpointCycles':cycles}
        save('benchmark_running')
        print(json.dumps(cycles[-1]),flush=True)
    def stats(values):
        ordered=sorted(values)
        return {'min':min(values),'median':statistics.median(values),'p95':ordered[max(0,__import__('math').ceil(.95*len(values))-1)],'max':max(values)}
    record['benchmark']['summary']={
        'browserLaunchSeconds':stats(cold),'warmSnapshotToolSeconds':stats(warm),
        'suspendSeconds':stats([x['suspendSeconds'] for x in cycles]),
        'resumeControlSeconds':stats([x['resumeControlSeconds'] for x in cycles]),
        'resumeToFirstToolSeconds':stats([x['resumeToFirstToolSeconds'] for x in cycles]),
        'snapshotDiskBytes':stats([x['snapshotDiskBytes'] for x in cycles]),
        'runningMemoryBytes':stats([x['resources']['memory.current'] for x in cycles])}
    record['benchmark']['wallSeconds']=time.perf_counter()-wall_start
    record['benchmark']['sampleBefore']=sample_before
    record['benchmark']['initialFrontendState']=benchmark_state
    record['benchmark']['finalFrontendState']=c.run_code(STATE_CODE)
    record.pop('failure',None)
    save('benchmark_verified')
    print(json.dumps(record['benchmark']['summary'],indent=2),flush=True)


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('command',choices=['verify','suspend-resume','resume-saved','benchmark','screenshot'])
    parser.add_argument('--iterations',type=int,default=10)
    args=parser.parse_args()
    try:
        if args.command=='verify':verify()
        elif args.command=='suspend-resume':suspend_resume()
        elif args.command=='resume-saved':resume_saved()
        elif args.command=='benchmark':benchmark(args.iterations)
        else:
            print(json.dumps(screenshot(client(),'substrate-browser-current.png')))
    except Exception as error:
        record['failure']={'stage':record.get('stage'),'type':type(error).__name__,'message':str(error)}
        save('failed')
        raise
