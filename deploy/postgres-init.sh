#!/bin/sh
set -eu

password_file="${POSTGRES_APP_PASSWORD_FILE_INTERNAL:?missing POSTGRES_APP_PASSWORD_FILE_INTERNAL}"
app_password="$(tr -d '\r\n' < "$password_file")"
rm -f -- "$password_file"
case "$app_password" in
  ''|*[!0-9a-fA-F]*)
    echo "postgres app password must be non-empty hexadecimal" >&2
    exit 1
    ;;
esac

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$body\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supercollab_app') THEN
    CREATE ROLE supercollab_app LOGIN PASSWORD '$app_password';
  ELSE
    ALTER ROLE supercollab_app LOGIN PASSWORD '$app_password';
  END IF;
END
\$body\$;
SQL
unset app_password
unset password_file
