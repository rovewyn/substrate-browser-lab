#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "$0")/../.." && pwd)/config/env.sh"
cd "$PLAY_ROOT"
mkdir -p state/browser state/logs/browser outputs
command=${1:-status}
shift || true
case "$command" in
  serve) exec python3 experiments/browser/scripts/gateway.py "$@" ;;
  start) python3 -c 'import sys;sys.path.insert(0,"scripts");import play;play.ate(["resume","actor","browser-1","-a","ate-demo-browser"]);play.start_gateway()' ;;
  stop) python3 -c 'import sys;sys.path.insert(0,"scripts");import play;play.ate(["suspend","actor","browser-1","-a","ate-demo-browser"]);play.stop_gateway()' ;;
  resume) exec ./play.sh ate resume actor browser-1 -a ate-demo-browser ;;
  suspend) exec ./play.sh ate suspend actor browser-1 -a ate-demo-browser ;;
  status) ./play.sh ate get actor browser-1 -a ate-demo-browser; ./play.sh ate get workers -o json ;;
  screenshot) exec python3 experiments/browser/scripts/lab.py screenshot ;;
  verify) exec python3 experiments/browser/scripts/lab.py verify ;;
  suspend-resume) exec python3 experiments/browser/scripts/lab.py suspend-resume ;;
  benchmark) exec python3 experiments/browser/scripts/lab.py benchmark "$@" ;;
  call) exec python3 experiments/browser/scripts/call.py "$@" ;;
  *) printf 'Usage: browser.sh {start|stop|serve|resume|suspend|status|screenshot|verify|suspend-resume|benchmark|call}\n' >&2;exit 2 ;;
esac
