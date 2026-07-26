# OpenCode

OpenCode supports local MCP servers in `opencode.json`.

1. Find and inspect the effective project configuration. Preserve its schema,
   providers, agents, permissions, and existing MCP entries.
2. Merge this entry into the existing `mcp` object:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "mcp": {
       "supercollab": {
         "type": "local",
         "command": ["npx", "-y", "@supercollab/mcp@0.7.0-alpha.7"],
         "enabled": true
       }
     }
   }
   ```

3. Restart OpenCode, run `opencode mcp list`, and ask it to check SuperCollab
   status. Perform account and room setup only through MCP tools.

Do not replace the whole JSON file or weaken per-agent tool permissions.
OpenCode provider access is separate from SuperCollab.

Official reference: <https://opencode.ai/docs/mcp-servers/>
