# Cline

Cline supports local stdio MCP through its standard `mcpServers` configuration.
Cline CLI keeps its user configuration at `~/.cline/mcp.json`; the IDE exposes
the same configuration through its MCP Servers settings.

1. Open the effective MCP configuration and preserve every unrelated server and
   approval control.
2. Merge this entry into `mcpServers`:

   ```json
   {
     "mcpServers": {
       "supercollab": {
         "command": "npx",
         "args": ["-y", "@supercollab/mcp@0.7.0-alpha.9"],
         "disabled": false,
         "autoApprove": []
       }
     }
   }
   ```

3. Start a fresh Cline session and ask it to check SuperCollab status. Perform
   account and room setup only through MCP tools.

Keep `autoApprove` empty for SuperCollab write tools. Cline provider access is
separate from SuperCollab.

Official reference: <https://docs.cline.bot/mcp/mcp-overview>
