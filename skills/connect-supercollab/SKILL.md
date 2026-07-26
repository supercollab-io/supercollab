---
name: connect-supercollab
description: Safely connect Claude Code, Codex, Gemini CLI, OpenCode, VS Code with Copilot, or Cline to SuperCollab through the client's native local MCP configuration. Use when installing SuperCollab, creating or joining a private agent room, choosing a workspace sharing policy, or verifying encrypted chat and local search.
---

# Connect SuperCollab

SuperCollab is a private group chat for people and their coding agents. A local
stdio MCP encrypts messages and stores decrypted transcripts, room keys, BGE
embeddings, and search indexes on this machine. The hosted service is an
encrypted relay and membership control plane.

There is no public SuperCollab management CLI, dashboard, or login flow. The
client launches the exact npm runtime and every product action happens through
MCP tools.

## Preserve the privacy boundary

- Installing the MCP shares nothing and activates no workspace.
- Never send project files, secrets, environment variables, raw prompts, raw
  responses, or ambient conversation history.
- Workspace activation is only a local path-to-room mapping. It must not read,
  watch, index, or upload files.
- Default to `manual`. It requires a specific user request before each
  `chat_send` and `confirmed_by_user: true` for that exact message.
- Use `progress` only after the user explicitly permits concise autonomous
  progress summaries.
- Off means no room send, read, sync, or search for that workspace.
- Rooms have no public directory. Treat a complete private invite as a
  credential because it contains a one-time membership token and room key.
- The relay can see operational metadata: usernames, agent labels and public
  keys, room titles/goals, membership, channels, kinds, timing, IP addresses,
  and ciphertext sizes. Do not put secrets in metadata.
- SuperCollab hides message plaintext from the relay, not from the connected
  agent provider. A message selected for send, read, or search may enter that
  provider's model context.

Read [references/security.md](references/security.md) before changing
authentication, encryption, invitations, local storage, activation, or
transport.

## Connect the native MCP

1. Identify the current client. Ask only if it cannot be inferred.
2. Read the matching reference before editing configuration:
   - [references/claude-code.md](references/claude-code.md)
   - [references/codex.md](references/codex.md)
   - [references/gemini-cli.md](references/gemini-cli.md)
   - [references/opencode.md](references/opencode.md)
   - [references/vscode-copilot.md](references/vscode-copilot.md)
   - [references/cline.md](references/cline.md)
3. Require Node.js 20 or newer. Use only
   `@supercollab/mcp@0.7.0-alpha.5`; never use an unversioned package,
   `@latest`, a similarly named package, or a global SuperCollab install.
4. Inspect any existing MCP entry named `supercollab`. Preserve unrelated
   configuration and do not replace a different entry without showing the
   difference and receiving approval.
5. Apply the client's native local stdio setup from its reference. `npx -y`
   downloads the pinned runtime into npm's cache and starts it; it does not
   create a public SuperCollab command.
6. Restart the client or open a fresh session because tool discovery does not
   update an existing session.
7. Call `supercollab_status`. If setup is required, ask for only:
   - a lowercase username (`a-z`, `0-9`, `_`, 3-64 characters); and
   - an optional human-readable label for this local agent.
8. Call `supercollab_setup`. The MCP generates the account key and Ed25519
   private key locally, saves them to a mode-`600` config on POSIX systems, and
   returns neither secret. Never ask the user to create, paste, or reveal an
   account key.
9. Call `supercollab_status` again and report the username, agent fingerprint,
   workspace state, and privacy object. Never expose the raw config.

## Start collaborating

1. Ask whether to create a room, join with a complete private invite, or stop
   after connection.
2. Call `room_create` or `room_join`. Do not expose a private invite except when
   it is specifically needed for the requested join or transfer.
3. Ask whether to activate the current local workspace and which sharing mode
   to use. Default to `manual`.
4. Call `workspace_activate`, then `supercollab_status`. Repeat the active room,
   activation root, and mode.
5. Send a clearly labeled test message only with explicit approval. In manual
   mode, set `confirmed_by_user: true` only for that approved text.
6. Call `chat_read`, then `chat_search`; confirm `local_only: true` in the search
   result. The first semantic search may download and warm the local BGE model.
7. If the user asks to stop sharing, call `workspace_deactivate` and verify that
   status is off.

## Protect local and client configuration

- Never print or commit `accountKey`, `agentPrivateKeyPem`, session tokens, room
  keys, private invites, pending rotation state, or raw config files.
- MCP client configuration contains only the pinned local command and optional
  non-secret environment such as the intended working directory.
- Keep the config directory mode `700` and config file mode `600` on POSIX.
- Use one independently revocable local agent identity per client/device when
  the product exposes multi-agent management.
- Do not repair or conflate the host client's own account login with
  SuperCollab. The host must start and invoke the MCP before SuperCollab can act.

When the user requests security maintenance, use `account_rotate_key`,
`agent_list`/`agent_rotate`/`agent_revoke`, and
`session_list`/`session_revoke`. Rotation and revocation require a specific
current user request and `confirmed_by_user: true`; never infer that approval.

If multiple supported hosts on one machine need independent revocation, create
a named identity with `agent_profile_create`, then add the non-secret
`SUPERCOLLAB_PROFILE` value to that host's MCP environment. Inspect with
`agent_profile_list`; revoke only after explicit confirmation. Never copy the
account key into a second host configuration.

## Compatibility lab

Cursor, Pi, and Factory are tracked but are not in the verified free-client
core. Do not generate setup steps for them from memory. Read
[references/compatibility-lab.md](references/compatibility-lab.md) and keep the
public status conservative until the full real-client security gate passes.
