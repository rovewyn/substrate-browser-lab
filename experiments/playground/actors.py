#!/usr/bin/env python3
"""Run the approved local acceptance checks and retain results at each stage."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import play

RESULT = play.ROOT / "state/verification.json"
SPACE = "ate-demo-counter"
SANDBOX = "ate-demo-sandbox"
REPORT = json.loads(RESULT.read_text()) if RESULT.exists() else {"checks": {}}


def save():
    REPORT["updated_at"] = datetime.now(timezone.utc).isoformat()
    RESULT.write_text(json.dumps(REPORT, indent=2) + "\n")


def check(name, fn):
    print("CHECK " + name, flush=True)
    try:
        detail = fn()
        REPORT["checks"][name] = {"passed": True, "detail": detail}
        print("PASS " + name, flush=True)
    except Exception as error:
        REPORT["checks"][name] = {"passed": False, "error": str(error)}
        save()
        raise
    save()


def actor(name, space=SPACE):
    return json.loads(play.ate(["get", "actor", name, "-a", space, "-o", "json"], capture=True))


def suspend(name, space=SPACE):
    play.ate(["suspend", "actor", name, "-a", space], capture=True)
    result = actor(name, space)
    assert result["status"]["state"] == "ACTOR_STATE_SUSPENDED", result
    assert result["status"].get("externalSnapshot", {}).get("snapshotUri"), result
    return result


def counter(name="my-counter-1"):
    response = play.request(SPACE, name)
    memory = re.search(r"preserved memory count: (\d+)", response)
    disk = re.search(r"preserved file counter: (\d+)", response)
    assert memory and disk, response
    return {"memory": int(memory[1]), "file": int(disk[1]), "response": response.strip()}


def next_count(before, after):
    assert after["memory"] == before["memory"] + 1, (before, after)
    assert after["file"] == before["file"] + 1, (before, after)


def core():
    pods = json.loads(play.run(play.KUBE + ["get", "pods", "-A", "-o", "json"], capture=True))["items"]
    relevant = [p for p in pods if p["metadata"]["namespace"].startswith("ate-")]
    for pod in relevant:
        assert pod["status"]["phase"] in {"Running", "Succeeded"}, pod["metadata"]["name"]
        if pod["status"]["phase"] == "Running":
            assert all(s["ready"] for s in pod["status"]["containerStatuses"]), pod["metadata"]["name"]
    pvc = json.loads(play.run(play.KUBE + ["-n", "ate-system", "get", "pvc", "-o", "json"], capture=True))["items"]
    assert {p["metadata"]["name"] for p in pvc} >= {"data-postgres-0", "rustfs-data"}
    assert all(p["status"]["phase"] == "Bound" for p in pvc)
    templates = json.loads(play.ate(["get", "actor-templates", "-A", "-o", "json"], capture=True))["actorTemplates"]
    templates = [t for t in templates if t["metadata"]["atespace"] in {SPACE, SANDBOX}]
    assert len(templates) == 2
    for template in templates:
        golden = template["status"]["goldenSnapshotStatus"]
        assert golden.get("goldenTag") and not golden.get("errorMessage"), template
    workers = json.loads(play.ate(["get", "workers", "-o", "json"], capture=True))["workers"]
    active = [w for w in workers if w["status"]["state"] == "WORKER_STATE_ACTIVE"]
    assert len([w for w in active if w["workerNamespace"] == SPACE]) == 3
    assert len([w for w in active if w["workerNamespace"] == SANDBOX]) == 2
    return {"pods": [{"name": p["metadata"]["name"], "namespace": p["metadata"]["namespace"], "phase": p["status"]["phase"]} for p in relevant],
            "pvc": [{"name": p["metadata"]["name"], "phase": p["status"]["phase"]} for p in pvc],
            "templates": templates, "workers": active}


def counter_continuity():
    first, second = counter(), counter()
    next_count(first, second)
    snap = suspend("my-counter-1")
    restored = counter()
    next_count(second, restored)
    return {"first": first, "second": second, "suspended": snap, "restored": restored}


def worker_recreation():
    before = counter()
    assigned = actor("my-counter-1")["status"]["workerAssignment"]
    assert assigned["workerNamespace"] == SPACE
    suspend("my-counter-1")
    old_pod = assigned["workerPod"]
    play.run(play.KUBE + ["-n", SPACE, "delete", "pod", old_pod, "--wait=true"], capture=True)
    play.run(play.KUBE + ["-n", SPACE, "rollout", "status", "deployment/counter", "--timeout=300s"], capture=True)
    after = counter()
    next_count(before, after)
    new_assignment = actor("my-counter-1")["status"]["workerAssignment"]
    assert new_assignment["workerPodUid"] != assigned["workerPodUid"]
    suspend("my-counter-1")
    return {"before": before, "after": after, "deleted_pod": old_pod,
            "old_assignment": assigned, "new_assignment": new_assignment}


def worker_reuse():
    workers = json.loads(play.ate(["get", "workers", "-o", "json"], capture=True))["workers"]
    pool = {w["workerPod"] for w in workers if w["workerNamespace"] == SPACE and w["status"]["state"] == "WORKER_STATE_ACTIVE"}
    assert len(pool) == 3, pool
    observations = []
    for i in range(1, 7):
        name = f"reuse-counter-{i}"
        play.ate(["create", "actor", name, "-a", SPACE, "--template", "counter"], capture=True)
        response = None
        for _ in range(i):
            response = counter(name)
        assert response["memory"] == i and response["file"] == i, response
        assignment = actor(name)["status"]["workerAssignment"]
        assert assignment["workerPod"] in pool
        snap = suspend(name)
        observations.append({"name": name, "initial": response, "worker": assignment["workerPod"],
                             "snapshot": snap["status"]["externalSnapshot"]["snapshotUri"]})
    for observation in observations:
        restored = counter(observation["name"])
        next_count(observation["initial"], restored)
        observation["restored"] = restored
        suspend(observation["name"])
    used = {o["worker"] for o in observations}
    assert len(used) <= 3 and len(observations) > len(used)
    return {"worker_pool": sorted(pool), "observed_workers": sorted(used), "actors": observations}


def sandbox():
    name = "my-sandbox-1"
    play.ate(["resume", "actor", name, "-a", SANDBOX], capture=True)
    def execute(command):
        return play.request(SANDBOX, name, "/process", {"command": ["sh", "-c", command], "timeout": "60s"})
    output = execute("printf 'stdout-ok\\n'; printf 'stderr-ok\\n' >&2; exit 7")
    assert output["stdout"] == "stdout-ok\n" and output["stderr"] == "stderr-ok\n" and output["exitCode"] == 7, output
    created = execute("printf 'snapshot-file-survived\\n' > /tmp/substrate-play.txt")
    assert created["exitCode"] == 0, created
    snapshot = suspend(name, SANDBOX)
    play.ate(["resume", "actor", name, "-a", SANDBOX], capture=True)
    restored = execute("cat /tmp/substrate-play.txt")
    assert restored["stdout"] == "snapshot-file-survived\n" and restored["exitCode"] == 0, restored
    suspend(name, SANDBOX)
    wrapper = subprocess.run([str(play.ROOT / "play.sh"), "sandbox", "--command", "printf 'wrapper-exit-ok\\n'; exit 7"], capture_output=True, text=True)
    assert wrapper.returncode == 7 and "wrapper-exit-ok" in wrapper.stdout, wrapper
    return {"output_and_exit_code": output, "snapshot": snapshot, "restored_file": restored,
            "wrapper_exit_code": wrapper.returncode}


def external_containers():
    baseline = json.loads((play.ROOT / "state/baseline.json").read_text())
    verified = []
    for item in baseline["containers"]:
        info = json.loads(play.run(play.DOCKER + ["inspect", item["name"]], capture=True))[0]
        health = info["State"].get("Health", {}).get("Status")
        assert info["Id"] == item["id"] and info["State"]["Running"] == item["running"], item["name"]
        assert health == item["health"], (item["name"], health)
        assert info["HostConfig"]["RestartPolicy"] == item["restart_policy"], item["name"]
        verified.append({"name": item["name"], "same_id": True, "running": info["State"]["Running"], "health": health})
    return verified


def cycle():
    before = counter()
    # Cover a locally paused actor as well as an actively running sandbox.
    play.ate(["pause", "actor", "my-counter-1", "-a", SPACE], capture=True)
    play.ate(["resume", "actor", "my-sandbox-1", "-a", SANDBOX], capture=True)
    play.stop()
    assert not play.inspect_owned(play.NODE)["State"]["Running"]
    assert not play.inspect_owned(play.REGISTRY)["State"]["Running"]
    stopped_supabase = external_containers()
    with play.socket.socket() as s:
        assert s.connect_ex(("127.0.0.1", 8000)) != 0
    play.start()
    after = counter()
    next_count(before, after)
    paused_after_restart = actor("my-counter-1")
    play.ate(["resume", "actor", "my-sandbox-1", "-a", SANDBOX], capture=True)
    restored = play.request(SANDBOX, "my-sandbox-1", "/process", {"command": ["sh", "-c", "cat /tmp/substrate-play.txt"], "timeout": "60s"})
    assert restored["stdout"] == "snapshot-file-survived\n" and restored["exitCode"] == 0, restored
    suspend("my-sandbox-1", SANDBOX)
    suspend("my-counter-1")
    return {"before": before, "after": after, "actor_after_restart": paused_after_restart,
            "sandbox_file": restored, "external_containers_while_stopped": stopped_supabase}


def boundaries():
    baseline = json.loads((play.ROOT / "state/baseline.json").read_text())
    config = Path.home() / ".kube/config"
    digest = hashlib.sha256(config.read_bytes()).hexdigest() if config.exists() else None
    assert digest == baseline["kubeconfig_sha256"]
    ambient = play.run(["kubectl", "--kubeconfig", str(config), "config", "current-context"], capture=True).strip() if config.exists() else None
    assert ambient == baseline["kubernetes_current_context"]
    registry = play.inspect_owned(play.REGISTRY)
    bindings = registry["HostConfig"]["PortBindings"]["5000/tcp"]
    assert bindings == [{"HostIp": "127.0.0.1", "HostPort": "5001"}], bindings
    forward = play.forward_owner()
    assert forward and "--address=127.0.0.1" in forward["args"]
    source = play.ROOT / "src/substrate"
    commit = play.run(["git", "-C", str(source), "rev-parse", "HEAD"], capture=True).strip()
    assert commit == baseline["source_commit"]
    git_status = play.run(["git", "-C", str(source), "status", "--porcelain"], capture=True)
    assert not git_status, git_status
    listeners = play.run(["lsof", "-nP", "-a", "-p", str(forward["pid"]), "-iTCP", "-sTCP:LISTEN"], capture=True)
    assert "127.0.0.1:8000" in listeners and "*:8000" not in listeners, listeners
    return {"kubeconfig_sha256": digest, "ambient_context": ambient, "source_commit": commit,
            "source_clean": True, "registry_bindings": bindings, "router_listener": listeners.strip(),
            "external_containers": external_containers()}


if __name__ == "__main__":
    phase = sys.argv[1] if len(sys.argv) > 1 else "actors"
    if phase == "actors":
        for name, fn in [("environment_ready", core), ("counter_continuity", counter_continuity),
                         ("worker_recreation", worker_recreation), ("worker_reuse", worker_reuse),
                         ("sandbox", sandbox)]:
            check(name, fn)
    elif phase == "cycle":
        check("stop_start", cycle)
        check("target_and_existing_resources", boundaries)
        check("environment_after_restart", core)
    else:
        raise SystemExit("Usage: actors.py [actors|cycle]")
