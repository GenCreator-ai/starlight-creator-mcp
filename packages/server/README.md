# @starlight-intelligence/creator-server

MCP server factory for the creator substrate: 16 creator_* tools, pack resources and prompts.

The MCP server factory. `createCreatorServer()` returns an `McpServer` (SDK v2, spec 2026-07-28) exposing 16 `creator_*` tools with input schemas, output schemas and annotations, plus pack resources, pack prompts and JSON composite tools.

Brand wrappers call this with their own pack and a `tools` curation block to rename or hide tools; they never reimplement one.

Part of the [Starlight creator substrate](https://github.com/frankxai/starlight-creator-mcp). BYOK and local-first: provider keys stay in the user's OS keychain and generated media stays on their machine.

MIT.
