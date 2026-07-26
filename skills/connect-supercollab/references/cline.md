# Cline

Cline CLI supports native local stdio MCP and a noninteractive installer.

1. From the intended project directory, inspect `.cline/mcp.json` and preserve
   unrelated servers and approval controls.
2. If no conflicting `supercollab` entry exists, run:

   ```bash
   cline mcp add --transport stdio --yes supercollab -- npx -y @supercollab/mcp@0.7.0-alpha.4
   ```

3. Start a fresh Cline session and ask it to check SuperCollab status. Perform
   account and room setup only through MCP tools.

Do not enable auto-approval for SuperCollab write tools. Cline CLI `3.0.46`
accepted this native setup without warnings in an isolated environment on
2026-07-26. It remains configuration-ready, not verified, until the complete
encrypted exchange gate passes.

Official references:

- <https://docs.cline.bot/getting-started/installing-cline>
- <https://docs.cline.bot/cli/cli-reference>
