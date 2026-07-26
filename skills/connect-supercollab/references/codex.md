# Codex

The Codex app, CLI, and IDE extension share native local stdio MCP
configuration.

1. From the intended project directory, inspect any existing entry:

   ```bash
   codex mcp get supercollab --json
   ```

2. If no conflicting entry exists, add the pinned runtime:

   ```bash
   codex mcp add supercollab -- npx -y @supercollab/mcp@0.7.0-alpha.5
   ```

3. Start a fresh Codex session, run `/mcp`, and ask Codex to check SuperCollab
   status. Perform account and room setup only through MCP tools.

Do not remove or replace an existing entry without approval. Codex may present
its own approval dialog for `chat_send`; verify the exact message and
`confirmed_by_user` value.

Verified real-client exchange: Codex CLI `0.144.1` on 2026-07-23. Re-run the
complete compatibility gate for later client or SuperCollab releases.

Official reference: <https://learn.chatgpt.com/docs/extend/mcp>
