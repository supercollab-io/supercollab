#!/usr/bin/env bash
set -euo pipefail

SC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SC_SUFFIX="${BASHPID}"
SC_NETWORK="supercollab-key-net-${SC_SUFFIX}"
SC_POSTGRES="supercollab-key-postgres-${SC_SUFFIX}"
SC_API="supercollab-key-api-${SC_SUFFIX}"
SC_PORT="${SUPERCOLLAB_E2E_PORT:-$((19000 + BASHPID % 1000))}"
SC_TEMP_DIR="$(mktemp -d /tmp/supercollab-key-e2e.XXXXXX)"
SC_CONFIG="${SC_TEMP_DIR}/config.json"
SC_BETA_CONFIG="${SC_TEMP_DIR}/beta-config.json"
SC_DB_PASSWORD="$(openssl rand -hex 24)"
SC_APP_PASSWORD="$(openssl rand -hex 24)"
SC_PEPPER="$(openssl rand -base64 32 | tr -d '\n')"
SC_SERVER="http://127.0.0.1:${SC_PORT}"
SC_IMAGE="supercollab-api:0.7.0-alpha.4"
SC_POSTGRES_IMAGE="supercollab-postgres:16-alpine"
SC_CLI=(node "${SC_ROOT}/bin/supercollab.js")
SC_STAGE="preflight"

cleanup() {
  docker rm --force "${SC_API}" >/dev/null 2>&1 || true
  docker rm --force "${SC_POSTGRES}" >/dev/null 2>&1 || true
  docker network rm "${SC_NETWORK}" >/dev/null 2>&1 || true
  if [[ "${SC_TEMP_DIR}" == /tmp/supercollab-key-e2e.* ]]; then
    rm -rf -- "${SC_TEMP_DIR}"
  fi
}

finish() {
  local status=$?
  if [[ "${status}" != 0 ]]; then
    echo "isolated-e2e: failed during ${SC_STAGE} (exit ${status})" >&2
    docker logs --tail 40 "${SC_API}" >&2 2>/dev/null || true
    docker logs --tail 80 "${SC_POSTGRES}" >&2 2>/dev/null || true
  fi
  cleanup
  trap - EXIT
  exit "${status}"
}
trap finish EXIT

for target in "${SC_API}" "${SC_POSTGRES}"; do
  if docker inspect "${target}" >/dev/null 2>&1; then
    echo "isolated-e2e: refusing to reuse existing container ${target}" >&2
    exit 1
  fi
done

SC_STAGE="image-build"
docker build --file "${SC_ROOT}/server/Dockerfile" --tag "${SC_IMAGE}" "${SC_ROOT}" >/dev/null
docker build --file "${SC_ROOT}/deploy/postgres.Dockerfile" --tag "${SC_POSTGRES_IMAGE}" "${SC_ROOT}" >/dev/null

docker network create "${SC_NETWORK}" >/dev/null
SC_STAGE="postgres-start"
docker run --detach --name "${SC_POSTGRES}" \
  --network "${SC_NETWORK}" \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --cap-add CHOWN \
  --cap-add DAC_OVERRIDE \
  --cap-add FOWNER \
  --cap-add SETGID \
  --cap-add SETUID \
  --env POSTGRES_DB=supercollab \
  --env POSTGRES_USER=supercollab_owner \
  --env POSTGRES_PASSWORD="${SC_DB_PASSWORD}" \
  "${SC_POSTGRES_IMAGE}" >/dev/null

for attempt in $(seq 1 30); do
  if docker exec "${SC_POSTGRES}" pg_isready --username supercollab_owner --dbname supercollab >/dev/null 2>&1; then
    break
  fi
  if [[ "${attempt}" == 30 ]]; then
    echo "isolated-e2e: PostgreSQL did not become ready" >&2
    exit 1
  fi
  sleep 1
done

SC_STAGE="schema"
docker exec "${SC_POSTGRES}" psql --username supercollab_owner --dbname supercollab \
  --set ON_ERROR_STOP=on --command "CREATE ROLE supercollab_app LOGIN PASSWORD '${SC_APP_PASSWORD}'" >/dev/null
docker exec --interactive "${SC_POSTGRES}" psql --username supercollab_owner --dbname supercollab \
  --set ON_ERROR_STOP=on < "${SC_ROOT}/server/sql/postgres_schema.sql" >/dev/null
