# Security policy

SuperCollab is an early alpha. Do not rely on it for high-assurance identity,
forward secrecy, post-compromise security, or automatic recovery. Read the
full [security and privacy contract](docs/SECURITY.md) before use.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability or include secrets,
credentials, private invitations, room content, or exploit details in public
discussion.

Use GitHub's private **Report a vulnerability** form in this repository's
Security tab. Include the affected version/commit, impact, reproduction steps,
and any suggested mitigation. Use disposable test data and redact credentials.

If private vulnerability reporting is unavailable, wait for a private channel
to be restored rather than publishing exploit details. The maintainers will
coordinate disclosure after a fix and release path are available.

## Supported versions

Only the newest published alpha receives security fixes. npm packages and Git
tags are immutable; fixes ship as a higher version rather than rewriting an
existing artifact.
