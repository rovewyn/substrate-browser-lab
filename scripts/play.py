#!/usr/bin/env python3
"""Operate the named local playground; never use an ambient cluster context."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
CONTEXT = "kind-substrate-play"
KUBECONFIG = str(ROOT / "state/kubeconfig")
DOCKER = ["docker", "--context", "desktop-linux"]
KUBE = ["kubectl", "--kubeconfig", KUBECONFIG, "--context", CONTEXT]
ATE = [os.environ.get("KUBECTL_ATE_BIN", "kubectl-ate"), "--kubeconfig", KUBECONFIG, "--context", CONTEXT]
NODE = "substrate-play-control-plane"
REGISTRY = "substrate-play-registry"
VOLUME = "substrate-play-registry-data"
PF_STATE = ROOT / "state/router-forward.json"
GATEWAY_STATE = ROOT / "state/browser/gateway.json"
INACTIVE = {"ACTOR_STATE_SUSPENDED", "ACTOR_STATE_CRASHED"}


def run(args, capture=False, timeout=360):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE if capture else None,
                            check=True, timeout=timeout)
    return result.stdout if capture else None


def inspect_owned(name):
    info = json.loads(run(DOCKER + ["inspect", name], capture=True))[0]
    labels = info["Config"]["Labels"] or {}
    if name == NODE:
        owned = labels.get("io.x-k8s.kind.cluster") == "substrate-play"
    else:
        owned = labels.get("local.substrate-play.owner") == "substrate-play"
    if not owned:
        raise RuntimeError("Refusing to operate on a container owned by another environment: " + name)
    return info


def validate_ate_args(args):
    for arg in args:
        if arg.split("=", 1)[0] in {"--context", "--kubeconfig", "--endpoint"}:
            raise RuntimeError("This wrapper fixes the local target; remove " + arg.split("=", 1)[0])


def ate(args, capture=False):
    validate_ate_args(args)
    return run(ATE + args, capture=capture)


def actors():
    return json.loads(ate(["get", "actors", "-A", "-o", "json"], capture=True)).get("actors", [])


def suspend_all():
    # Complete every suspension before stopping either container.
    for actor in actors():
        if actor["status"]["state"] not in INACTIVE:
            meta = actor["metadata"]
            ate(["suspend", "actor", meta["name"], "-a", meta["atespace"]])
    remaining = [a["metadata"] for a in actors() if a["status"]["state"] not in INACTIVE]
    if remaining:
        raise RuntimeError("Actors are still active; containers remain running: " + json.dumps(remaining))


def forward_owner():
    if not PF_STATE.exists():
        return None
    record = json.loads(PF_STATE.read_text())
    result = subprocess.run(["ps", "-p", str(record["pid"]), "-o", "command="],
                            text=True, capture_output=True)
    if result.returncode != 0:
        if "not permitted" in result.stderr.lower():
            raise RuntimeError("Cannot verify port-forward ownership: " + result.stderr.strip())
        PF_STATE.unlink()
        return None
    command = result.stdout
    required = [KUBECONFIG, CONTEXT, "port-forward", "svc/atenet-router", "8000:80"]
    if not all(part in command for part in required):
        raise RuntimeError("Recorded port-forward PID no longer belongs to this playground")
    return record


def stop_forward():
    record = forward_owner()
    if record:
        os.killpg(record["pid"], signal.SIGTERM)
        PF_STATE.unlink()


def start_forward():
    if forward_owner():
        return
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", 8000))
        except OSError as error:
            raise RuntimeError("Port 8000 is already occupied; existing listener was preserved") from error
    args = KUBE + ["-n", "ate-system", "port-forward", "--address=127.0.0.1",
                   "svc/atenet-router", "8000:80"]
    with (ROOT / "state/logs/router-forward.log").open("a") as log:
        proc = subprocess.Popen(args, stdout=log, stderr=log, start_new_session=True)
    PF_STATE.write_text(json.dumps({"pid": proc.pid, "args": args}) + "\n")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            PF_STATE.unlink()
            raise RuntimeError("Router port-forward failed; see state/logs/router-forward.log")
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", 8000)) == 0:
                return
        time.sleep(0.25)
    stop_forward()
    raise RuntimeError("Router port-forward did not become ready")


def start():
    for name in [REGISTRY, NODE]:
        inspect_owned(name)
    for name in [REGISTRY, NODE]:
        run(DOCKER + ["start", name])
    node_started = parse_timestamp(inspect_owned(NODE)["State"]["StartedAt"])
    deadline = time.monotonic() + 120
    while True:
        try:
            ready = subprocess.run(KUBE + ["get", "--raw=/readyz"], capture_output=True,
                                   text=True, timeout=15)
        except subprocess.TimeoutExpired:
            ready = None
        if ready and ready.returncode == 0 and ready.stdout.strip() == "ok":
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("Kubernetes API did not become ready after starting the node")
        time.sleep(1)
    run(KUBE + ["wait", "--for=condition=Ready", "node/" + NODE, "--timeout=300s"])
    wait_for_current_containers(node_started)
    # Network namespace sysctls reset when the Docker node is stopped.
    run(DOCKER + ["exec", NODE, "sysctl", "net.ipv4.conf.all.proxy_arp=1"])
    run(DOCKER + ["exec", NODE, "sysctl", "-e", "net.ipv6.conf.all.proxy_ndp=1"])
    for namespace, deployment in [("ate-system", "ate-api-server"),
                                  ("ate-system", "atenet-router"),
                                  *worker_deployments()]:
        run(KUBE + ["-n", namespace, "rollout", "status", "deployment/" + deployment,
                    "--timeout=300s"])
    refresh_worker_addresses()
    start_forward()
    if (ROOT / 'state/browser/deployed.json').exists():
        start_gateway()
    print("Playground ready. Router: http://127.0.0.1:8000")


def parse_timestamp(value):
    # Docker may report nanoseconds; macOS system Python accepts fewer digits.
    # Whole seconds are sufficient to reject the previous node session.
    return datetime.strptime(value[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)


def wait_for_current_containers(node_started):
    # The API can briefly retain pre-reboot Ready status. Require fresh runtime
    # start timestamps before trusting rollout status or opening a port-forward.
    deadline = time.monotonic() + 300
    while True:
        pods = json.loads(run(KUBE + ["get", "pods", "-A", "-o", "json"], capture=True))["items"]
        pending = []
        for pod in pods:
            namespace = pod["metadata"]["namespace"]
            if not (namespace.startswith("ate-") or namespace in {"otel-system", "podcertificate-controller-system"}):
                continue
            if pod["status"].get("phase") == "Succeeded":
                continue
            containers = pod["status"].get("containerStatuses", [])
            ready = bool(containers)
            for container in containers:
                timestamp = container.get("state", {}).get("running", {}).get("startedAt")
                ready = ready and container.get("ready", False) and bool(timestamp)
                if timestamp:
                    ready = ready and parse_timestamp(timestamp) >= node_started
            if not ready:
                pending.append(namespace + "/" + pod["metadata"]["name"])
        if not pending:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError("Containers did not become ready after node start: " + ", ".join(pending))
        time.sleep(2)


def refresh_worker_addresses():
    # Worker IPs are immutable in this upstream version. A node restart can
    # change a pod IP without changing its UID, leaving the database stale.
    deployments=worker_deployments()
    namespaces={namespace for namespace,_ in deployments}
    desired=sum(json.loads(run(KUBE+['-n',namespace,'get','deployment',name,'-o','json'],
                              capture=True))['spec']['replicas'] for namespace,name in deployments)
    deadline = time.monotonic() + 120
    refreshed = []
    while True:
        pods = json.loads(run(KUBE + ["get", "pods", "-A", "-o", "json"], capture=True))["items"]
        live = {(p["metadata"]["namespace"], p["metadata"]["name"]): p for p in pods
                if p["metadata"]["namespace"] in namespaces and not p["metadata"].get("deletionTimestamp")}
        workers = json.loads(ate(["get", "workers", "-o", "json"], capture=True)).get("workers", [])
        stale, matched = [], set()
        for worker in workers:
            key = (worker["workerNamespace"], worker["workerPod"])
            pod = live.get(key)
            if not pod or pod["metadata"]["uid"] != worker["workerPodUid"]:
                continue
            ips = [ip["ip"] for ip in pod["status"].get("podIPs", [])]
            if not ips:
                continue
            if set(ips) != set(worker["ips"]):
                stale.append({"namespace": key[0], "pod": key[1], "old_ips": worker["ips"], "new_ips": ips})
            elif worker["status"]["state"] == "WORKER_STATE_ACTIVE":
                matched.add(key)
        if stale:
            print("Worker addresses changed; saving actors before replacing worker pods.", flush=True)
            suspend_all()
            for item in stale:
                run(KUBE + ["-n", item["namespace"], "delete", "pod", item["pod"], "--wait=true"])
            refreshed.extend(stale)
            (ROOT / "state/worker-address-refresh.json").write_text(json.dumps(refreshed, indent=2) + "\n")
            for namespace, deployment in deployments:
                run(KUBE + ["-n", namespace, "rollout", "status", "deployment/" + deployment, "--timeout=300s"])
        elif len(live) == desired and len(matched) == desired:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError("Worker registration did not converge to the current pod addresses")
        time.sleep(1)


def worker_deployments():
    deployments=[('ate-demo-counter','counter'),('ate-demo-sandbox','sandbox-workerpool')]
    if (ROOT / 'state/browser/deployed.json').exists():
        deployments.append(('ate-demo-browser','browser-workerpool'))
    return deployments


def gateway_health():
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:8931/_gateway/health',timeout=2) as response:
        value=json.load(response)
    if value.get('owner')!='substrate-play' or value.get('root')!=str(ROOT) or value.get('actor')!='browser-1':
        raise RuntimeError('Port 8931 belongs to another service; existing listener was preserved')
    return value


def start_gateway():
    try:
        existing=gateway_health()
    except OSError:
        existing=None
    if existing:
        GATEWAY_STATE.write_text(json.dumps(existing)+'\n')
        print('Browser MCP: http://127.0.0.1:8931/mcp');return
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        try:sock.bind(('127.0.0.1',8931))
        except OSError as error:
            raise RuntimeError('Port 8931 is occupied; existing listener was preserved') from error
    token=uuid.uuid4().hex
    with (ROOT/'state/logs/browser/gateway.log').open('a') as log:
        proc=subprocess.Popen([sys.executable,str(ROOT/'experiments/browser/scripts/gateway.py'),'--token',token],
                              stdout=log,stderr=log,start_new_session=True)
    deadline=time.monotonic()+10
    while True:
        try:
            value=gateway_health()
            if value['pid']!=proc.pid or value['token']!=token:
                raise RuntimeError('Gateway ownership changed while starting')
            GATEWAY_STATE.write_text(json.dumps(value)+'\n')
            print('Browser MCP: http://127.0.0.1:8931/mcp');return
        except OSError:
            if proc.poll() is not None or time.monotonic()>deadline:
                raise RuntimeError('Browser gateway did not start; see state/logs/browser/gateway.log')
            time.sleep(.1)


def stop_gateway():
    if not GATEWAY_STATE.exists():return
    expected=json.loads(GATEWAY_STATE.read_text())
    try:current=gateway_health()
    except OSError:
        GATEWAY_STATE.unlink();return
    if current['pid']!=expected['pid'] or current['token']!=expected['token']:
        raise RuntimeError('Gateway ownership changed; existing listener was preserved')
    os.kill(current['pid'],signal.SIGTERM)
    GATEWAY_STATE.unlink()


def stop():
    node = inspect_owned(NODE)
    inspect_owned(REGISTRY)
    if node["State"]["Running"]:
        suspend_all()
    stop_gateway()
    stop_forward()
    run(DOCKER + ["stop", NODE, REGISTRY])
    print("Playground stopped. Container and PVC data retained.")


def status():
    for name in [REGISTRY, NODE]:
        info = inspect_owned(name)
        print(name + ": " + info["State"]["Status"], flush=True)
    if inspect_owned(NODE)["State"]["Running"]:
        run(KUBE + ["get", "pods", "-A"])
        ate(["get", "actors", "-A"])
        ate(["get", "workers"])


def request(atespace, name, path="/", payload=None):
    data = json.dumps(payload).encode() if payload is not None else b""
    req = urllib.request.Request("http://127.0.0.1:8000" + path, data=data, method="POST",
                                 headers={"ate-target-actor": atespace + "/" + name,
                                          "Content-Type": "application/json"})
    # These local requests do not use ambient HTTP proxy settings.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=180) as response:
        body = response.read().decode()
        if "application/json" in response.headers.get("Content-Type", ""):
            return json.loads(body)
        return body


def sandbox(argv):
    parser = argparse.ArgumentParser(prog="play.sh sandbox")
    parser.add_argument("--actor", default="my-sandbox-1")
    parser.add_argument("--command", help="Execute one command and return its exit code")
    args = parser.parse_args(argv)
    ate(["resume", "actor", args.actor, "-a", "ate-demo-sandbox"])
    code = 0
    try:
        while True:
            if args.command is not None:
                line = args.command
            else:
                try:
                    line = input("sandbox> ")
                except (EOFError, KeyboardInterrupt):
                    print()
                    break
            if line.strip() == "exit" and args.command is None:
                break
            if not line.strip():
                continue
            output = request("ate-demo-sandbox", args.actor, "/process",
                             {"command": ["sh", "-c", line], "timeout": "60s"})
            print(output.get("stdout", ""), end="")
            print(output.get("stderr", ""), end="", file=sys.stderr)
            code = output["exitCode"]
            if output.get("error"):
                print(output["error"], file=sys.stderr)
            if args.command is not None:
                break
    finally:
        ate(["suspend", "actor", args.actor, "-a", "ate-demo-sandbox"])
    return code if code >= 0 else 1


def destroy(argv):
    if argv != ["--confirm-delete-data"]:
        raise RuntimeError("Deletes this cluster and its data. Run: play.sh destroy --confirm-delete-data")
    inspect_owned(NODE)
    inspect_owned(REGISTRY)
    volume = json.loads(run(DOCKER + ["volume", "inspect", VOLUME], capture=True))[0]
    if (volume["Labels"] or {}).get("local.substrate-play.owner") != "substrate-play":
        raise RuntimeError("Registry volume is owned by another environment")
    stop_gateway()
    stop_forward()
    run(["kind", "delete", "cluster", "--name", "substrate-play", "--kubeconfig", KUBECONFIG])
    run(DOCKER + ["rm", "-f", REGISTRY])
    run(DOCKER + ["volume", "rm", VOLUME])
    print("Playground cluster and data deleted. Source and global tools retained.")


def main(argv):
    if not argv or argv[0] in {"help", "-h", "--help"}:
        print("Usage: play.sh {start|status|counter [ACTOR]|sandbox [--command COMMAND]|ate ARGS|stop|destroy --confirm-delete-data}")
        return 0
    (ROOT / "state/logs/browser").mkdir(parents=True, exist_ok=True)
    (ROOT / "state/browser").mkdir(parents=True, exist_ok=True)
    command, args = argv[0], argv[1:]
    if command == "ate":
        ate(args)
    elif command == "counter":
        if len(args) > 1:
            raise RuntimeError("Usage: play.sh counter [ACTOR]")
        response = request("ate-demo-counter", args[0] if args else "my-counter-1")
        print(response if isinstance(response, str) else json.dumps(response, indent=2), end="\n")
    elif command == "sandbox":
        return sandbox(args)
    elif command == "destroy":
        destroy(args)
    elif command in {"start", "status", "stop"} and not args:
        {"start": start, "status": status, "stop": stop}[command]()
    else:
        raise RuntimeError("Unknown command or unexpected arguments; run play.sh help")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (RuntimeError, subprocess.SubprocessError, OSError, ValueError) as error:
        print("Error: " + str(error), file=sys.stderr)
        sys.exit(1)
