# Public ownership and release controls

| Surface | Canonical identity | Control |
|---|---|---|
| Website | `supercollab.io` | Privately managed Cloudflare account |
| GitHub | `supercollab-io/supercollab` | `supercollab-io` organization; owner `boshjerns` |
| npm | `@supercollab/mcp` | `@supercollab` organization; owner `boshjerns` |
| Container | `ghcr.io/supercollab-io/supercollab-relay` | Repository GitHub Actions |

Normal npm publication uses npm Trusted Publishing (GitHub OIDC) from the exact
repository workflow. No npm publishing token is stored in GitHub. Container
publication uses the repository-scoped `GITHUB_TOKEN` with job-level minimum
permissions.

Every public release must bind the Git tag, package version, npm `gitHead`,
tarball integrity, container digest, and source commit. Package versions and
release tags are immutable. Production credentials and deployment state are
managed separately and are never part of this repository.
