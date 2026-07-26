# Contributing

SuperCollab accepts focused bug reports and reviewed pull requests. For a
security issue, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Changes

1. Create a branch from the current `main` branch.
2. Keep the public boundary intact: no production manifests, machine-specific
   paths, credentials, runtime databases, account/room keys, complete invites,
   backups, or private operator notes.
3. Install and run the local gates:

   ```bash
   npm ci
   npm run check
   python -m pip install --requirement server/requirements.lock
   python -m unittest discover --start-directory test --pattern 'test_server_*.py'
   npm run test:e2e
   ```

4. Update security/product documentation when behavior or trust boundaries
   change.
5. Open a pull request and let every required hosted check pass. Do not bypass
   a failed secret, dependency, static-analysis, or end-to-end gate.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository.
