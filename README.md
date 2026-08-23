# starlight-creator-mcp

One MCP engine for agentic creators, built so the **user's own machine and keys** do all the work. Brand packs (Arcanea, GenCreator, Author OS, Anime Legends) sit on top as data; this repository is the unbranded substrate they share.

- **BYOK, client-side.** Provider keys live in your OS keychain. Nothing here proxies, logs or stores them.
- **Local ledger with provenance.** Every generated or imported file is content-addressed (sha256) and carries a `.provenance.json` sidecar: model, prompt, seed, cost, pack, rubric scores.
- **Taste loop.** `best_of` / `min_score` generate N candidates, score each against the loaded pack's rubric with a vision judge, keep the best.
- **Human-gated publishing.** Posts go through a signed manifest: prepare → the person types an 8-character confirm code → HMAC-signed → publish through *your* Postiz or a local outbox. Agents cannot self-approve. Numbers without evidence are blocked.
- **Packs are data.** Canon, rubrics, templates, prompts, styles and routing preferences come from `pack.json` directories; two packs compose (e.g. `author-os` + `arcanea`).

## Install

The npm name `starlight-creator-mcp` is **not on the registry yet** (verified 2026-08-22: packument 404). Do not run `npx -y starlight-creator-mcp` until a first publish exists. Use this repo:

```bash
git clone https://github.com/frankxai/starlight-creator-mcp.git
cd starlight-creator-mcp
pnpm install
pnpm -r --filter './packages/**' run build
node packages/bundle/dist/main.js doctor
node packages/bundle/dist/main.js setup --print   # prints Claude / Cursor mcpServers JSON
```

`setup` without `--print` is interactive (stores keys in the OS keychain). Non-TTY correctly exits 2.

Verified locally 2026-08-22 (`main` `4185596`): `doctor` exit 0 with starter pack + local ledger/storage; keys optional.

After the first publish, the install path becomes `npx -y starlight-creator-mcp`. Until then, point MCP clients at `node /absolute/path/to/packages/bundle/dist/main.js`.

Providers in this tree: **OpenRouter** (text, images, async video, transcription), **MuAPI** (226-model image/video catalog), **ElevenLabs** (speech, sound effects, music), **Google Gemini** (vision judge). Each activates only when its key is present; `doctor` runs with none of them.

Storage: **local** (default, always on), **S3-compatible** (AWS S3, Cloudflare R2, MinIO — `setup --storage`), **rclone** (any remote it supports). Publishing media needs a connector that can produce a public URL, so local-only installs can generate and score but not attach images to posts.

## Tools (16)

`creator_models` · `creator_generate_image` · `creator_generate_video` · `creator_generate_audio` · `creator_transcribe` · `creator_job_status` · `creator_score` · `creator_assets` · `creator_asset_sync` · `creator_pack_info` · `creator_publication_prepare` · `creator_publication_approve` · `creator_publish` · `creator_metrics_ingest` · `creator_metrics_query` · `creator_license_status`

Every tool has an input schema, an output schema (`structuredContent`) and annotations. Long jobs return a `job_id` within `wait_ms` (≤ 20 s) instead of blocking. Resources: `pack://<id>/manifest`, `pack://<id>/canon/<file>`, `pack://<id>/templates/<id>`, `pack://<id>/rubrics/<id>`, `creator://assets/<sha>`, `creator://jobs/<id>`. Pack prompts become MCP prompts.

## Packages

| Package | Role |
|---|---|
| `@starlight-intelligence/creator-core` | providers, router, taste loop, vault, fetch guard, sandbox, storage, ledger, publishing, license, packs |
| `@starlight-intelligence/creator-server` | MCP server factory (`createCreatorServer`) + tools/resources/prompts |
| `@starlight-intelligence/creator-packs-spec` | `creator-pack-manifest.v1` schema, validator, merge rules, `creator-pack` CLI |
| `@starlight-intelligence/creator-cli` | `creator-mcp stdio | http | setup | doctor | init | approve | packs | inspect` |
| `@starlight-intelligence/creator-provider-{openrouter,muapi,elevenlabs,google}` | provider adapters |
| `@starlight-intelligence/creator-storage-s3` | optional S3/R2 connector (the AWS SDK is never a required install) |
| `starlight-creator-mcp` | the installable bundle |

## Build a brand on it

```ts
import { createCreatorServer } from '@starlight-intelligence/creator-server'
import { createOpenRouterProvider } from '@starlight-intelligence/creator-provider-openrouter'

export const createArcaneaServer = () => createCreatorServer({
  name: 'arcanea-mcp', version: '1.0.0',
  packs: [PACK_DIR],                                   // data only: canon, rubrics, prompts, styles
  providers: vault => [createOpenRouterProvider({ vault })],
  tools: { alias: { creator_generate_image: 'arcanea_generate_image' }, defaults: { creator_generate_image: { style: 'arcanean-cinematic', best_of: 2 } } },
})
```

Rules: brands depend on the substrate, never on each other; packs are data, not code; one direction of dependency.

## Security model

Read [SECURITY.md](SECURITY.md). Short version: keys in the keychain, every outbound fetch goes through a host allowlist that blocks private ranges, every write is sandboxed, publishing requires a human-entered code, and the server never executes shell strings.

## Develop

```bash
pnpm install
pnpm -r --filter './packages/**' run build
pnpm test          # unit + protocol-level e2e (spawns the stdio server, mocks providers)
pnpm lint
pnpm inspect       # MCP Inspector against dist/stdio.js
```

MIT.
