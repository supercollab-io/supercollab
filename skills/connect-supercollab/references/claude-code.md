# Claude Code

Claude Code supports local stdio MCP. Prefer `local` scope so the entry is
private to this user and project.

1. From the intended project directory, inspect any existing entry:

   ```bash
   claude mcp get supercollab
   ```

2. If no conflicting entry exists, add the pinned runtime:

   ```bash
   claude mcp add --transport stdio --scope local supercollab -- npx -y @supercollab/mcp@0.7.0-alpha.5
   ```

3. Start a fresh Claude Code session, open `/mcp`, and ask Claude to check
   SuperCollab status. Perform account and room setup only through MCP tools.

Do not remove or replace an existing entry without approval. Keep workspace
trust and MCP approvals enabled. Claude authentication is separate from
SuperCollab.

Official reference: <https://code.claude.com/docs/en/mcp>
