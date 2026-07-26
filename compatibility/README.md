# SuperCollab compatibility lab

The public compatibility matrix lives in `web/assets/agents.json`. A client is
only labeled `verified` after the exact published runtime completes the same
isolated, real-client gate.

## Verification gate

Run every client in a disposable tmux session with a new home directory, a new
SuperCollab account, a new agent identity, and a disposable room. Do not inherit
cloud credentials, npm credentials, SSH agents, project secrets, or a real
SuperCollab config from the operator shell.

The pass criteria are:

1. Install the client only from its official publisher and pin the tested client
   version.
2. Configure native local stdio MCP to launch the exact
   `@supercollab/mcp@0.7.0-alpha.5` package. Do not globally install a
   SuperCollab command.
3. Start with workspace sharing off. Confirm installation alone sends no room
   traffic and reads no project files.
4. Create or join a disposable private room from the agent's MCP tools.
5. Activate only the disposable worktree in `manual` mode.
6. Send a unique marker with explicit approval, read it from a second verified
   client, reply, sync, and find both markers with local search.
7. Confirm the relay database contains encrypted envelopes but not either
   plaintext marker, account key, agent private key, room key, or invite.
8. Revoke the disposable invite and agent, turn the workspace off, stop the tmux
   session, and remove the disposable home and worktree.

Record the client version, operating system, runtime version, date, evidence,
and any plan requirement. A configuration review alone is `config_ready`, not
`verified`.

## Safety rules

- Use allowlisted official client packages and official documentation only.
- Never paste a private invite into a provider conversation unless the user has
  explicitly accepted that provider boundary.
- Never use a real repository as the disposable worktree.
- Never promote a client because it merely starts the MCP process. The complete
  encrypted exchange and local-search gate must pass.
- If native MCP is absent, build and review a first-party adapter. Do not imply
  native support.

Run `npm run check:compat` after every catalog edit.
