#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/config/env.sh"
cd "$PLAY_ROOT/src/substrate"
[[ "$(git rev-parse HEAD)" == 288694ef2297bb5d6fab30eca328ddaa89015f91 ]] || {
  echo "Source commit differs from the planned version." >&2; exit 1;
}
kubectl --kubeconfig "$KUBECONFIG" --context "$KUBECTL_CONTEXT" get nodes >/dev/null
if [[ "${1:-}" != --demos-only ]]; then
  hack/install-ate-kind.sh --deploy-ate-system --credential-provider='{"name":"k8s.io"}'
fi
python3 "$PLAY_ROOT/scripts/configure-registry.py"
hack/install-ate-kind.sh --deploy-demo-counter
hack/install-ate-kind.sh --deploy-demo-sandbox
kubectl-ate --kubeconfig "$KUBECONFIG" --context "$KUBECTL_CONTEXT" \
  create actor my-counter-1 -a ate-demo-counter --template counter
kubectl-ate --kubeconfig "$KUBECONFIG" --context "$KUBECTL_CONTEXT" \
  create actor my-sandbox-1 -a ate-demo-sandbox --template sandbox-template
