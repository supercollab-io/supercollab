---
name: self-host-supercollab
description: Safely deploy or verify a private SuperCollab relay with Docker Compose and PostgreSQL, configure HTTPS and backups, then connect a supported agent through the pinned local MCP runtime without weakening the end-to-end-encryption boundary.
---

# Self-host SuperCollab

Deploy the same ciphertext-only relay used by the hosted product. The small default stack contains two services: the non-root SuperCollab API and plain PostgreSQL. Embeddings, decrypted transcripts, room keys, and project files are not server features and remain on each participant's machine.

## Safety contract

- Obtain approval before installing Docker, opening firewall ports, changing DNS, starting paid infrastructure, or replacing an existing service.
- Never expose the relay over non-loopback plain HTTP. Use HTTPS at the reverse proxy or platform edge.
- Never print generated database passwords, the HMAC pepper, account keys, room keys, private invitations, or raw config files.
- Never add server-side file sync, project indexing, plaintext search, or key escrow.
- Do not claim that relay metadata such as membership, timing, IP addresses, or ciphertext size is end-to-end encrypted.
- Self-hosting removes the hosted relay from the trust boundary, but the connected agent provider still processes messages selected for send/read/search under that provider's policy.

## Fast local or single-server setup

1. Require Docker Engine with Compose v2, `openssl`, and `curl`. Confirm the checkout is the intended SuperCollab repository.
2. Review `deploy/compose.yaml` and `deploy/self-host.sh`. The script uses the isolated Compose project `supercollab-selfhost`, generates separate mode-`600` secrets under an ignored runtime directory, and does not delete volumes.
3. Start a loopback-only relay:

   ```bash
   git clone https://github.com/supercollab-io/supercollab.git
   cd supercollab
   ./deploy/self-host.sh up
   ```

4. Verify:

   ```bash
   curl --fail http://127.0.0.1:8731/health
   curl --fail http://127.0.0.1:8731/v1/auth/config
   ```

   Require `database: ready`, `mode: account_key`, client-generated 256-bit keys, and signup in the expected state.
5. For a public or organizational hostname, put Caddy, Traefik, nginx, or the hosting platform's TLS edge in front of `127.0.0.1:8731`. Set `SUPERCOLLAB_PUBLIC_URL=https://collab.example.com` and restart the stack. Keep PostgreSQL private.
6. From a client machine, follow the hosted connection skill and add the
   non-secret relay origin to the host's MCP environment. For Codex, for example:

   ```bash
   codex mcp add --env SUPERCOLLAB_URL=https://collab.example.com supercollab -- npx -y @supercollab/mcp@0.7.0-alpha.4
   ```

   For Claude Code, use `-e SUPERCOLLAB_URL=https://collab.example.com` in its
   native `claude mcp add` command. For JSON-configured hosts, put
   `SUPERCOLLAB_URL` in that server entry's environment object. Then start a
   fresh agent session and call `supercollab_setup`; do not create or expose an
   account key manually.

## Container registry and managed PostgreSQL

- Tagged builds publish the relay image through `.github/workflows/container.yml` to GitHub Container Registry. Pin a release tag or digest in production; do not deploy `latest` implicitly.
- The API accepts either `SUPERCOLLAB_PG_DSN` or the split least-privileged PostgreSQL settings used by Compose.
- The API accepts the relay pepper through `SUPERCOLLAB_AUTH_PEPPER_FILE`; `SUPERCOLLAB_AUTH_PEPPER` is available for secret-injection platforms that cannot mount files.
- Initialize a new database with `server/sql/postgres_schema.sql` followed by `server/sql/chat_schema.sql` as the database owner. The runtime API role must not own schemas.
- Any platform that runs an OCI image and provides private PostgreSQL can host the relay. Platform-specific templates should only wire these documented inputs; they must not change the encryption boundary.

## Backups and recovery

- Back up the PostgreSQL volume and the server pepper as one recovery set. Test restoring both into an isolated relay.
- Backups contain usernames, memberships, audit metadata, public agent keys, and ciphertext. Protect them accordingly.
- Each participant separately backs up their private local SuperCollab config and local transcript database. The relay cannot reconstruct room keys or plaintext.
- There is no account recovery escrow. If a user loses every copy of their account key, they create a new account and receive a new room invite.

## Verification before use

1. Confirm the API container is non-root, read-only, capability-dropped, and listening only where intended.
2. Confirm PostgreSQL is not publicly published.
3. Confirm `/v1/auth/config` reports key auth and no password/OIDC provider configuration.
4. Create two disposable accounts and a private room, rotate one account key, exchange one encrypted marker, and prove the marker does not appear in PostgreSQL.
5. Confirm the MCP reports manual sharing by default and rejects an unapproved `chat_send`.
6. Run `npm test` and `npm run test:e2e` from the exact release checkout.
