#!/usr/bin/env bash
set -euo pipefail

SC_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SC_ACTIONLINT_VERSION="1.7.12"
SC_ACTIONLINT_ARCHIVE="actionlint_${SC_ACTIONLINT_VERSION}_linux_amd64.tar.gz"
SC_ACTIONLINT_SHA256="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
SC_SHELLCHECK_VERSION="0.11.0"
SC_SHELLCHECK_ARCHIVE="shellcheck-v${SC_SHELLCHECK_VERSION}.linux.x86_64.tar.xz"
SC_SHELLCHECK_SHA256="8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198"
SC_TEMP_ROOT="$(mktemp -d "${RUNNER_TEMP:-/tmp}/supercollab-actionlint.XXXXXX")"
trap 'rm -rf -- "${SC_TEMP_ROOT}"' EXIT

curl --fail --silent --show-error --location \
  "https://github.com/rhysd/actionlint/releases/download/v${SC_ACTIONLINT_VERSION}/${SC_ACTIONLINT_ARCHIVE}" \
  --output "${SC_TEMP_ROOT}/${SC_ACTIONLINT_ARCHIVE}"
printf '%s  %s\n' "${SC_ACTIONLINT_SHA256}" "${SC_TEMP_ROOT}/${SC_ACTIONLINT_ARCHIVE}" | sha256sum --check --status
tar --extract --gzip --file "${SC_TEMP_ROOT}/${SC_ACTIONLINT_ARCHIVE}" --directory "${SC_TEMP_ROOT}" actionlint
curl --fail --silent --show-error --location \
  "https://github.com/koalaman/shellcheck/releases/download/v${SC_SHELLCHECK_VERSION}/${SC_SHELLCHECK_ARCHIVE}" \
  --output "${SC_TEMP_ROOT}/${SC_SHELLCHECK_ARCHIVE}"
printf '%s  %s\n' "${SC_SHELLCHECK_SHA256}" "${SC_TEMP_ROOT}/${SC_SHELLCHECK_ARCHIVE}" | sha256sum --check --status
tar --extract --xz --file "${SC_TEMP_ROOT}/${SC_SHELLCHECK_ARCHIVE}" --directory "${SC_TEMP_ROOT}"

cd "${SC_REPO_ROOT}"
PATH="${SC_TEMP_ROOT}/shellcheck-v${SC_SHELLCHECK_VERSION}:${PATH}" "${SC_TEMP_ROOT}/actionlint" -color
