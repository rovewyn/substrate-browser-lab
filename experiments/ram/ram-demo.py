#!/usr/bin/env python3
"""Demonstrate a memory-only process surviving replacement of its worker Pod."""
import base64
from datetime import datetime, timezone
import hashlib
import gzip
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import play

SPACE = "ate-demo-sandbox"
NAME = "ram-demo-1"
REMOTE = "/tmp/substrate-ram-demo"
RECORD = play.ROOT / "state/ram-demo.json"
record = json.loads(RECORD.read_text()) if RECORD.exists() else {"actor": NAME, "atespace": SPACE}


def save(stage):
    record["stage"] = stage
    record["updated_at"] = datetime.now(timezone.utc).isoformat()
    RECORD.write_text(json.dumps(record, indent=2) + "\n")


def actor():
    return json.loads(play.ate(["get", "actor", NAME, "-a", SPACE, "-o", "json"], capture=True))


def execute(command):
    output = play.request(SPACE, NAME, "/process", {"command": ["sh", "-c", command], "timeout": "60s"})
    if output["exitCode"] != 0:
        raise RuntimeError(json.dumps(output))
    return output["stdout"]


def get_state(path="status"):
    return json.loads(execute("wget -qO- 'http://127.0.0.1:8765/" + path + "'"))


def prepare():
    if any(a["metadata"]["atespace"] == SPACE and a["metadata"]["name"] == NAME for a in play.actors()):
        raise RuntimeError("Actor name already exists; preserving it")
    play.ate(["create", "actor", NAME, "-a", SPACE, "--template", "sandbox-template"], capture=True)
    record["created_uid"] = actor()["metadata"]["uid"]
    save("created")
    initialize()


def initialize():
    assert record["stage"] == "created", record["stage"]
    current_uid = actor()["metadata"]["uid"]
    if record.get("created_uid") and record["created_uid"] != current_uid:
        raise RuntimeError("Actor UID changed; preserving the replacement Actor")
    record["created_uid"] = current_uid
    save("created")
    play.ate(["resume", "actor", NAME, "-a", SPACE], capture=True)
    binary = (play.ROOT / "bin/ram-demo").read_bytes()
    source = (play.ROOT / "experiments/ram/main.go").read_bytes()
    execute("mkdir -p " + REMOTE + "; : > " + REMOTE + "/binary.gz.b64")
    encoded = base64.b64encode(gzip.compress(binary, mtime=0)).decode()
    for offset in range(0, len(encoded), 48000):
        chunk = encoded[offset:offset + 48000]
        execute("cat >> " + REMOTE + "/binary.gz.b64 <<'RAM_DEMO_DATA'\n" + chunk + "\nRAM_DEMO_DATA\n")
    execute("base64 -d " + REMOTE + "/binary.gz.b64 | gzip -d > " + REMOTE + "/ram-demo; chmod 755 " + REMOTE + "/ram-demo; rm " + REMOTE + "/binary.gz.b64")
    execute("base64 -d > " + REMOTE + "/main.go <<'RAM_DEMO_DATA'\n" + base64.b64encode(source).decode() + "\nRAM_DEMO_DATA\n")
    record["binary_sha256"] = hashlib.sha256(binary).hexdigest()
    record["source_sha256"] = hashlib.sha256(source).hexdigest()
    execute("nohup " + REMOTE + "/ram-demo > " + REMOTE + "/startup.log 2>&1 < /dev/null &")
    deadline = time.monotonic() + 10
    while True:
        try:
            initial = get_state()
            break
        except RuntimeError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.1)
    assert initial["counter"] == 0, initial
    before = get_state("increment?n=42")
    assert before["counter"] == 42 and before["token"] == initial["token"]
    record["initial"] = initial
    record["before"] = before
    record["before_assignment"] = actor()["status"]["workerAssignment"]
    save("prepared")
    print(json.dumps({"stage": "before_suspend", "state": before, "worker": record["before_assignment"]["workerPod"]}, indent=2), flush=True)


def move():
    assert record["stage"] == "prepared", record["stage"]
    play.ate(["suspend", "actor", NAME, "-a", SPACE], capture=True)
    paused = actor()
    assert paused["status"]["state"] == "ACTOR_STATE_SUSPENDED"
    assert paused["status"]["externalSnapshot"]["fidelity"] == "SNAPSHOT_FIDELITY_MEMORY"
    record["snapshot"] = paused["status"]["externalSnapshot"]
    save("suspended")
    old = record["before_assignment"]
    assert old["workerNamespace"] == SPACE
    other = [a["metadata"] for a in play.actors()
             if a.get("status", {}).get("workerAssignment", {}).get("workerPodUid") == old["workerPodUid"]]
    if other:
        raise RuntimeError("Original worker now serves another actor; preserving its Pod: " + json.dumps(other))
    pod = json.loads(play.run(play.KUBE + ["-n", SPACE, "get", "pod", old["workerPod"], "-o", "json"], capture=True))
    assert pod["metadata"]["uid"] == old["workerPodUid"]
    play.run(play.KUBE + ["-n", SPACE, "delete", "pod", old["workerPod"], "--wait=true"])
    save("old_worker_deleted")
    play.run(play.KUBE + ["-n", SPACE, "rollout", "status", "deployment/sandbox-workerpool", "--timeout=300s"])
    play.ate(["resume", "actor", NAME, "-a", SPACE], capture=True)
    record["after_assignment"] = actor()["status"]["workerAssignment"]
    assert record["after_assignment"]["workerPodUid"] != old["workerPodUid"]
    after = get_state()
    record["after"] = after
    assert after == record["before"], (record["before"], after)
    incremented = get_state("increment")
    record["incremented"] = incremented
    assert incremented["counter"] == 43
    assert incremented["token"] == after["token"] and incremented["pid"] == after["pid"]
    play.ate(["suspend", "actor", NAME, "-a", SPACE], capture=True)
    record["final_actor"] = actor()
    record["passed"] = True
    save("passed")
    print(json.dumps({"stage": "after_restore", "state": after, "worker": record["after_assignment"]["workerPod"],
                      "after_increment": incremented, "passed": True}, indent=2), flush=True)


if __name__ == "__main__":
    if sys.argv[1:] == ["prepare"]:
        prepare()
    elif sys.argv[1:] == ["initialize"]:
        initialize()
    elif sys.argv[1:] == ["move"]:
        move()
    else:
        raise SystemExit("Usage: ram-demo.py {prepare|initialize|move}")
