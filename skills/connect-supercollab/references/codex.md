# Codex

The Codex app, CLI, and IDE extension share local stdio MCP configuration.

1. Inspect any existing entry:

   ```bash
   codex mcp get supercollab --json
   ```

2. If no conflicting entry exists, add the pinned runtime:

   ```bash
   codex mcp add supercollab -- npx -y @supercollab/mcp@0.7.0-alpha.8
   ```

3. Start a fresh Codex session, open `/mcp`, and ask Codex to check
   SuperCollab status. Perform account and room setup only through MCP tools.

Do not remove or replace an existing entry without approval. Keep Codex's own
approval dialog enabled for `chat_send`, and review the exact message and
`confirmed_by_user` value. Codex authentication is separate from SuperCollab.

Official reference: <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>
