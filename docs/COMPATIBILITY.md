# Compatibility and verification

Target runtime: `@supercollab/mcp@0.7.0-alpha.5` on Node.js 20+.

The canonical machine-readable matrix is
[`web/assets/agents.json`](../web/assets/agents.json). `npm run check:compat`
enforces exact package pinning, unique clients, HTTPS source links, logo
provenance, and conservative verification states.

## Core clients

| Client | Access statement | MCP | Status |
|---|---|---|---|
| Claude Code | Free to install; provider access is separate | Native stdio | Verified 2026-07-23 |
| Codex | A $0 plan exists; API usage is separate | Native stdio | Verified 2026-07-23 |
| Gemini CLI | Free individual quota | Native stdio | Configuration ready |
| OpenCode | MIT client; provider access is separate | Native local | Configuration ready |
| VS Code + Copilot | Copilot Free starting tier | Native stdio | Configuration ready |
| Cline | Apache-2.0 client; hosted/local providers | Native local | Configuration ready |

`configuration ready` means the current official host documentation supports the
shown native MCP setup. It is not a claim that the real client has passed the
SuperCollab exchange gate.

On 2026-07-26, isolated configuration smokes added the native entry in Gemini
CLI `0.52.0` (then observed its untrusted-folder suppression), completed an
OpenCode `1.18.5` stdio handshake, and completed Cline CLI `3.0.46`'s native
noninteractive MCP install without warnings. VS Code remains documentation-
validated pending a real editor test.

## Compatibility lab

| Client | Why it is not in the verified core |
|---|---|
| Cursor | Native MCP exists, but current published access is plan-dependent |
| Pi | MIT client with an extension API; a reviewed first-party adapter is needed |
| Factory Droid | Native MCP exists, but the published individual plan is paid |

## Verification evidence

On 2026-07-23, clean Codex CLI `0.144.1` and Claude Code `2.1.172`
identities joined one disposable room through a disposable relay. Codex sent an
approved marker, Claude decrypted and locally searched it before replying, and
Codex decrypted and locally searched the reply. PostgreSQL contained three
AES-GCM envelopes, no plaintext-message rows, and digest-only account
credentials; both local config files were mode `600`.

Codex displayed its own approval prompt for the exact `chat_send` arguments.
Claude ran with built-in filesystem, shell, network, and task tools disabled and
only the required SuperCollab MCP tools available.

## Promotion gate

A client receives `verified` only when the exact published runtime completes all
of these steps in an isolated tmux environment:

1. official, pinned client installation;
2. native MCP start with workspace sharing off;
3. local account and agent creation with no secret disclosure;
4. disposable room create/join and manual activation;
5. explicitly approved send plus cross-client read/reply;
6. local sync and keyword/BGE search;
7. relay plaintext and credential absence checks;
8. invite/agent revocation, workspace off, and complete cleanup.

A host login or subscription failure before MCP tool selection is host-account
evidence, not SuperCollab interoperability evidence.
