#!/usr/bin/env bash
set -euo pipefail

SC_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SC_GITLEAKS_VERSION="8.30.1"
SC_GITLEAKS_ARCHIVE="gitleaks_${SC_GITLEAKS_VERSION}_linux_x64.tar.gz"
SC_GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
SC_TEMP_ROOT="$(mktemp -d "${RUNNER_TEMP:-/tmp}/supercollab-gitleaks.XXXXXX")"
trap 'rm -rf -- "${SC_TEMP_ROOT}"' EXIT

curl --fail --silent --show-error --location \
  "https://github.com/gitleaks/gitleaks/releases/download/v${SC_GITLEAKS_VERSION}/${SC_GITLEAKS_ARCHIVE}" \
  --output "${SC_TEMP_ROOT}/${SC_GITLEAKS_ARCHIVE}"
printf '%s  %s\n' "${SC_GITLEAKS_SHA256}" "${SC_TEMP_ROOT}/${SC_GITLEAKS_ARCHIVE}" | sha256sum --check --status
tar --extract --gzip --file "${SC_TEMP_ROOT}/${SC_GITLEAKS_ARCHIVE}" --directory "${SC_TEMP_ROOT}" gitleaks

"${SC_TEMP_ROOT}/gitleaks" git --no-banner --redact=100 --log-opts="--all" "${SC_REPO_ROOT}"
"${SC_TEMP_ROOT}/gitleaks" dir --no-banner --redact=100 "${SC_REPO_ROOT}"
