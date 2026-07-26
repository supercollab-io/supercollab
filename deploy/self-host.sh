#!/usr/bin/env bash
set -euo pipefail

SC_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SC_RUNTIME_DIR="${SUPERCOLLAB_RUNTIME_DIR:-${SC_REPO_ROOT}/runtime}"
SC_PORT="${SUPERCOLLAB_PORT:-8731}"
SC_PROJECT_NAME="${SUPERCOLLAB_PROJECT_NAME:-supercollab-selfhost}"
SC_PUBLIC_URL="${SUPERCOLLAB_PUBLIC_URL:-http://127.0.0.1:${SC_PORT}}"
SC_API_UID="${SUPERCOLLAB_API_UID:-$(id -u)}"
SC_API_GID="${SUPERCOLLAB_API_GID:-$(id -g)}"
if [[ "${SC_API_UID}" == 0 ]]; then
  SC_API_UID=10001
  SC_API_GID=10001
fi
SC_COMPOSE=(docker compose --project-directory "${SC_REPO_ROOT}" --file "${SC_REPO_ROOT}/deploy/compose.yaml")

usage() {
  cat <<'EOF'
Usage: ./deploy/self-host.sh init|up|status|logs|down

Environment:
  SUPERCOLLAB_RUNTIME_DIR  Private data directory (default: ./runtime)
  SUPERCOLLAB_PUBLIC_URL   External relay origin (default: http://127.0.0.1:8731)
  SUPERCOLLAB_PORT         Loopback host port (default: 8731)
  SUPERCOLLAB_PROJECT_NAME Isolated Compose project (default: supercollab-selfhost)
  SUPERCOLLAB_API_UID/GID  Non-root API identity (default: invoking user)
  SUPERCOLLAB_IMAGE        Optional prebuilt relay image; otherwise build locally

`down` stops containers but preserves PostgreSQL and every secret.
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "self-host: missing required command: $1" >&2; exit 1; }
}

write_secret() {
  local path="$1"
  local value="$2"
  if [[ -e "${path}" ]]; then return; fi
  (umask 077; printf '%s\n' "${value}" > "${path}")
}

validate_secret_path() {
  local path="$1"
  if [[ -L "${path}" || ( -e "${path}" && ! -f "${path}" ) ]]; then
    echo "self-host: refusing unsafe secret path ${path}" >&2
    exit 1
  fi
}

validate_public_settings() {
  if ! [[ "${SC_PORT}" =~ ^[0-9]+$ ]] || (( SC_PORT < 1 || SC_PORT > 65535 )); then
    echo "self-host: SUPERCOLLAB_PORT must be an integer from 1 to 65535" >&2
    exit 1
  fi
  if [[ "${SC_PUBLIC_URL}" == *\?* || "${SC_PUBLIC_URL}" == *\#* || "${SC_PUBLIC_URL}" == *://*@* ]]; then
    echo "self-host: public URL cannot contain credentials, query parameters, or fragments" >&2
    exit 1
  fi
  if [[ "${SC_PUBLIC_URL}" != http://127.0.0.1:* && "${SC_PUBLIC_URL}" != http://localhost:* && ! "${SC_PUBLIC_URL}" =~ ^https://[^[:space:]]+$ ]]; then
    echo "self-host: public URL must use HTTPS unless it is loopback" >&2
    exit 1
  fi
}

initialize() {
  require_command openssl
  require_command cmp
  mkdir -p "${SC_RUNTIME_DIR}/secrets" "${SC_RUNTIME_DIR}/postgres"
  chmod 700 "${SC_RUNTIME_DIR}" "${SC_RUNTIME_DIR}/secrets"
  local owner_path app_db_path app_api_path pepper_path generated path
  owner_path="${SC_RUNTIME_DIR}/secrets/postgres_owner_password"
  app_db_path="${SC_RUNTIME_DIR}/secrets/postgres_app_password.db"
  app_api_path="${SC_RUNTIME_DIR}/secrets/postgres_app_password.api"
  pepper_path="${SC_RUNTIME_DIR}/secrets/server_pepper.b64"
  for path in "${owner_path}" "${app_db_path}" "${app_api_path}" "${pepper_path}"; do
    validate_secret_path "${path}"
  done

  if [[ ! -e "${owner_path}" ]]; then
    generated="$(openssl rand -hex 32)"
    write_secret "${owner_path}" "${generated}"
  fi
  if [[ ! -e "${app_db_path}" && ! -e "${app_api_path}" ]]; then
    generated="$(openssl rand -hex 32)"
    write_secret "${app_db_path}" "${generated}"
    write_secret "${app_api_path}" "${generated}"
  elif [[ ! -e "${app_db_path}" ]]; then
    (umask 077; cp "${app_api_path}" "${app_db_path}")
  elif [[ ! -e "${app_api_path}" ]]; then
    (umask 077; cp "${app_db_path}" "${app_api_path}")
  elif ! cmp -s "${app_db_path}" "${app_api_path}"; then
    echo "self-host: app-password secret copies differ; preserve them and resolve manually" >&2
    exit 1
  fi
  if [[ ! -e "${pepper_path}" ]]; then
    generated="$(openssl rand -base64 32 | tr -d '\r\n')"
    write_secret "${pepper_path}" "${generated}"
  fi
  chmod 600 "${owner_path}" "${app_db_path}" "${app_api_path}" "${pepper_path}"
  if [[ "$(id -u)" == 0 ]]; then
    chown "${SC_API_UID}:${SC_API_GID}" \
      "${app_api_path}" \
      "${pepper_path}"
  fi
  unset generated
  echo "self-host: private runtime initialized at ${SC_RUNTIME_DIR}"
}

compose() {
  SUPERCOLLAB_RUNTIME_DIR="${SC_RUNTIME_DIR}" \
  SUPERCOLLAB_PUBLIC_URL="${SC_PUBLIC_URL}" \
  SUPERCOLLAB_PORT="${SC_PORT}" \
  SUPERCOLLAB_PROJECT_NAME="${SC_PROJECT_NAME}" \
  SUPERCOLLAB_REPO_ROOT="${SC_REPO_ROOT}" \
  SUPERCOLLAB_API_UID="${SC_API_UID}" \
  SUPERCOLLAB_API_GID="${SC_API_GID}" \
  "${SC_COMPOSE[@]}" "$@"
}

wait_for_health() {
  require_command curl
  local health_url="${SC_PUBLIC_URL%/}/health"
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error "${health_url}" >/dev/null 2>&1; then
      echo "self-host: relay ready at ${SC_PUBLIC_URL}"
      echo "self-host: connection skill ${SC_PUBLIC_URL%/}/skill.md"
      return
    fi
    sleep 1
  done
  echo "self-host: relay did not become healthy; inspect ./deploy/self-host.sh logs" >&2
  exit 1
}

main() {
  local command="${1:-}"
  case "${command}" in
    init)
      initialize
      ;;
    up)
      require_command docker
      docker compose version >/dev/null
      validate_public_settings
      initialize
      if [[ -n "${SUPERCOLLAB_IMAGE:-}" ]]; then
        compose pull api
        compose build postgres
        compose up --detach --no-build --remove-orphans
      else
        compose up --detach --build --remove-orphans
      fi
      wait_for_health
      ;;
    status)
      require_command docker
      compose ps
      ;;
    logs)
      require_command docker
      compose logs --tail 200 api postgres
      ;;
    down)
      require_command docker
      compose down
      echo "self-host: containers stopped; data preserved in ${SC_RUNTIME_DIR}"
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