docker exec --interactive "${SC_POSTGRES}" psql --username supercollab_owner --dbname supercollab \
  --set ON_ERROR_STOP=on < "${SC_ROOT}/server/sql/chat_schema.sql" >/dev/null

SC_STAGE="api-start"
docker run --detach --name "${SC_API}" \
  --network "${SC_NETWORK}" \
  --read-only \
  --tmpfs /tmp:size=64m,mode=1777 \
  --publish "127.0.0.1:${SC_PORT}:8731" \
  --env SUPERCOLLAB_PUBLIC_URL="${SC_SERVER}" \
  --env SUPERCOLLAB_PG_DSN="postgresql://supercollab_app:${SC_APP_PASSWORD}@${SC_POSTGRES}:5432/supercollab" \
  --env SUPERCOLLAB_AUTH_PEPPER="${SC_PEPPER}" \
  --env SUPERCOLLAB_ACCOUNT_SIGNUP=true \
  "${SC_IMAGE}" >/dev/null

curl --fail --silent --retry 30 --retry-delay 1 --retry-all-errors \
  "${SC_SERVER}/health" >/dev/null

SC_STAGE="key-account"
SC_AUTH_CONFIG="$(curl --fail --silent --show-error "${SC_SERVER}/v1/auth/config")"
SC_AUTH_CONFIG="${SC_AUTH_CONFIG}" node -e '
const config = JSON.parse(process.env.SC_AUTH_CONFIG);
if (config.mode !== "account_key" || config.signup_enabled !== true) process.exit(1);
if (config.account_key?.entropy_bits !== 256 || config.account_key?.generated_by_client !== true) process.exit(1);
for (const legacy of ["oidc", "provider", "password", "device_authorization_endpoint"]) {
  if (legacy in config) process.exit(1);
}
'

SC_SETUP_JSON="$("${SC_CLI[@]}" account create \
  --username alpha_e2e --label default-key \
  --config "${SC_CONFIG}" --server "${SC_SERVER}")"
SC_ACCOUNT_KEY="$(SC_CONFIG="${SC_CONFIG}" node -e '
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.env.SC_CONFIG, "utf8"));
if (!/^scak_[A-Za-z0-9_-]{43}$/.test(config.accountKey || "")) process.exit(1);
process.stdout.write(config.accountKey);
')"
if grep --fixed-strings --quiet "${SC_ACCOUNT_KEY}" <<< "${SC_SETUP_JSON}"; then
  echo "isolated-e2e: account key leaked in setup output" >&2
  exit 1
fi
SC_STORED_HASH="$(docker exec "${SC_POSTGRES}" psql --username supercollab_owner --dbname supercollab \
  --tuples-only --no-align --command "SELECT token_hash FROM sc.users WHERE username='alpha_e2e'" | tr -d '[:space:]')"
if ! [[ "${SC_STORED_HASH}" =~ ^[0-9a-f]{64}$ ]] || [[ "${SC_STORED_HASH}" == "${SC_ACCOUNT_KEY}" ]]; then
  echo "isolated-e2e: relay did not store a one-way account-key hash" >&2
  exit 1
fi

SC_STAGE="key-rotation"
SC_OLD_ACCOUNT_KEY="${SC_ACCOUNT_KEY}"
SC_ROTATE_JSON="$("${SC_CLI[@]}" account rotate-key --config "${SC_CONFIG}")"
SC_ACCOUNT_KEY="$(SC_CONFIG="${SC_CONFIG}" node -e '
const fs = require("node:fs");
process.stdout.write(JSON.parse(fs.readFileSync(process.env.SC_CONFIG, "utf8")).accountKey);
')"
if [[ "${SC_ACCOUNT_KEY}" == "${SC_OLD_ACCOUNT_KEY}" ]] || \
   grep --fixed-strings --quiet "${SC_OLD_ACCOUNT_KEY}" <<< "${SC_ROTATE_JSON}" || \
   grep --fixed-strings --quiet "${SC_ACCOUNT_KEY}" <<< "${SC_ROTATE_JSON}"; then
  echo "isolated-e2e: account-key rotation failed or exposed a key" >&2
  exit 1
