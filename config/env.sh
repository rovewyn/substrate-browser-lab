#!/usr/bin/env bash
# Environment for this local playground only. Source from a child process.
# Resolve the checkout directory when sourced by Bash or zsh.
if [[ -n "${BASH_VERSION:-}" ]]; then
  _lab_env_file="${BASH_SOURCE[0]}"
elif [[ -n "${ZSH_VERSION:-}" ]]; then
  _lab_env_file="${(%):-%x}"
else
  echo "Source config/env.sh from Bash or zsh." >&2
  return 1
fi
PLAY_ROOT="$(cd "$(dirname "$_lab_env_file")/.." && pwd)"
unset _lab_env_file
export PLAY_ROOT
export PATH="${PLAY_ROOT}/bin:/opt/homebrew/bin:${HOME}/go/bin:${PATH}"
export DOCKER_CONTEXT=desktop-linux
export KIND_CLUSTER_NAME=substrate-play
export KUBECTL_CONTEXT=kind-substrate-play
export KUBECONFIG="${PLAY_ROOT}/state/kubeconfig"
export NO_DEV_ENV=true
export ATE_INSTALL_KIND=true
export KO_DOCKER_REPO=localhost:5001
export KO_DEFAULTPLATFORMS=linux/arm64
export BUCKET_NAME=ate-snapshots
export ATE_RECORD_DIR="${PLAY_ROOT}/state/install-records"
export ATE_INSTALL_ROLLOUT_TIMEOUT=5m
export GOCACHE="${PLAY_ROOT}/cache/go-build"
export GOMODCACHE="${PLAY_ROOT}/cache/go-mod"
export GOPATH="${PLAY_ROOT}/cache/go-path"
export BUILDX_CONFIG="${PLAY_ROOT}/cache/buildx"
export PYTHONPYCACHEPREFIX="${PLAY_ROOT}/cache/python"
export GOTOOLCHAIN=local
export GOMAXPROCS=6
unset GCE_REGION CLUSTER_LOCATION NETWORK SUBNETWORK MEMORYSTORE_INSTANCE PROJECT_ID
unset ATE_CONFIG ATE_IMAGE_REPO ATE_IMAGE_TAG EXPECTED_JWT_ISSUER
