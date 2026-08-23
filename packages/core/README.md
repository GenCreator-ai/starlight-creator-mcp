# @starlight-intelligence/creator-core

Sovereign creator substrate core: providers, registry, router, best-of loop, vault, fetch guard, sandbox, storage, ledger, jobs, provenance, publishing, license, packs.

The engine behind [`starlight-creator-mcp`](https://github.com/frankxai/starlight-creator-mcp), with no MCP dependency of its own.

Provider interface and registry, pack-driven model routing, the best-of-N taste loop, an OS-keychain credential vault, a fetch guard (host allowlist, private-range and DNS-rebind blocking), a path sandbox, local/rclone storage, a content-addressed SQLite ledger with provenance sidecars, signed publication manifests, and Polar license validation with a MAC-signed offline grace period.

Part of the [Starlight creator substrate](https://github.com/frankxai/starlight-creator-mcp). BYOK and local-first: provider keys stay in the user's OS keychain and generated media stays on their machine.

MIT.
