#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/config/env.sh"
exec python3 "$PLAY_ROOT/scripts/play.py" "$@"