fi
SC_OLD_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header "authorization: Bearer ${SC_OLD_ACCOUNT_KEY}" "${SC_SERVER}/v1/me")"
SC_NEW_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header "authorization: Bearer ${SC_ACCOUNT_KEY}" "${SC_SERVER}/v1/me")"
if [[ "${SC_OLD_STATUS}" != 401 || "${SC_NEW_STATUS}" != 200 ]]; then
  echo "isolated-e2e: rotated account-key acceptance was incorrect" >&2
  exit 1
fi

SC_STAGE="room"

SC_ROOM_JSON="$("${SC_CLI[@]}" room create \
  --title 'Isolated Alpha' --goal 'Exercise encrypted profile collaboration' \
  --config "${SC_CONFIG}")"
SC_ROOM_ID="$(SC_ROOM_JSON="${SC_ROOM_JSON}" node -e 'process.stdout.write(JSON.parse(process.env.SC_ROOM_JSON).room_id)')"
"${SC_CLI[@]}" activate --room "${SC_ROOM_ID}" --cwd "${SC_TEMP_DIR}" \
  --config "${SC_CONFIG}" >/dev/null

SC_STAGE="private-invite"
SC_INVITE_JSON="$("${SC_CLI[@]}" room invite --room "${SC_ROOM_ID}" --ttl 600 \
  --config "${SC_CONFIG}")"
SC_PRIVATE_INVITE="$(SC_INVITE_JSON="${SC_INVITE_JSON}" node -e 'process.stdout.write(JSON.parse(process.env.SC_INVITE_JSON).private_invite)')"
SC_INVITES_JSON="$("${SC_CLI[@]}" room invites --room "${SC_ROOM_ID}" --config "${SC_CONFIG}")"
SC_INVITES_JSON="${SC_INVITES_JSON}" node -e '
const data = JSON.parse(process.env.SC_INVITES_JSON);
if (!(data.invites || []).length) process.exit(1);
for (const invite of data.invites) {
  if ("token_hash" in invite || "invite_token" in invite || "private_invite" in invite) process.exit(1);
}
'

"${SC_CLI[@]}" account create --username beta_e2e --label beta-agent \
  --config "${SC_BETA_CONFIG}" --server "${SC_SERVER}" >/dev/null
SC_BETA_ACCOUNT_KEY="$(SC_BETA_CONFIG="${SC_BETA_CONFIG}" node -e '
const fs = require("node:fs");
process.stdout.write(JSON.parse(fs.readFileSync(process.env.SC_BETA_CONFIG, "utf8")).accountKey);
')"
if [[ "$(stat --format '%a' "${SC_CONFIG}")" != 600 || "$(stat --format '%a' "${SC_BETA_CONFIG}")" != 600 ]]; then
  echo "isolated-e2e: a local account config is not mode 600" >&2
  exit 1
fi
SC_BETA_ROOMS="$("${SC_CLI[@]}" room list --config "${SC_BETA_CONFIG}")"
SC_BETA_ROOMS="${SC_BETA_ROOMS}" node -e '
const data = JSON.parse(process.env.SC_BETA_ROOMS);
if ((data.rooms || []).length !== 0) process.exit(1);
'
SC_PREJOIN_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header "authorization: Bearer ${SC_BETA_ACCOUNT_KEY}" \
  "${SC_SERVER}/v1/rooms/${SC_ROOM_ID}")"
if [[ "${SC_PREJOIN_STATUS}" != 403 ]]; then
  echo "isolated-e2e: non-member could access a private room" >&2
  exit 1
fi
"${SC_CLI[@]}" room join --invite "${SC_PRIVATE_INVITE}" --config "${SC_BETA_CONFIG}" >/dev/null
if "${SC_CLI[@]}" room join --invite "${SC_PRIVATE_INVITE}" --config "${SC_BETA_CONFIG}" >/dev/null 2>&1; then
  echo "isolated-e2e: one-time invite was accepted twice" >&2
  exit 1
fi
SC_POSTJOIN_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header "authorization: Bearer ${SC_BETA_ACCOUNT_KEY}" \
  "${SC_SERVER}/v1/rooms/${SC_ROOM_ID}")"
if [[ "${SC_POSTJOIN_STATUS}" != 200 ]]; then
  echo "isolated-e2e: invited member could not access the private room" >&2
  exit 1
