#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/config/env.sh"
mkdir -p "$PLAY_ROOT/state/logs/browser" "$PLAY_ROOT/state/browser" "$PLAY_ROOT/cache"
registry=substrate-play-registry
volume=substrate-play-registry-data
owner=substrate-play
node=substrate-play-control-plane

if docker --context "$DOCKER_CONTEXT" inspect "$registry" >/dev/null 2>&1; then
  [[ "$(docker --context "$DOCKER_CONTEXT" inspect -f '{{index .Config.Labels "local.substrate-play.owner"}}' "$registry")" == "$owner" ]] || {
    echo "Registry name belongs to another environment; refusing to replace it." >&2; exit 1;
  }
else
  python3 - <<'PY'
import socket
s=socket.socket()
try:
    s.bind(('127.0.0.1',5001))
except OSError as e:
    raise SystemExit('Port 5001 is already in use: '+str(e))
finally:
    s.close()
PY
  if docker --context "$DOCKER_CONTEXT" volume inspect "$volume" >/dev/null 2>&1; then
    [[ "$(docker --context "$DOCKER_CONTEXT" volume inspect -f '{{index .Labels "local.substrate-play.owner"}}' "$volume")" == "$owner" ]] || {
      echo "Registry volume belongs to another environment." >&2; exit 1;
    }
  else
    docker --context "$DOCKER_CONTEXT" volume create --label "local.substrate-play.owner=$owner" "$volume"
  fi
  docker --context "$DOCKER_CONTEXT" run -d --restart=unless-stopped --name "$registry" \
    --label "local.substrate-play.owner=$owner" \
    -p 127.0.0.1:5001:5000 -v "$volume:/var/lib/registry" registry:3
fi
docker --context "$DOCKER_CONTEXT" start "$registry" >/dev/null

if docker --context "$DOCKER_CONTEXT" inspect "$node" >/dev/null 2>&1; then
  [[ "$(docker --context "$DOCKER_CONTEXT" inspect -f '{{index .Config.Labels "io.x-k8s.kind.cluster"}}' "$node")" == substrate-play ]] || {
    echo "Node name belongs to another environment." >&2; exit 1;
  }
  [[ -f "$KUBECONFIG" ]] || { echo "Existing node has no playground kubeconfig." >&2; exit 1; }
else
  kind create cluster --name "$KIND_CLUSTER_NAME" --config "$PLAY_ROOT/config/kind.yaml" \
    --kubeconfig "$KUBECONFIG" --wait 5m
fi
docker --context "$DOCKER_CONTEXT" exec "$node" sysctl net.ipv4.conf.all.proxy_arp=1
docker --context "$DOCKER_CONTEXT" exec "$node" sysctl -e net.ipv6.conf.all.proxy_ndp=1
docker --context "$DOCKER_CONTEXT" exec "$node" mkdir -p /etc/containerd/certs.d/localhost:5001
printf '[host."http://substrate-play-registry:5000"]\n' | \
  docker --context "$DOCKER_CONTEXT" exec -i "$node" cp /dev/stdin /etc/containerd/certs.d/localhost:5001/hosts.toml
if [[ "$(docker --context "$DOCKER_CONTEXT" inspect -f '{{json .NetworkSettings.Networks.kind}}' "$registry")" == null ]]; then
  docker --context "$DOCKER_CONTEXT" network connect kind "$registry"
fi
kubectl --kubeconfig "$KUBECONFIG" --context "$KUBECTL_CONTEXT" apply -f - <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:5001"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
YAML
kubectl --kubeconfig "$KUBECONFIG" --context "$KUBECTL_CONTEXT" get nodes
