# Security boundaries

## Account and agent credentials

- Generate account keys locally with 256 bits of cryptographic randomness and the `scak_` prefix.
- Send an account key only to the configured relay over HTTPS, except for loopback HTTP during local self-host testing.
- The relay stores only an HMAC-SHA256 digest made with an operator-held pepper. It never stores or returns the raw account key.
- Keep account keys and Ed25519 private keys in the private SuperCollab config, never in Codex TOML, Claude JSON, a skill, command output, or model context.
- Daily agent requests use short-lived sessions obtained with an Ed25519 signature. The long-lived account key is reserved for account and agent management.
- Rotation must preserve a crash-recoverable pending state locally and invalidate the old key when complete.
- There is no hosted identity recovery or secret escrow. Losing every private config loses account access; disclose that plainly.

## End-to-end encryption

- Encrypt message plaintext locally with a unique AES-256-GCM nonce before upload.
- Keep room keys, decrypted transcripts, embeddings, and search indexes local.
- The relay may see identities, memberships, IP addresses, timestamps, ciphertext sizes, agent public keys, and operational audit metadata. Never claim those are hidden.
- Do not convert chat tools into a remote HTTP MCP: that would expose plaintext tool arguments to the hosted MCP process.

## Activation and disclosure control

- Installation and account creation do not activate any folder.
- Folder activation is a local routing rule only. SuperCollab must not enumerate, read, watch, index, or upload project files.
- `manual` is the default sharing mode. Reject MCP sends without `confirmed_by_user: true` in that mode.
- `progress` mode permits newly authored summaries, not raw conversation forwarding or file contents.
- Off means no send, read, sync, or search for that folder.
- Local embeddings are computed only over decrypted messages in the selected room database.

## Rooms and invitations

- List only rooms where the authenticated account is already a member. Do not provide public room or username discovery.
- Treat the combined invite token and room key as a credential. Use short expirations and an approved secure channel.
- Revoking a member cannot erase plaintext or keys already received by that member. Future member removal requires room-key rotation before claiming future secrecy.

## Self-hosting

- Bind a development relay to loopback. Use HTTPS termination before any non-loopback exposure.
- Run the API as a non-root, read-only container with dropped capabilities and a least-privileged PostgreSQL role.
- Keep the PostgreSQL owner password, app password, and relay HMAC pepper distinct and mode `600`.
- Back up PostgreSQL and the server pepper together. A database backup without its pepper cannot validate account keys; a leaked database plus pepper enables offline key guesses, though 256-bit random keys remain infeasible to brute-force.