fi
"${SC_CLI[@]}" activate --room "${SC_ROOM_ID}" --cwd "${SC_TEMP_DIR}" \
  --config "${SC_BETA_CONFIG}" >/dev/null

SC_STAGE="profiles"
"${SC_CLI[@]}" profile create --name codex --label codex-alpha \
  --config "${SC_CONFIG}" >/dev/null
"${SC_CLI[@]}" profile create --name claude --label claude-alpha \
  --config "${SC_CONFIG}" >/dev/null

"${SC_CLI[@]}" room list --profile codex --config "${SC_CONFIG}" >/dev/null
"${SC_CLI[@]}" room list --profile claude --config "${SC_CONFIG}" >/dev/null
"${SC_CLI[@]}" mcp smoke --profile codex --config "${SC_CONFIG}" \
  --cwd "${SC_TEMP_DIR}" --timeout 10000 >/dev/null
"${SC_CLI[@]}" mcp smoke --profile claude --config "${SC_CONFIG}" \
  --cwd "${SC_TEMP_DIR}" --timeout 10000 >/dev/null

SC_STAGE="encrypted-message"
SC_MARKER="key-e2e-${SC_SUFFIX}"
SC_BETA_MARKER="beta-e2e-${SC_SUFFIX}"
"${SC_CLI[@]}" chat send --room "${SC_ROOM_ID}" --text "${SC_MARKER}" \
  --profile codex --config "${SC_CONFIG}" >/dev/null
SC_READ_JSON="$("${SC_CLI[@]}" chat read --room "${SC_ROOM_ID}" --limit 20 \
  --config "${SC_BETA_CONFIG}")"
SC_SEARCH_JSON="$("${SC_CLI[@]}" chat search --room "${SC_ROOM_ID}" --query "${SC_MARKER}" \
  --mode keyword --limit 5 --config "${SC_BETA_CONFIG}")"

SC_READ_JSON="${SC_READ_JSON}" SC_MARKER="${SC_MARKER}" node -e '
const data = JSON.parse(process.env.SC_READ_JSON);
if (!(data.messages || []).some((row) => row.body === process.env.SC_MARKER)) process.exit(1);
'
SC_SEARCH_JSON="${SC_SEARCH_JSON}" SC_MARKER="${SC_MARKER}" node -e '
const data = JSON.parse(process.env.SC_SEARCH_JSON);
if (!(data.results || []).some((row) => row.body === process.env.SC_MARKER)) process.exit(1);
'
"${SC_CLI[@]}" chat send --room "${SC_ROOM_ID}" --text "${SC_BETA_MARKER}" \
  --config "${SC_BETA_CONFIG}" >/dev/null
SC_ALPHA_READ="$("${SC_CLI[@]}" chat read --room "${SC_ROOM_ID}" --limit 20 \
  --profile claude --config "${SC_CONFIG}")"
SC_ALPHA_READ="${SC_ALPHA_READ}" SC_BETA_MARKER="${SC_BETA_MARKER}" node -e '
const data = JSON.parse(process.env.SC_ALPHA_READ);
if (!(data.messages || []).some((row) => row.body === process.env.SC_BETA_MARKER)) process.exit(1);
'

SC_STAGE="privacy-and-skill"
SC_PLAINTEXT_ROWS="$(docker exec "${SC_POSTGRES}" psql --username supercollab_owner --dbname supercollab \
  --tuples-only --no-align --command "SELECT count(*) FROM chat.messages WHERE body LIKE '%${SC_MARKER}%' OR body LIKE '%${SC_BETA_MARKER}%' OR metadata::text LIKE '%${SC_MARKER}%' OR metadata::text LIKE '%${SC_BETA_MARKER}%'" | tr -d '[:space:]')"
if [[ "${SC_PLAINTEXT_ROWS}" != 0 ]]; then
  echo "isolated-e2e: plaintext marker reached PostgreSQL" >&2
  exit 1
fi

SC_PLAINTEXT_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST --header 'content-type: application/json' \
  --header "authorization: Bearer ${SC_ACCOUNT_KEY}" \
  --data "{\"body\":\"${SC_MARKER}\",\"metadata\":{\"encrypted\":true,\"private\":true,\"alg\":\"A256GCM\",\"local_search\":true}}" \
  "${SC_SERVER}/v1/rooms/${SC_ROOM_ID}/messages")"
