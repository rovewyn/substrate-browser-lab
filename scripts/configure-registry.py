#!/usr/bin/env python3
"""Replace the upstream Kind registry name in this cluster only."""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import play

deployments = json.loads(play.run(play.KUBE + ["-n", "ate-system", "get", "daemonsets", "-o", "json"], capture=True))
matched = 0
for deployment in deployments["items"]:
    patches = []
    for ci, container in enumerate(deployment["spec"]["template"]["spec"]["containers"]):
        for ai, arg in enumerate(container.get("args", [])):
            if arg.startswith("--localhost-registry-replacement="):
                matched += 1
                patches.append({"op": "replace", "path": f"/spec/template/spec/containers/{ci}/args/{ai}",
                                "value": "--localhost-registry-replacement=substrate-play-registry:5000"})
    if patches:
        name = deployment["metadata"]["name"]
        play.run(play.KUBE + ["-n", "ate-system", "patch", "daemonset", name, "--type=json", "-p", json.dumps(patches)])
        play.run(play.KUBE + ["-n", "ate-system", "rollout", "status", "daemonset/" + name, "--timeout=300s"])
if not matched:
    raise SystemExit("No atelet registry setting found; refusing to continue")
