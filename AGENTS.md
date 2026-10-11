# Creator MCP engineering

This repository owns the unbranded BYOK Creator MCP runtime. Brand packs are
data; their `init/AGENTS.md` files are generated project templates, not instructions
for changing this repository. Start with `README.md`, `SECURITY.md` and
`docs/NPM_RELEASE.md` for the runtime and release contracts.

Use Node 22.13 or newer and the pinned `pnpm@11.5.0` workspace manager.
Keep provider adapters, the core ledger/storage/network boundary, MCP server,
CLI and installable bundle in their existing packages. Preserve public exports
and data compatibility; name unsupported migrations explicitly.

Use `pnpm run typecheck`, `pnpm run build`, `pnpm run lint` and focused Vitest
tests appropriate to a change. Release logic uses `pnpm run test:release`.
The hosted CI also verifies real archived-package installs on Linux and Windows.
Do not treat a source build or tarball dry run as an installed-consumer proof.

Keep keys out of source, logs and package archives. Network retrieval requires
configured allowed hosts; provider output must not grant itself access. Recovery
of an existing provider job must not silently submit another paid generation.
Keep publication approval and credential isolation enforced in the runtime.

Release through the reviewed main-branch workflow in `docs/NPM_RELEASE.md`.
Publish the verified archives only after both operating systems accept the same
bytes, and preserve provenance and release receipts. Keep independent findings
and remaining production evidence visible; synthetic tests do not establish
live provider behavior or customer value.