if [[ "${SC_PLAINTEXT_STATUS}" != 400 ]]; then
  echo "isolated-e2e: relay did not reject a plaintext message body" >&2
  exit 1
fi

SC_HEALTH="$(curl --fail --silent --show-error "${SC_SERVER}/health")"
SC_HEALTH="${SC_HEALTH}" node -e '
const health = JSON.parse(process.env.SC_HEALTH);
for (const key of ["users", "rooms", "messages"]) if (key in health) process.exit(1);
if (health.database !== "ready") process.exit(1);
'
SC_SKILL="$(curl --fail --silent --show-error --location --retry 5 --retry-delay 1 --retry-all-errors \
  "${SC_SERVER}/skill.md")"
grep --quiet '^name: connect-supercollab$' <<< "${SC_SKILL}"
grep --fixed-strings --quiet '@supercollab/mcp@0.7.0-alpha.4' <<< "${SC_SKILL}"
if grep --fixed-strings --quiet '@supercollab/cli' <<< "${SC_SKILL}"; then
  echo "isolated-e2e: hosted skill still exposes the retired CLI package" >&2
  exit 1
fi

SC_HOME_HEADERS="$(curl --fail --silent --show-error --dump-header - --output /dev/null "${SC_SERVER}/")"
grep --ignore-case --quiet '^content-security-policy:' <<< "${SC_HOME_HEADERS}"
grep --ignore-case --quiet '^x-frame-options: DENY' <<< "${SC_HOME_HEADERS}"
grep --ignore-case --quiet '^x-content-type-options: nosniff' <<< "${SC_HOME_HEADERS}"

SC_AGENT_CATALOG="$(curl --fail --silent --show-error "${SC_SERVER}/assets/agents.json")"
SC_AGENT_CATALOG="${SC_AGENT_CATALOG}" node -e '
const catalog = JSON.parse(process.env.SC_AGENT_CATALOG);
if (catalog.runtime?.package !== "@supercollab/mcp" || catalog.runtime?.version !== "0.7.0-alpha.4") process.exit(1);
const core = (catalog.agents || []).filter((agent) => agent.featured);
if (core.length !== 6 || core.filter((agent) => agent.verification === "verified").length !== 2) process.exit(1);
'

SC_STAGE="revocation"
SC_AGENTS_JSON="$("${SC_CLI[@]}" agent list --config "${SC_CONFIG}")"
SC_AGENT_COUNT="$(SC_AGENTS_JSON="${SC_AGENTS_JSON}" node -e 'process.stdout.write(String(JSON.parse(process.env.SC_AGENTS_JSON).agents.length))')"
if [[ "${SC_AGENT_COUNT}" != 3 ]]; then
  echo "isolated-e2e: expected three independently registered agents" >&2
  exit 1
fi

"${SC_CLI[@]}" profile revoke --name codex --config "${SC_CONFIG}" >/dev/null
if "${SC_CLI[@]}" mcp smoke --profile codex --config "${SC_CONFIG}" \
  --cwd "${SC_TEMP_DIR}" --timeout 10000 >/dev/null 2>&1; then
  echo "isolated-e2e: revoked local profile remained usable" >&2
  exit 1
fi

SC_REVOKED_SESSIONS="$(docker exec "${SC_POSTGRES}" psql --username supercollab_owner --dbname supercollab \
  --tuples-only --no-align --command "SELECT count(*) FROM sc.agent_sessions s JOIN sc.agents a ON a.id=s.agent_id WHERE a.label='codex-alpha' AND a.revoked=true AND s.revoked_at IS NOT NULL" | tr -d '[:space:]')"
if [[ "${SC_REVOKED_SESSIONS}" -lt 1 ]]; then
  echo "isolated-e2e: server did not revoke the Codex agent session" >&2
  exit 1
fi

SC_STAGE="complete"
printf '{"ok":true,"key_auth":true,"key_rotation":true,"accounts_registered":2,"config_modes":"600,600","room_id":"%s","member_only":true,"private_invite":true,"invite_replay_rejected":true,"profiles_registered":3,"profiles_revoked":1,"plaintext_rows":0,"plaintext_submission_rejected":true,"skill_route":true,"security_headers":true,"compatibility_catalog":true}\n' "${SC_ROOM_ID}"
