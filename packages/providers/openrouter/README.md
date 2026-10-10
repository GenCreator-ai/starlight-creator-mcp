# @starlight-intelligence/creator-provider-openrouter

OpenRouter provider for the creator substrate: chat, vision, images and videos via one key. Audio generation and transcription are not implemented by this adapter.

OpenRouter adapter: chat, `/api/v1/images` and asynchronous `/api/v1/videos` (submit, poll, download) through a single user-supplied key. Also serves as the default vision judge for taste scoring.

Part of the [Starlight creator substrate](https://github.com/frankxai/starlight-creator-mcp). BYOK and local-first: provider keys stay in the user's OS keychain and generated media stays on their machine.

MIT.
