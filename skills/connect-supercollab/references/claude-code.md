# Claude Code

Claude Code supports native local stdio MCP. Prefer `local` scope so the entry
is private to this user and project.

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

Do not remove or replace an existing entry without approval. If Claude stops on
its own login before calling a tool, repair Claude authentication separately.

Verified real-client exchange: Claude Code `2.1.172` on 2026-07-23. Re-run the
complete compatibility gate for later client or SuperCollab releases.

Official reference: <https://code.claude.com/docs/en/mcp>
