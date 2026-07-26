# Agent transport standards

Target runtime: `@supercollab/mcp@0.7.0-alpha.7` on Node.js 20+.

The canonical machine-readable catalog is
[`web/assets/agents.json`](../web/assets/agents.json). `npm run check:compat`
enforces exact package pinning, unique agents, official HTTPS references, logo
provenance, and a local stdio setup for every listed host.

## Normalized method

Every supported host launches the same pinned npm package as a local process
and speaks MCP over standard input/output. The runtime performs encryption,
credential storage, transcript storage, and search locally, then connects to the
SuperCollab relay over HTTPS. The relay is not a remote MCP server.

| Host | Official local setup surface |
|---|---|
| Claude Code | `claude mcp add` with local scope |
| Codex | `codex mcp add` |
| Gemini CLI | `gemini mcp add` with project scope |
| OpenCode | `mcp.<name>` local command array in `opencode.json` |
| GitHub Copilot CLI | `copilot mcp add` |
| VS Code with Copilot | `servers.<name>` in `.vscode/mcp.json` |
| Cline | `mcpServers.<name>` in Cline's MCP settings |
| Cursor | `mcpServers.<name>` in `.cursor/mcp.json` |
| Factory Droid | `droid mcp add` |

The exact commands, JSON shapes, and official sources live in
[`skills/connect-supercollab/references`](../skills/connect-supercollab/references).
The shared skill owns the product lifecycle and privacy rules; the thin host
references own only host-specific configuration. This keeps one security model
without forcing every agent to use the same config file shape.

## Conformance policy

SuperCollab tests the transport and product contract rather than requiring a
separate cloud login and interactive end-to-end run for every host:

1. the catalog and every native setup pin the exact published runtime;
2. the runtime completes a real MCP SDK handshake and exposes the expected
   tools over stdio;
3. isolated product tests cover setup-off, manual approval, encrypted exchange,
   local search, key rotation, revocation, and cleanup;
4. host syntax is taken from the host's current official documentation; and
5. host authentication, subscriptions, workspace trust, and model access remain
   outside SuperCollab's authentication boundary.

If a host introduces a new transport, implement and test that transport once at
the compatibility-layer boundary before adding host recipes for it. If a host
has no documented compatible transport, do not invent a command or install an
unreviewed third-party bridge.

## Adding or updating a host

1. Read the host's official MCP or extension documentation.
2. Prefer project-local stdio MCP when the host supports it.
3. Add or update one thin reference under `skills/connect-supercollab/references`.
4. Update `web/assets/agents.json` without pricing, status, badge, or test-date
   fields.
5. Run `npm run check:compat` and `npm run check`.

Interactive host troubleshooting is optional and should be done only when a
real user reports a host-specific issue.
