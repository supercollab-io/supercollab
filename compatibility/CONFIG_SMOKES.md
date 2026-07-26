# Configuration smoke ledger

These records prove native configuration parsing and stdio startup only. They do
not satisfy the real-client verification schema.

## 2026-07-26

All clients were installed at exact versions from their official npm packages
inside a disposable Docker-mounted directory. The tmux lab used an empty home,
empty worktree, isolated SuperCollab config, and a scrubbed environment with no
cloud keys, npm credentials, SSH agent, or Git configuration.

| Client | Version | Result |
|---|---:|---|
| Gemini CLI | 0.52.0 | Native project MCP entry accepted; server intentionally disabled because the disposable folder was left untrusted |
| OpenCode | 1.18.5 | Native local stdio entry completed a handshake and `opencode mcp list` reported `supercollab connected` |
| Cline CLI | 3.0.46 | Native noninteractive `cline mcp add` completed with `status: installed` and no warnings |

Package identities checked before installation:

- `@google/gemini-cli@0.52.0`, Apache-2.0, repository
  `google-gemini/gemini-cli`, integrity
  `sha512-/6FvfvlcsOJtn3NAgTp5/ca9xS6nmat4otQ+NEVoT6lovmI2N5jHxtBqGtjLUo+cvBfGgtR2WmkCPxxpHjr61Q==`
- `opencode-ai@1.18.5`, MIT, integrity
  `sha512-Q0jlX4ihn7veMeYsLX3c4PYFAKIURU3GIpXt1FnhNxNn3v8+RpIZ8z9umG5D0r8g8Smp9fZLGjgLe/9mJ4NyYw==`
- `cline@3.0.46`, Apache-2.0, repository `cline/cline`, integrity
  `sha512-U6uH3sLVvqx4fP65ejHkswhk3WvYOM2LCbQBX77Z7Tha4EX35vo2XZ51F6WnIiKlCAYZJ+YAEou2Yha/EAk+2A==`

Next gate: repeat with the published `@supercollab/mcp` artifact, a trusted
disposable project, interactive host authentication where required, a second
verified client, and every gate in `evidence.schema.json`.
