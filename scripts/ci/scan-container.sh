#!/usr/bin/env bash
set -euo pipefail

if (( $# < 1 )); then
  echo "usage: scripts/ci/scan-container.sh IMAGE [IMAGE ...]" >&2
  exit 2
fi

SC_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SC_TRIVY_VERSION="0.72.0"
SC_TRIVY_ARCHIVE="trivy_${SC_TRIVY_VERSION}_Linux-64bit.tar.gz"
SC_TRIVY_SHA256="bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea"
SC_TEMP_ROOT="$(mktemp -d "${RUNNER_TEMP:-/tmp}/supercollab-trivy.XXXXXX")"
trap 'rm -rf -- "${SC_TEMP_ROOT}"' EXIT

curl --fail --silent --show-error --location \
  "https://github.com/aquasecurity/trivy/releases/download/v${SC_TRIVY_VERSION}/${SC_TRIVY_ARCHIVE}" \
  --output "${SC_TEMP_ROOT}/${SC_TRIVY_ARCHIVE}"
printf '%s  %s\n' "${SC_TRIVY_SHA256}" "${SC_TEMP_ROOT}/${SC_TRIVY_ARCHIVE}" | sha256sum --check --status
tar --extract --gzip --file "${SC_TEMP_ROOT}/${SC_TRIVY_ARCHIVE}" --directory "${SC_TEMP_ROOT}" trivy

"${SC_TEMP_ROOT}/trivy" config --exit-code 1 --severity HIGH,CRITICAL \
  --ignorefile "${SC_REPO_ROOT}/.trivyignore.yaml" "${SC_REPO_ROOT}"
for SC_IMAGE in "$@"; do
  "${SC_TEMP_ROOT}/trivy" image --exit-code 1 --severity HIGH,CRITICAL --scanners vuln "${SC_IMAGE}"
done
