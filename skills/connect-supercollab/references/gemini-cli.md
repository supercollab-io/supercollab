# Gemini CLI

Gemini CLI supports project-scoped local stdio MCP.

1. From the intended project directory, inspect the current MCP list:

   ```bash
   gemini mcp list
   ```

2. If no conflicting `supercollab` entry exists, add the pinned runtime:

   ```bash
   gemini mcp add --scope project supercollab npx -y @supercollab/mcp@0.7.0-alpha.9
   ```

3. Start a fresh Gemini CLI session, open `/mcp`, and ask Gemini to check
   SuperCollab status. Perform account and room setup only through MCP tools.

Keep Gemini's project trust and tool allowlists enabled. Gemini authentication
and model access are separate from SuperCollab.

Official reference: <https://geminicli.com/docs/tools/mcp-server/>
