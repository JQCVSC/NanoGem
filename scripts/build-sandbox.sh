#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE_NAME="${NANOGEM_SANDBOX_IMAGE:-${NANOGEM_DOCKER_IMAGE:-nanogem-sandbox:latest}}"

HOST_UID=1000
HOST_GID=1000
if [ "$(uname -s 2>/dev/null || echo unknown)" = "Linux" ]; then
  DETECTED_UID="$(id -u 2>/dev/null || echo 1000)"
  DETECTED_GID="$(id -g 2>/dev/null || echo 1000)"
  if [ "${DETECTED_UID}" != "0" ]; then
    HOST_UID="${DETECTED_UID}"
  fi
  if [ "${DETECTED_GID}" != "0" ]; then
    HOST_GID="${DETECTED_GID}"
  fi
fi

SANDBOX_UID="${NANOGEM_SANDBOX_UID:-${HOST_UID}}"
SANDBOX_GID="${NANOGEM_SANDBOX_GID:-${HOST_GID}}"

if ! printf '%s' "${SANDBOX_UID}" | grep -Eq '^[1-9][0-9]*$' || ! printf '%s' "${SANDBOX_GID}" | grep -Eq '^[1-9][0-9]*$'; then
  echo "Error: Sandbox UID/GID must be positive non-root integers (got ${SANDBOX_UID}:${SANDBOX_GID})." >&2
  exit 1
fi

mkdir -p "${REPO_ROOT}/sandbox_workspace"

echo "Building NanoGem sandbox image '${IMAGE_NAME}' (UID=${SANDBOX_UID}, GID=${SANDBOX_GID})..."
docker build \
  -f "${REPO_ROOT}/Dockerfile" \
  -t "${IMAGE_NAME}" \
  --build-arg "SANDBOX_UID=${SANDBOX_UID}" \
  --build-arg "SANDBOX_GID=${SANDBOX_GID}" \
  "${REPO_ROOT}"

echo "Built '${IMAGE_NAME}' successfully."
if [ "${SANDBOX_UID}:${SANDBOX_GID}" != "1000:1000" ]; then
  echo "Note: Set NANOGEM_DOCKER_USER=${SANDBOX_UID}:${SANDBOX_GID} in your .env to match the built UID/GID."
fi
