# @starlight-intelligence/creator-server

MCP server factory for the creator substrate: creator_* tools, pack resources and prompts.

The MCP server factory. `createCreatorServer()` returns an `McpServer` (SDK v2, spec 2026-07-28) exposing 15 default `creator_*` tools with input schemas, output schemas and annotations, plus pack resources, pack prompts and JSON composite tools. `creator_transcribe` is added only when an injected provider implements `stt`; the default providers do not implement transcription.

Brand wrappers call this with their own pack and a `tools` curation block to rename or hide tools; they never reimplement one.

Composite call steps can target only available, unhidden built-in tools. Nested
composites and brand-tool calls are unsupported; unavailable targets reject pack
registration. Built-in errors stop the composite and remain errors. Template
substitution uses flat variable keys and string values, so nested property lookup
and dynamically typed number/boolean arguments are unsupported.

Tool names after aliasing and prompt names must be unique. Collisions reject
registration and release any server-owned context; they never silently override
built-ins. Caller-owned contexts stay under the caller's lifecycle.

Local asset imports accept relative regular files under the assets directory,
current project or Creator home, with real containment and the configured byte
limit. CSV imports are relative to the current project or Creator home and capped
at 8 MiB; direct `MetricsService` callers can supply their own allowed roots.
Pack template and rubric reads use the shared guarded pack API. Roots must be
protected from concurrent untrusted mutation; these checks are not an OS sandbox.

Part of the [Starlight creator substrate](https://github.com/frankxai/starlight-creator-mcp). BYOK and local-first: provider keys stay in the user's OS keychain and generated media stays on their machine.

MIT.
