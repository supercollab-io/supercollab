#!/bin/sh
set -eu

# Docker Compose file-backed secrets retain host ownership. During first
# initialization only, copy the app password to the container's tmpfs before
# the official entrypoint drops privileges. Export only the temporary path;
# 10-supercollab-app-role.sh deletes the file after reading it. The long-lived
# PostgreSQL process never inherits the password value in its environment.
if [ "$(id -u)" = 0 ] && [ ! -s "${PGDATA:-/var/lib/postgresql/data}/PG_VERSION" ]; then
  internal_password_file=/tmp/supercollab-postgres-app-password
  umask 077
  tr -d '\r\n' < "${POSTGRES_APP_PASSWORD_FILE:?missing POSTGRES_APP_PASSWORD_FILE}" > "$internal_password_file"
  chown postgres:postgres "$internal_password_file"
  chmod 600 "$internal_password_file"
  POSTGRES_APP_PASSWORD_FILE_INTERNAL="$internal_password_file"
  export POSTGRES_APP_PASSWORD_FILE_INTERNAL
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
