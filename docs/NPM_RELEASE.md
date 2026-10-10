# Creator package release repair

Tracking: [runtime readiness issue 4](https://github.com/frankxai/starlight-creator-mcp/issues/4).
This is a local creator runtime release candidate, not an approved multi-tenant
cloud deployment or marketplace publication.

## Problem and retained implementation

Published creator-mcp@0.1.0 contains five workspace dependency ranges. Clean npm
dependency resolution with scripts disabled returned EUNSUPPORTEDPROTOCOL on
10 October 2026. Packing alone did not establish installation readiness.

This branch starts at accepted main ffdbdc68d95ef318c69c729347f0ad7a94917545
and preserves readiness commits f2c05c7 and 860f4c0 with author provenance. These
include the ElevenLabs provider, S3/R2 connector, bundled starter pack and package
licenses. The primary Claude checkout and its uncommitted scoped manifest remain
untouched. No root AGENTS.override.md, AGENTS.md or CLAUDE.md exists in this repo;
README and SECURITY were read explicitly with the shared founder/workspace policies.

The repaired bundle is scoped creator-mcp@0.1.1 because its published 0.1.0 version
cannot be replaced. Internal candidates remain 0.1.0. CLI discovery and server.json
now use the bundle manifest identity. The Windows build command no longer retains
single quotes around its workspace filter and silently builds zero projects.
All ten workspace packages build in dependency order with concurrency one.

## Artifact and consumer verification

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run lint
pnpm test -- --maxWorkers=1
pnpm run test:release
pnpm audit --audit-level=moderate
pnpm run verify:release
pnpm run test:consumer
```

The ten pnpm tarballs are parsed and checked for exact identities, entrypoints,
license/usage files, bundled starter data, allowed members, resolved local ranges,
dependency versions/order and absent install scripts. Gitleaks scans actual contents
with redacted diagnostics. Parser budgets are 2 MB compressed/8 MB decoded/500 files
per archive; links, traversal, duplicate members and extensions are rejected.
SHA256/SHA512, source revision and dirtiness are recorded in the ignored receipt.

Consumer verification installs all ten actual tarballs together outside workspace
resolution, with install scripts disabled. It checks strict public declarations,
the installed CLI's setup/doctor/packs, official MCP stdio discovery of 16 tools,
launching an initialized workspace with its own state and asset directories, preserving an existing client configuration, and rejection of an actually prepared unsigned publication. Provider credentials
are omitted from its environment. These checks passed locally along with 52 existing
tests and 8 release safety tests. Local working-tree receipts are marked dirty and
cannot authorize publication. Hosted results must identify their own exact revision.

MCP server/client are pinned 2.3.1 and the Node adapter 2.1.1. Hono, js-yaml and
brace-expansion were updated within their existing dependency ranges; the complete
workspace audit reported zero advisories after those changes. That is registry
advisory coverage, not a proof of vulnerability absence or live provider behavior.

## Publication and recovery

The main-only manual npm-release.yml workflow verifies and installs the artifacts
before a separate npm-production OIDC job. Publishing requires a clean source-bound
receipt, matching installed-consumer evidence and unchanged tarball digests. All
existing registry versions are compared by exact integrity before any publication;
conflicts stop the release. Missing versions publish in dependency order, using
the same bytes with provenance and scripts disabled. Ambiguous failure stops;
registry reconciliation precedes a retry. A multi-package release is not atomic.
The old local --publish path is disabled. No npm token fallback is introduced.

Before production release, obtain exact-revision independent provider review;
verify hosted Linux/Windows artifact consumers; configure all ten npm trusted
publisher identities for this repository, npm-release.yml and npm-production;
configure actual environment reviewers/main protection; and finalize account
access and the concrete version/receipt set. A YAML environment name alone does
not enforce review. New-package first-publish windows must be checked immediately
before dispatch. No npm, cloud or marketplace publication occurred in this slice.

## Product and platform boundaries

Open package value is reusable provider, pack, provenance, approval and storage
behavior on an operator-owned machine. Commercial pack licensing and provider
connectors are retained; no new checkout, subscription, brand or invented revenue
stream is introduced. Demand, pricing and competitive advantage still need buyer
evidence and matched real creation workflows on the existing platforms.

Issue4's remote auth, tenant isolation, staging, trace, rollback, legal/privacy,
billing and marketplace gates remain open. HMAC approval proves manifest integrity
under the local key; it does not attest human presence in a client-supplied response.
Live provider generation, recovery/cost and independent approval-channel acceptance
remain unverified. Keep cloud/public support claims withheld until those gates pass.

Sources: [pnpm workspace packing](https://pnpm.io/workspaces),
[official MCP SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/),
[npm trusted publishers](https://docs.npmjs.com/trusted-publishers/).
