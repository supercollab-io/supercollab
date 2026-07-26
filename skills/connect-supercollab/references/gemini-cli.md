# Gemini CLI

Gemini CLI supports native local stdio MCP.

1. From the intended project directory, inspect the current MCP list:

   ```bash
   gemini mcp list
   ```

2. If no conflicting `supercollab` entry exists, add the pinned runtime:

   ```bash
   gemini mcp add supercollab npx -y @supercollab/mcp@0.7.0-alpha.4
   ```

3. Restart Gemini CLI, run `/mcp list`, and ask it to check SuperCollab status.
   Perform account and room setup only through MCP tools.

Keep Gemini's tool allowlists and project trust controls enabled. This recipe is
configuration-ready: Gemini CLI `0.52.0` accepted the entry in an isolated
project on 2026-07-26, then correctly suppressed it because that disposable
folder was intentionally left untrusted. It is not real-client verified until
the trusted, authenticated encrypted-exchange gate passes.

Official reference: <https://geminicli.com/docs/tools/mcp-server/>
