# Compatibility lab

Do not advertise or auto-configure these clients as part of the verified free
core yet:

- **Cursor:** native MCP exists, but the current published pricing page lists
  MCP under paid Individual plans. A real plan-access and encrypted-exchange
  test is still required.
- **Pi:** the MIT-licensed agent exposes an extension API, but native MCP has not
  been established. Build and audit a first-party adapter before offering setup.
- **Factory Droid:** native local stdio MCP exists, but the published individual
  plan is paid. Complete a plan-access and encrypted-exchange test first.

A client becomes verified only after the exact pinned runtime passes setup-off,
manual activation, approved send, cross-client read/reply, local sync/search,
relay plaintext absence, revocation, and cleanup in an isolated tmux session.
Configuration review alone is not verification.

Canonical status and source links live in `web/assets/agents.json` in the
SuperCollab repository.
