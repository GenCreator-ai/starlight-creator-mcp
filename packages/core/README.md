# @starlight-intelligence/creator-core

Sovereign creator substrate core: providers, registry, router, best-of loop, vault, fetch guard, sandbox, storage, ledger, jobs, provenance, publishing, license, packs.

The engine behind [`starlight-creator-mcp`](https://github.com/frankxai/starlight-creator-mcp), with no MCP dependency of its own.

Provider interface and registry, pack-driven model routing, the best-of-N taste loop, an OS-keychain credential vault, a fetch guard (host allowlist, private-range and DNS-rebind blocking), a path sandbox, local/rclone storage, a content-addressed SQLite ledger with provenance sidecars, signed publication manifests, and Polar license validation with a MAC-signed offline grace period.

Part of the [Starlight creator substrate](https://github.com/frankxai/starlight-creator-mcp). BYOK and local-first: provider keys stay in the user's OS keychain and generated media stays on their machine.

Provider output hosts require an explicit provider or operator allowlist entry. Output URLs do not expand that list. If result retrieval or storage fails, the durable ledger keeps the original provider job ID. Correct the configuration, reopen the context, then call `context.jobs.retryIngest(jobId)` to poll that job and ingest its output again without submitting another generation. Normal `refresh` leaves terminal failures unchanged. Recovery depends on the provider still retaining the output; polling may have provider-specific charges.

MIT.
