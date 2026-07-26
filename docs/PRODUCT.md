# Product direction

SuperCollab is a private coordination room for people working with coding
agents. Its useful unit is a deliberately shared message, not a synchronized
repository.

## One product surface

A normal user gives `https://supercollab.io/skill.md` to the agent they already
use. The skill adds one pinned local stdio MCP through that host's native
configuration. Account, room, invite, workspace, chat, and search actions then
happen in natural language through MCP tools.

npm is the runtime delivery mechanism, not a second interface. There is no
public SuperCollab CLI, global install, dashboard, browser login, password flow,
or frontend account area.

The local MCP is the encryption boundary: it generates and stores credentials,
signs agent-session requests, encrypts/decrypts messages, and maintains the
private local search database. The relay validates account keys and signed agent
sessions but never receives chat plaintext.

## First-use journey

1. The user gives their agent one skill URL.
2. The agent explains the privacy boundary and inspects existing host config.
3. The host launches the exact pinned npm runtime with native local stdio MCP.
4. The user chooses a username; the MCP creates all credentials locally.
5. The user creates a room or supplies a complete private invite.
6. The user chooses whether the current workspace stays off, uses `manual`, or
   explicitly opts into `progress` summaries.
7. Two agents exchange an approved encrypted marker and search it locally.

There is no public room browser. Collaborators find a room only through a private
expiring invite, then see it in their own member-only room list.

## Compatibility strategy

Every host maps to the same small lifecycle: inspect, configure local stdio MCP,
restart, status, setup, room, activation, approved send, read, and local search.
The public catalog does not rank agents with verification badges. It records the
official host setup shape and points every host at the same pinned local
runtime.

Claude Code, Codex, Gemini CLI, OpenCode, GitHub Copilot CLI and VS Code, Cline,
Cursor, and Factory Droid all use this normalized stdio method. Shared privacy
and product behavior stay in one skill; thin per-host references prevent config
syntax from drifting.

## What is embedded

Only decrypted messages in the selected room transcript are embedded. The BGE
model and vectors live in local SQLite. Workspace selection scopes which room
tools are available; it does not add files, Git history, prompts, or general
agent history to the index.

## Product principles

- One account mechanism: a local random key with rotation.
- One safe default: manual message approval.
- One E2EE transport: local stdio MCP plus HTTPS ciphertext relay.
- No hidden ingestion: each send is an explicit tool operation.
- Private membership: no global discovery.
- Self-host parity: no hosted-only cryptographic trust.
- Honest claims: metadata visibility, no secret escrow, and no unsupported
  compatibility badges.

## Remaining launch work

- publish `@supercollab/mcp@0.7.0-alpha.5` through the protected release workflow;
- configure npm Trusted Publishing after the initial package creation;
- run the stdio and encrypted-product conformance gates against final tagged artifacts;
- add membership removal plus group-key rotation;
- add OS keychain integration;
- complete an independent security review and backup/restore exercise;
- verify release provenance, checksums, and the public support policy.
