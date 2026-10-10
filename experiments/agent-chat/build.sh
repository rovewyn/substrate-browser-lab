#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
image=localhost:5001/substrate-agent-chat:codex-0.162.1
owner="$(docker --context desktop-linux inspect substrate-play-registry --format '{{index .Config.Labels "local.substrate-play.owner"}}')"
if [[ "$owner" != substrate-play ]]; then
  echo 'The local registry is not owned by substrate-play.' >&2
  exit 1
fi
mkdir -p "$root/state/agent-chat"
export BUILDX_CONFIG="$root/cache/agent-chat/buildx"
mkdir -p "$BUILDX_CONFIG"
docker --context desktop-linux build --platform linux/arm64 -f "$root/experiments/agent-chat/image/Dockerfile" -t "$image" "$root/experiments/agent-chat"
docker --context desktop-linux push "$image"
docker --context desktop-linux image inspect "$image" --format '{{index .RepoDigests 0}}' > "$root/state/agent-chat/image.txt"
echo 'Image digest saved to state/agent-chat/image.txt'
