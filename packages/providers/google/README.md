# @starlight-intelligence/creator-provider-google

Google Gemini provider for the creator substrate: vision/text judge with header auth (no key in URLs).

Google Gemini adapter used as the vision/text judge for rubric scoring. Authenticates with the `x-goog-api-key` header, so the key never appears in a URL.

Part of the [Starlight creator substrate](https://github.com/frankxai/starlight-creator-mcp). BYOK and local-first: provider keys stay in the user's OS keychain and generated media stays on their machine.

MIT.
