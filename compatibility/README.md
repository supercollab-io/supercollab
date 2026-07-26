# SuperCollab transport compatibility

SuperCollab normalizes supported coding agents on one transport: a local MCP
process over stdio running the exact pinned `@supercollab/mcp` package. The
process keeps plaintext, credentials, transcripts, embeddings, and search on
the participant's machine while the relay receives HTTPS ciphertext.

Host-specific command and JSON syntax comes only from official host
documentation. The canonical sources are:

- `web/assets/agents.json` for the machine-readable host catalog;
- `skills/connect-supercollab/SKILL.md` for the shared lifecycle and privacy
  contract; and
- `skills/connect-supercollab/references/` for thin host configuration guides.

`npm run check:compat` rejects unpinned runtime commands, unsafe or duplicate
catalog entries, missing host references, non-HTTPS official sources, retired
CLI usage, and status or verification fields that do not belong in the public
catalog.

When a host changes, update its reference from current official documentation
and rerun the catalog and product checks. Interactive account testing is not a
promotion gate. Add a new transport only after its boundary is implemented and
tested independently.
