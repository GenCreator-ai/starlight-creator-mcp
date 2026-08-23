# @starlight-intelligence/creator-cli

creator-mcp CLI: stdio, http, setup, doctor, init, approve, inspect.

The `creator-mcp` command: `stdio`, `http`, `setup`, `doctor`, `init`, `approve`, `packs`, `inspect`. Brand wrappers reuse it through `runCli({ brand, version, packs, providers, tools })` so every brand gets the same setup and diagnostics.

Part of the [Starlight creator substrate](https://github.com/frankxai/starlight-creator-mcp). BYOK and local-first: provider keys stay in the user's OS keychain and generated media stays on their machine.

MIT.
