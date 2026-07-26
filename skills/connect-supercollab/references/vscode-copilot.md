# VS Code with GitHub Copilot

VS Code agent mode supports native MCP through `.vscode/mcp.json`.

1. Require workspace trust and inspect an existing `.vscode/mcp.json`. Preserve
   all other servers and inputs.
2. Merge this entry into the existing `servers` object:

   ```json
   {
     "servers": {
       "supercollab": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "@supercollab/mcp@0.7.0-alpha.4"]
       }
     }
   }
   ```

3. Run **MCP: List Servers**, start `supercollab`, then ask Copilot to check
   SuperCollab status. Perform account and room setup only through MCP tools.

Do not weaken workspace trust, tool approval, or sandbox settings. This recipe
is configuration-ready, not real-client verified, until the complete encrypted
exchange gate passes.

Official reference: <https://code.visualstudio.com/docs/agent-customization/mcp-servers>
