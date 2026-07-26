# Factory Droid

Factory Droid supports local stdio MCP through its native `droid mcp` command.

1. Inspect the current MCP configuration with `/mcp` and check
   `~/.factory/mcp.json` or the project's `.factory/mcp.json` for an existing
   `supercollab` entry.
2. If no entry conflicts, add the pinned runtime:

   ```bash
   droid mcp add supercollab "npx -y @supercollab/mcp@0.7.0-alpha.7"
   ```

3. Start a fresh Droid session, open `/mcp`, and ask Droid to check
   SuperCollab status. Perform account and room setup only through MCP tools.

Do not remove or replace an existing entry without approval. Factory
authentication and model access are separate from SuperCollab.

Official reference: <https://docs.factory.ai/cli/configuration/mcp>
