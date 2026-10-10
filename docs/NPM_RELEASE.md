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
are omitted from its environment. Historical counts are not current evidence; use
the test output and source-bound receipts for the chosen revision. Local working-tree receipts are marked dirty and
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

The publisher checks the exact manual main workflow as well as source identity.
It launches npm from a private package root with empty project/user/global configs,
an explicit public registry and an allowlisted environment. Inherited npm config,
Node preload options and provider/GitHub tokens are omitted; OIDC and GitHub
provenance metadata are retained. An offline regression shows that empty user/global
configs alone still admit parent project configuration, while the isolated runtime
uses the public registry. Signed npm trusted-publisher configuration remains the
authorization boundary; workflow environment strings are checks against accidents.
Consumer verification invalidates previous success before parsing the manifest or
installing artifacts. A failed rerun cannot retain a prior positive receipt; an
executable malformed-manifest regression covers that recovery boundary.

10 October follow-up: regression fixtures exposed partial terminators, hidden
trailing members, incomplete padding and ambiguous path/numeric fields accepted
by the archive parser. These are now rejected before inspecting or publishing
content. Directory payloads are denied and directories count toward the 500-member
limit. Compressed 2 MB/decoded 8 MB budgets are retained. The previously packed archives
still parsed at that revision. The earlier clean receipt,
review packet and hosted success at 1ce433d retain their revision boundaries and
must be refreshed for this change. That historical local build admission was held
at 7222 MB free/8192 MB required; it is not current machine admission. GitHub npm-production
now exists with owner approval and main-only deployment policy. Owner self-review
and default admin bypass are allowed; this does not satisfy independent review.

Before production release, obtain exact-revision independent provider review;
verify hosted Linux/Windows artifact consumers; configure all ten npm trusted
publisher identities for this repository, npm-release.yml and npm-production;
verify actual environment reviewers/main protection; and finalize account
access and the concrete version/receipt set. A YAML environment name alone does
not enforce review. New-package first-publish windows must be checked immediately
before dispatch. No npm, cloud or marketplace publication occurred in this slice.

## Product and platform boundaries

Open package value is reusable provider, pack, provenance, approval and storage
behavior on an operator-owned machine. Commercial pack licensing and provider
connectors are retained; no new checkout, subscription, brand or invented revenue
stream is introduced. Demand, pricing and competitive advantage still need buyer
evidence and matched real creation workflows on the existing platforms.

Issue 4's remote auth, tenant isolation, staging, trace, rollback, legal/privacy,
billing and marketplace gates remain open. HMAC approval proves manifest integrity
under the local key; it does not attest human presence in a client-supplied response.
Live provider generation, recovery/cost and independent approval-channel acceptance
remain unverified. Keep cloud/public support claims withheld until those gates pass.

Sources: [pnpm workspace packing](https://pnpm.io/workspaces),
[official MCP SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/),
[npm trusted publishers](https://docs.npmjs.com/trusted-publishers/).

## Review remediation validation history

The remediation uses Node 24.21.0 and pinned pnpm 11.5.0 with frozen installation.
Build, typecheck, lint, unit, existing e2e and release-contract suites were executed;
their command output, rather than historical totals above, is the evidence.
All ten tarballs passed archive/manifest/graph verification and checksum-verified
Gitleaks 8.30.1 scanning. Installed-consumer verification was attempted but stopped
at npm install with `SELF_SIGNED_CERT_IN_CHAIN` in the hosted isolated environment.
That worker attempt produced no consumer success. The consumer also requires a
local-only `--omit=optional` install
without S3/AWS and doctor acceptance; publication requires this new evidence.

Local integration preserved hosted session `cfad75da-ca44-4b47-b38f-30756c601c54`
and its immutable base `d4eb90502fdeee0ccd9c3c431cb030324b39ba09` and head
`a226857738b771ccce7aeedb65f6036ef85f514d` through a merge commit after the cloud
integration preflight passed. Lead inspection moved both installed consumers into
separate OS temporary directories. A nested local-only consumer could otherwise
resolve the omitted S3 package from its full consumer parent or the repository.
Fresh CI and review apply to the integrated candidate, not the worker's earlier
tests or certificate-limited install attempt.

The integrated Windows run exposed a SQLite handle left open when context
creation failed during configured storage initialization. The factory now closes
its own ledger on failure and preserves caller-injected ledgers; doctor closes
any successfully created context even when later diagnostics fail. Windows file
removal and injected-ledger ownership fixtures cover recovery. The failed Windows
run is retained as evidence; it does not count as release acceptance.

Integrated head `5dd78adfbf8ec79756d2d418165ff3c0736aa31b` subsequently passed
the Linux artifact/installed-consumer job in
[run 38050251918](https://github.com/frankxai/starlight-creator-mcp/actions/runs/38050251918),
including the isolated S3-omitted install and doctor checks. Both OS e2e jobs
passed. The Windows artifact job failed at SQLite cleanup before consumer
verification; that run's overall result is failure. The cleanup repair requires
a fresh complete run. Current acceptance follows the exact final head's
[PR 6 checks](https://github.com/frankxai/starlight-creator-mcp/pull/6/checks)
and downloaded source/manifest-bound receipts. Historical results cannot attest
a later revision. No npm publication or live-provider acceptance is claimed.
