#!/bin/sh
set -eu

repo_root=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "Gitleaks is required. On macOS: brew install gitleaks" >&2
  exit 1
fi

if ! gitleaks git --help >/dev/null 2>&1; then
  echo "Update Gitleaks to a version that supports the git command." >&2
  exit 1
fi

existing_hooks_path=$(git -C "$repo_root" config --get core.hooksPath || true)
case "$existing_hooks_path" in
  .githooks) ;;
  "")
    hooks_dir=$(git -C "$repo_root" rev-parse --git-path hooks)
    case "$hooks_dir" in
      /*) ;;
      *) hooks_dir="$repo_root/$hooks_dir" ;;
    esac
    for hook in "$hooks_dir"/*; do
      case "$hook" in
        *.sample) continue ;;
      esac
      if [ -f "$hook" ] && [ -x "$hook" ]; then
        echo "Installation stopped: an active Git hook already exists. Integrate it before switching hooks." >&2
        exit 1
      fi
    done
    ;;
  *)
    echo "Installation stopped: core.hooksPath already points elsewhere. Integrate existing hooks first." >&2
    exit 1
    ;;
esac

git -C "$repo_root" config --local core.hooksPath .githooks
echo "Git hooks enabled: staged changes will be scanned by Gitleaks before each commit."
