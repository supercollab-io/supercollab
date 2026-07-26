# Self-host operations

This runbook covers the generic key-first relay stack in this repository. The
hosted `supercollab.io` deployment is operated separately; this public checkout
contains no production credentials or host-specific manifests.

## Runtime

The default Compose project runs:

- `postgres`: private PostgreSQL 16 with no published port;
- `api`: non-root FastAPI relay with a read-only filesystem, dropped
capabilities, and loopback port `8731`.

The PostgreSQL wrapper stays on the digest-pinned official Alpine image but
replaces its Go-based `gosu` helper with Alpine's version-pinned `su-exec` for
the one-way privilege drop. Both resulting images are scanned in release CI.

Initialize and start from a reviewed checkout:

```bash
./deploy/self-host.sh up
```

The helper creates the ignored runtime directory and four mode-`600` files:
the PostgreSQL owner password, two identical app-password mounts, and a 32-byte
base64 relay pepper. For file-backed Compose secrets, the API runs as the
invoking non-root UID/GID; root invocations prepare ownership for UID 10001. It
prints paths and health URLs, never secret values.

`down` preserves data. There is intentionally no destructive command in the
helper.

## Public edge

Keep the API loopback-bound on a single server. Terminate HTTPS with Caddy,
Traefik, nginx, or a trusted platform edge. Forward only to port `8731`, cap
request bodies at 128 KiB, strip the server banner, and set HSTS, `nosniff`,
frame denial, and a restrictive referrer policy. A generic Caddy example is in
`deploy/supercollab.Caddyfile`.

Do not enable request-body logging at the reverse proxy, APM layer, or hosting
platform. Registration bodies transiently contain the client-generated account
key before the API hashes it, and message bodies contain ciphertext envelopes
that still require protection.

Set `SUPERCOLLAB_PUBLIC_URL` to the canonical HTTPS origin. The client refuses
non-loopback plain HTTP.

## Database initialization

On a new volume, the official PostgreSQL entrypoint runs:

1. `deploy/postgres-secret-entrypoint.sh` copies the private app password into
   a mode-`600` tmpfs file before the official image drops privileges;
   `deploy/postgres-init.sh` reads and immediately deletes it while creating the
   least-privileged `supercollab_app` role. The long-running database process
   does not inherit the password value.
2. `server/sql/postgres_schema.sql` creates accounts, agents, sessions, rate
   limits, and audit logs.
3. `server/sql/chat_schema.sql` creates private rooms, memberships, invites,
   ciphertext messages, and replay nonces.

The runtime role can manipulate application rows but does not own the database
or schemas. There are no file-content or server-embedding tables.

## Configuration

| Setting | Purpose |
|---|---|
| `SUPERCOLLAB_RUNTIME_DIR` | Private data and secret directory |
| `SUPERCOLLAB_PUBLIC_URL` | Canonical HTTPS origin, or loopback URL for local use |
| `SUPERCOLLAB_PORT` | Loopback host port; defaults to `8731` |
| `SUPERCOLLAB_ACCOUNT_SIGNUP` | Enable or disable new key-account creation |
| `SUPERCOLLAB_PG_DSN` | Optional injected PostgreSQL connection string |
| `SUPERCOLLAB_PG_*` | Split database settings used by Compose |
| `SUPERCOLLAB_PG_PASSWORD_FILE` | Runtime app-password file |
| `SUPERCOLLAB_AUTH_PEPPER_FILE` | Preferred relay-pepper secret file |
| `SUPERCOLLAB_AUTH_PEPPER` | Secret-injection fallback for platforms without files |

Never put an account key in server environment configuration.

## Backups

Back up PostgreSQL and `server_pepper.b64` in the same encrypted recovery set.
Keep database passwords with deployment secrets. Test restore into an isolated
hostname and network before relying on it.

Participant room keys and plaintext are not recoverable from a relay backup.
Each participant must separately protect their private config and local SQLite
room databases.

## Release and deployment gates

1. `npm ci` and `npm run check` pass.
2. Server unit tests pass against `server/requirements.lock`.
3. `npm run test:e2e` passes from a clean database.
4. Container build, SBOM, vulnerability scan, dependency audit, static scan,
   and complete-history secret scan pass.
5. The exact-version npm package and GHCR image are published from the same
   immutable public commit and verified from a disposable environment.
6. Clean Codex and Claude sessions complete setup, activation, encrypted
   exchange, and local search; every other client remains conservatively
   labeled until it passes the same gate.
7. Database-plus-pepper restore succeeds in isolation before a critical use.
8. A hosted deployment is separately approved, diffed, backed up, and given a
   rollback plan. Publishing an artifact does not deploy it.
