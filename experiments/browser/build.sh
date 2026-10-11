#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "$0")/../.." && pwd)/config/env.sh"
cd "$PLAY_ROOT"
mkdir -p state/browser
python3 -c 'import sys;sys.path.insert(0,"scripts");import play;play.inspect_owned(play.REGISTRY)'
image=localhost:5001/substrate-browser:playwright-0.0.83
docker --context "$DOCKER_CONTEXT" build --platform linux/arm64 -t "$image" experiments/browser/image
docker --context "$DOCKER_CONTEXT" push "$image"
docker --context "$DOCKER_CONTEXT" image inspect "$image" > state/browser/image.json
