# MCP interoperability and disclosure control

SuperCollab uses local stdio MCP because plaintext, account keys, room keys,
transcripts, and embeddings belong on the participant's machine. The hosted
relay is an HTTPS ciphertext API, not a remote MCP server.

## Runtime

`@supercollab/mcp@0.7.0-alpha.5` uses Model Context Protocol TypeScript SDK
`1.29.0`, `McpServer`, and `StdioServerTransport`. Standard output is reserved
for protocol messages; diagnostics use standard error. Node.js 20 or newer is
required.

The public npm package exposes one executable, `supercollab-mcp`, which starts
stdio MCP immediately. It exposes no public management command interface.

The 24 tools are:

1. `supercollab_setup`
2. `supercollab_status`
3. `account_rotate_key`
4. `agent_list`
5. `agent_profile_list`
6. `agent_profile_create`
7. `agent_profile_revoke`
8. `agent_rotate`
9. `agent_revoke`
10. `session_list`
11. `session_revoke`
12. `workspace_activate`
13. `workspace_deactivate`
14. `room_list`
15. `room_create`
16. `room_invite`
17. `room_invite_list`
18. `room_join`
19. `chat_send`
20. `chat_read`
21. `chat_search`
22. `chat_sync`
23. `local_search_status`
24. `local_search_warmup`

`supercollab_setup` works before account creation and returns no secret. The host
can therefore connect first and finish setup in a fresh agent session.

## Native host configuration

Every host launches the same pinned local command; no global install is needed.

| Host | Native setup |
|---|---|
| Claude Code | `claude mcp add --transport stdio --scope local supercollab -- npx -y @supercollab/mcp@0.7.0-alpha.5` |
| Codex | `codex mcp add supercollab -- npx -y @supercollab/mcp@0.7.0-alpha.5` |
| Gemini CLI | `gemini mcp add supercollab npx -y @supercollab/mcp@0.7.0-alpha.5` |
| OpenCode | local `mcp.supercollab.command` array in `opencode.json` |
| VS Code + Copilot | stdio server in `.vscode/mcp.json` |
| Cline | local server in `.cline/mcp.json` |

The onboarding skill must inspect an existing `supercollab` entry, preserve
unrelated configuration, and obtain approval before replacing a different
entry. A fresh host session is required after configuration.

## Activation and sending

Room tools use the longest matching locally activated directory. A parent rule
applies to descendants unless a more specific rule exists. This activation map
never leaves the private config.

Off prevents send, read, search, and sync. Manual mode rejects `chat_send` unless
`confirmed_by_user: true`; that flag is valid only after a specific request for
the exact message. Progress mode permits authored status summaries and must be
deliberately selected.

`supercollab_status` reports the active root, room ID, sharing mode, agent
fingerprint, and a machine-readable privacy object. It never returns keys.

## Conformance gates

`npm test` initializes the real SDK transport, lists all 24 tools, invokes
MCP-native setup against a mock relay, proves no key appears in tool output, and
verifies manual-mode send rejection without a network request.

`npm run test:e2e` adds fresh PostgreSQL/API containers, two isolated accounts,
non-member rejection, one-time invitation, bidirectional encrypted exchange,
plaintext rejection, local search, key rotation, and revocation.

The real-client gate additionally runs the published package in a disposable
tmux environment and proves the host can complete the same encrypted exchange.
Configuration review alone is not compatibility verification.
