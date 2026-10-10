# @starlight-intelligence/creator-provider-elevenlabs

ElevenLabs adapter for the creator substrate: text-to-speech, sound effects and music composition with the user's own key.

Part of the [Starlight creator substrate](https://github.com/frankxai/starlight-creator-mcp). BYOK and local-first.

Music uses `POST /v1/music`; audio output formats are query parameters for all three
endpoints. Speech WAV requests use `wav_44100` and reject replies without a RIFF/WAVE
container. The official music and sound-effect output enums do not include WAV;
those tasks reject `format: "wav"` before generation rather than returning mislabeled
PCM. Use MP3 for those tasks. Model discovery propagates HTTP, network and malformed
reply failures so doctor cannot turn a bad key into synthetic success.

Contract evidence: [official ElevenLabs SDK](https://github.com/elevenlabs/elevenlabs-js/tree/ec61f8ecbdd65b24d71b826ccff01aeff7ab0137/src/api/resources)
and [music reference](https://github.com/elevenlabs/skills/blob/1d08a4a250cff67cc8056ec31587c031ecb06d2f/music/references/api_reference.md).
Local fixtures verify requests and failure handling, not live-provider compatibility.

MIT.
