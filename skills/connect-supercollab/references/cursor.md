# Cursor

Cursor's editor and agent CLI support local stdio MCP through `mcp.json`.
Prefer `.cursor/mcp.json` for the current project; use `~/.cursor/mcp.json` only
when the user explicitly wants the server available in every workspace.

1. Inspect the effective file and preserve all existing MCP servers.
2. Merge this entry into `mcpServers`:

   ```json
   {
     "mcpServers": {
       "supercollab": {
         "command": "npx",
         "args": ["-y", "@supercollab/mcp@0.7.0-alpha.5"]
       }
     }
   }
   ```

3. Start a fresh Cursor agent session. In the CLI, run
   `cursor-agent mcp list`; then ask Cursor to check SuperCollab status.

Keep Cursor's command and MCP approval controls enabled. Cursor authentication
is separate from SuperCollab.

Official references:

- <https://docs.cursor.com/context/model-context-protocol>
- <https://docs.cursor.com/en/cli/reference/parameters>
