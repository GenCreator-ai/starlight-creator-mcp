# @starlight-intelligence/creator-core

Sovereign creator substrate core: providers, registry, router, best-of loop, vault, fetch guard, sandbox, storage, ledger, jobs, provenance, publishing, license, packs.

The engine behind [`starlight-creator-mcp`](https://github.com/frankxai/starlight-creator-mcp), with no MCP dependency of its own.

Provider interface and registry, pack-driven model routing, the best-of-N taste loop, an OS-keychain credential vault, a fetch guard (host allowlist, private-range and DNS-rebind blocking), a path sandbox, local/rclone storage, a content-addressed SQLite ledger with provenance sidecars, signed publication manifests, and Polar license validation with a MAC-signed offline grace period.

Part of the [Starlight creator substrate](https://github.com/frankxai/starlight-creator-mcp). BYOK and local-first: provider keys stay in the user's OS keychain and generated media stays on their machine.

Provider output hosts require an explicit provider or operator allowlist entry. Output URLs do not expand that list. If result retrieval or storage fails, the durable ledger keeps the original provider job ID. Correct the configuration, reopen the context, then call `context.jobs.retryIngest(jobId)` to poll that job and ingest its output again without submitting another generation. Normal `refresh` leaves terminal failures unchanged. Recovery depends on the provider still retaining the output; polling may have provider-specific charges.

An inline provider may not retain an output for later retrieval. An empty recovery result leaves the job failed, with its reported cost intact, rather than claiming completion.

Asset queries use deterministic timestamp/hash cursors, literal Unicode case-insensitive search and pack membership from both current `pack.ids` and legacy `pack.id` provenance. Pages accept 1–1,000 items; SQLite applies filtering and pagination before decoding selected rows. Metric queries return at most 10,000 observations and reject larger matching sets; narrow the publication or time window rather than accepting partial analytics.

The JSONL fallback replays UTF-8 in chunks, caps journals at 64 MiB and individual records at 1 MiB, and rejects invalid JSON/operations. Appends exceeding a budget or failing on disk leave the in-memory state unchanged. Preserve an oversized or damaged journal for repair or a data-preserving SQLite migration. Merely changing backend does not import it. These bounds are not a cross-process transaction, filesystem sandbox or fsync durability guarantee. A supported JSONL migration/compaction workflow remains open.

Throttle hits retain a 24-hour operational window. SQLite prunes expired hit rows when recording a new hit in one transaction; JSONL prunes process-local throttle state on append/read/reopen and preserves its append-only journal. `hitsSince` cannot supply older audit history. Publication, job, asset and metric records are separate and are retained. Logs still mask generic long credential-shaped strings, including full asset hashes; job ULIDs remain usable for correlation. Do not weaken masking to recover an identifier that may also be a credential.

MIT.
