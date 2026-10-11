# @starlight-intelligence/creator-cli

creator-mcp CLI: stdio, http, setup, doctor, init, approve, inspect.

The `creator-mcp` command: `stdio`, `http`, `setup`, `doctor`, `init`, `approve`, `packs`, `inspect`. Brand wrappers reuse it through `runCli({ brand, version, npmPackage, packs, providers, tools })` so every brand gets the same setup and diagnostics. Set `npmPackage` to the wrapper's own registry package name. Registry-launched wrappers require that identity when generating a version-pinned client launch configuration; omitting it fails with an actionable error.

Part of the [Starlight creator substrate](https://github.com/frankxai/starlight-creator-mcp). BYOK and local-first: provider keys stay in the user's OS keychain and generated media stays on their machine.

MIT.
