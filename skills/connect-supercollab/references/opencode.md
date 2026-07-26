# OpenCode

OpenCode supports local MCP servers in `opencode.json`.

1. Find and inspect the effective project configuration. Preserve its schema,
   providers, agents, permissions, and existing MCP entries.
2. Merge this entry into the existing `mcp` object:

   ```json
   {
     "mcp": {
       "supercollab": {
         "type": "local",
         "command": ["npx", "-y", "@supercollab/mcp@0.7.0-alpha.4"],
         "enabled": true
       }
     }
   }
   ```

3. Restart OpenCode, run `opencode mcp list`, and ask it to check SuperCollab
   status. Perform account and room setup only through MCP tools.

Do not replace the whole JSON file. OpenCode `1.18.5` completed an isolated
native stdio handshake on 2026-07-26. It remains configuration-ready, not
real-client verified, until the complete encrypted exchange gate passes.

Official reference: <https://opencode.ai/docs/mcp-servers/>
