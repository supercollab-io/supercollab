#!/usr/bin/env bash
set -euo pipefail

SC_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SC_ACTIONLINT_VERSION="1.7.12"
SC_ACTIONLINT_ARCHIVE="actionlint_${SC_ACTIONLINT_VERSION}_linux_amd64.tar.gz"
SC_ACTIONLINT_SHA256="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
SC_TEMP_ROOT="$(mktemp -d "${RUNNER_TEMP:-/tmp}/supercollab-actionlint.XXXXXX")"
trap 'rm -rf -- "${SC_TEMP_ROOT}"' EXIT

curl --fail --silent --show-error --location \
  "https://github.com/rhysd/actionlint/releases/download/v${SC_ACTIONLINT_VERSION}/${SC_ACTIONLINT_ARCHIVE}" \
  --output "${SC_TEMP_ROOT}/${SC_ACTIONLINT_ARCHIVE}"
printf '%s  %s\n' "${SC_ACTIONLINT_SHA256}" "${SC_TEMP_ROOT}/${SC_ACTIONLINT_ARCHIVE}" | sha256sum --check --status
tar --extract --gzip --file "${SC_TEMP_ROOT}/${SC_ACTIONLINT_ARCHIVE}" --directory "${SC_TEMP_ROOT}" actionlint

cd "${SC_REPO_ROOT}"
"${SC_TEMP_ROOT}/actionlint" -color
