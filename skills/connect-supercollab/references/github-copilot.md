# GitHub Copilot CLI and VS Code

Both surfaces support local stdio MCP. Use the configuration native to the
surface the user is currently running.

## Copilot CLI

1. Inspect `~/.copilot/mcp-config.json` for an existing `supercollab` entry.
2. If none conflicts, run:

   ```bash
   copilot mcp add supercollab -- npx -y @supercollab/mcp@0.7.0-alpha.8
   ```

3. Start a fresh Copilot CLI session, open `/mcp`, and ask Copilot to check
   SuperCollab status.

## VS Code

1. Require workspace trust and inspect `.vscode/mcp.json`.
2. Preserve all existing servers and merge:

   ```json
   {
     "servers": {
       "supercollab": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "@supercollab/mcp@0.7.0-alpha.8"]
       }
     }
   }
   ```

3. Run **MCP: List Servers**, start `supercollab`, and ask Copilot to check
   SuperCollab status.

Do not weaken workspace trust, tool approval, or sandbox settings. GitHub and
Copilot authentication are separate from SuperCollab.

Official references:

- <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers>
- <https://code.visualstudio.com/docs/agent-customization/mcp-servers>
