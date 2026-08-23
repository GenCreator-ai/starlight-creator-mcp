import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockProviders, type MockState } from './mock-providers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const STDIO = path.resolve(here, '..', 'dist', 'stdio.js')
const STARTER = path.resolve(here, '..', '..', '..', 'packs', 'starter')

let mock: { server: import('node:http').Server; url: string; state: MockState }
let client: Client
let home: string
let confirmWith: (code: string) => string = code => code

function structured<T>(res: { structuredContent?: unknown }): T { return res.structuredContent as T }

beforeAll(async () => {
  mock = await startMockProviders()
  home = await mkdtemp(path.join(os.tmpdir(), 'creator-e2e-'))
  client = new Client({ name: 'e2e', version: '0.0.0' }, { capabilities: { elicitation: { form: {} } } })
  client.setRequestHandler('elicitation/create', async request => {
    const params = request.params as { message: string }
    const code = /code ([a-f0-9]{8})/.exec(params.message)?.[1] ?? ''
    return { action: 'accept', content: { confirm: confirmWith(code) } }
  })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [STDIO],
    env: {
      ...process.env,
      CREATOR_MCP_HOME: home, CREATOR_PACKS: STARTER, CREATOR_ALLOW_PRIVATE_HOSTS: '1', CREATOR_VAULT_BACKEND: 'encrypted-file', CREATOR_LOG_LEVEL: 'warn',
      MUAPI_BASE_URL: mock.url, OPENROUTER_BASE_URL: mock.url, ELEVENLABS_BASE_URL: mock.url,
      MUAPI_KEY: 'test-muapi-key-000000', OPENROUTER_API_KEY: 'test-openrouter-key-000000', ELEVENLABS_API_KEY: 'test-eleven-key-000000',
    },
  })
  await client.connect(transport)
}, 60_000)

afterAll(async () => {
  await client.close().catch(() => {})
  mock.server.close()
})

describe('creator-mcp over stdio', () => {
  it('lists the 16 substrate tools with output schemas and annotations', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual(['creator_asset_sync', 'creator_assets', 'creator_generate_audio', 'creator_generate_image', 'creator_generate_video', 'creator_job_status', 'creator_license_status', 'creator_metrics_ingest', 'creator_metrics_query', 'creator_models', 'creator_pack_info', 'creator_publication_approve', 'creator_publication_prepare', 'creator_publish', 'creator_score', 'creator_transcribe'])
    for (const t of tools) { expect(t.outputSchema, t.name).toBeDefined(); expect(t.annotations, t.name).toBeDefined() }
    expect(tools.find(t => t.name === 'creator_models')?.annotations?.readOnlyHint).toBe(true)
    expect(tools.find(t => t.name === 'creator_generate_image')?.annotations?.readOnlyHint).toBe(false)
  })

  it('creator_models merges both providers and reports the pack default', async () => {
    const res = structured<{ models: Array<{ id: string }>; counts: Record<string, number>; default_for_task?: string; providers: Array<{ id: string; configured: boolean }> }>(await client.callTool({ name: 'creator_models', arguments: { task: 't2i', limit: 100 } }))
    expect(res.counts.t2i).toBeGreaterThan(50)
    expect(res.models.some(m => m.id === 'openrouter/openai/gpt-image-1')).toBe(true)
    expect(res.models.some(m => m.id.startsWith('muapi/'))).toBe(true)
    expect(res.default_for_task).toBe('muapi/nano-banana-pro')
    expect(res.providers).toEqual([{ id: 'openrouter', configured: true }, { id: 'muapi', configured: true }, { id: 'elevenlabs', configured: true }, { id: 'google', configured: false }])
  })

  it('routes a logo prompt to the typography preference and stores the asset with provenance', async () => {
    const res = await client.callTool({ name: 'creator_generate_image', arguments: { prompt: 'a logo for a bakery', style: 'cinematic' } })
    const out = structured<{ status: string; asset?: { sha256: string; mime: string; local_path: string }; route: { model: string; reason: string } }>(res)
    expect(out.status).toBe('completed')
    expect(out.route.reason).toContain('t2i:text')
    expect(out.asset?.mime).toBe('image/png')
    expect(res.content.some(c => c.type === 'image')).toBe(true)
    const sidecar = JSON.parse(await readFile(path.join(home, 'assets', out.asset!.sha256.slice(0, 2), `${out.asset!.sha256}.provenance.json`), 'utf8')) as Record<string, unknown>
    expect(sidecar.schema).toBe('creator-provenance.v1')
    expect(sidecar.style).toBe('cinematic')
    expect((sidecar.pack as { ids: string[] }).ids).toEqual(['starter'])
    expect(String(sidecar.prompt)).toContain('cinematic still')
  })

  it('best_of runs the taste loop and keeps the highest-scoring candidate', async () => {
    mock.state.judgeScores = [40, 92, 70]
    const out = structured<{ status: string; score?: { score: number; ship_decision: string; rubric_id: string }; candidates?: Array<{ sha256: string; score?: number }> }>(await client.callTool({ name: 'creator_generate_image', arguments: { prompt: 'a quiet harbour at dawn', best_of: 3, model: 'openrouter/openai/gpt-image-1' } }))
    expect(out.status).toBe('completed')
    expect(out.candidates?.length).toBe(3)
    expect(out.score?.rubric_id).toBe('visual-taste')
    expect(out.score?.score).toBeGreaterThanOrEqual(80)
    expect(out.score?.ship_decision).toBe('ship')
  })

  it('video is asynchronous: job id first, completed after polling', async () => {
    const first = structured<{ job_id: string; status: string; next_step?: string }>(await client.callTool({ name: 'creator_generate_video', arguments: { prompt: 'slow dolly over a glacier', model: 'openrouter/google/veo-3.1', wait_ms: 0 } }))
    expect(['queued', 'running']).toContain(first.status)
    expect(first.next_step).toContain('creator_job_status')
    const done = structured<{ status: string; asset?: { mime: string; kind: string }; cost_usd?: number }>(await client.callTool({ name: 'creator_job_status', arguments: { job_id: first.job_id, wait_ms: 15_000 } }))
    expect(done.status).toBe('completed')
    expect(done.asset?.kind).toBe('video')
    expect(done.cost_usd).toBe(0.5)
  })

  it('creator_score works on text with the default text rubric', async () => {
    mock.state.judgeScores = [75]
    const out = structured<{ score: number; rubric_id: string; ship_decision: string }>(await client.callTool({ name: 'creator_score', arguments: { text: 'We shipped the thing. It works.' } }))
    expect(out.rubric_id).toBe('writing-clarity')
    expect(out.score).toBeGreaterThan(0)
  })

  it('creator_assets lists what was generated and the canon resource is readable', async () => {
    const out = structured<{ assets: Array<{ sha256: string; kind: string }> }>(await client.callTool({ name: 'creator_assets', arguments: { kind: 'image', limit: 10 } }))
    expect(out.assets.length).toBeGreaterThanOrEqual(2)
    const info = structured<{ packs: Array<{ id: string }>; canon_files: Array<{ file: string }> }>(await client.callTool({ name: 'creator_pack_info', arguments: { section: 'canon', query: 'locked world' } }))
    expect(info.packs[0]?.id).toBe('starter')
    expect(info.canon_files.some(f => f.file === 'canon/CANON.md')).toBe(true)
    const res = await client.readResource({ uri: 'pack://starter/canon/canon/CANON.md' })
    expect(String(res.contents[0]?.text)).toContain('Canon')
    const { prompts } = await client.listPrompts()
    expect(prompts.map(p => p.name)).toContain('shot-list')
    const prompt = await client.getPrompt({ name: 'shot-list', arguments: { scene: 'a lighthouse in fog', shots: '3' } })
    expect(String((prompt.messages[0]?.content as { text: string }).text)).toContain('Plan 3 shots')
  })

  it('prepare → approve (human code via elicitation) → publish to local outbox; wrong code is rejected', async () => {
    const assets = structured<{ assets: Array<{ sha256: string }> }>(await client.callTool({ name: 'creator_assets', arguments: { kind: 'image', limit: 1 } }))
    const sha = assets.assets[0]!.sha256
    const prep = structured<{ manifest_id: string; confirm_code: string; warnings: string[] }>(await client.callTool({ name: 'creator_publication_prepare', arguments: { posts: [{ channel_id: 'outbox', text: 'A harbour at dawn. No numbers, no promises.', assets: [sha] }] } }))
    expect(prep.warnings).toEqual([])
    confirmWith = () => 'deadbeef'
    const rejected = structured<{ status: string; reason?: string }>(await client.callTool({ name: 'creator_publication_approve', arguments: { manifest_id: prep.manifest_id } }))
    expect(rejected.status).toBe('rejected')
    expect(rejected.reason).toMatch(/confirmation/)
    const refused = await client.callTool({ name: 'creator_publish', arguments: { manifest_id: prep.manifest_id } })
    expect(refused.isError).toBe(true)
    confirmWith = code => code
    const approved = structured<{ status: string; signature?: string }>(await client.callTool({ name: 'creator_publication_approve', arguments: { manifest_id: prep.manifest_id } }))
    expect(approved.status).toBe('approved')
    expect(approved.signature).toMatch(/^[a-f0-9]{64}$/)
    const dry = structured<{ publications: Array<{ status: string }> }>(await client.callTool({ name: 'creator_publish', arguments: { manifest_id: prep.manifest_id, dry_run: true } }))
    expect(dry.publications[0]?.status).toBe('dry_run')
    const sent = structured<{ status: string; publications: Array<{ status: string; native_id?: string }> }>(await client.callTool({ name: 'creator_publish', arguments: { manifest_id: prep.manifest_id, adapter: 'local' } }))
    expect(sent.status).toBe('sent')
    const outbox = await readdir(path.join(home, 'outbox'))
    expect(outbox.length).toBe(1)
    const again = structured<{ publications: Array<{ native_id?: string }> }>(await client.callTool({ name: 'creator_publish', arguments: { manifest_id: prep.manifest_id, adapter: 'local' } }))
    expect(again.publications[0]?.native_id).toBe(sent.publications[0]?.native_id)
    expect((await readdir(path.join(home, 'outbox'))).length).toBe(1)
  })

  it('numerical claims without evidence are blocked and banned phrases warned', async () => {
    const prep = structured<{ warnings: string[] }>(await client.callTool({ name: 'creator_publication_prepare', arguments: { posts: [{ channel_id: 'outbox', text: 'We unlock 340% growth', assets: [] }], claims: [{ text: '340% growth', type: 'numerical' }] } }))
    expect(prep.warnings.some(w => w.includes('blocked'))).toBe(true)
    expect(prep.warnings.some(w => w.includes('banned phrase "unlock"'))).toBe(true)
  })

  it('generates speech, sound effects and music through the audio provider', async () => {
    const tts = structured<{ status: string; asset?: { kind: string; mime: string } }>(await client.callTool({ name: 'creator_generate_audio', arguments: { kind: 'tts', text: 'The first gate opens at dawn.' } }))
    expect(tts.status).toBe('completed')
    expect(tts.asset?.kind).toBe('audio')
    // no voice given, so the provider resolved one from the account
    expect(mock.state.elevenCalls.at(-1)?.path).toBe('/v1/text-to-speech/voice_mock_1')

    const sfx = structured<{ status: string; asset?: { kind: string } }>(await client.callTool({ name: 'creator_generate_audio', arguments: { kind: 'sfx', prompt: 'distant thunder over water', duration_s: 4 } }))
    expect(sfx.status).toBe('completed')
    expect(sfx.asset?.kind).toBe('audio')
    expect((mock.state.elevenCalls.at(-1)?.body as { duration_seconds?: number }).duration_seconds).toBe(4)

    const music = structured<{ status: string }>(await client.callTool({ name: 'creator_generate_audio', arguments: { kind: 'music', prompt: 'slow ambient strings', duration_s: 12 } }))
    expect(music.status).toBe('completed')
    expect(mock.state.elevenCalls.at(-1)?.path).toBe('/v1/music/compose')
    // seconds are converted to the API's milliseconds, clamped to its 3s-600s range
    expect((mock.state.elevenCalls.at(-1)?.body as { music_length_ms?: number }).music_length_ms).toBe(12_000)
  })

  it('license status is honest when no key is configured', async () => {
    const out = structured<{ valid: boolean; source: string }>(await client.callTool({ name: 'creator_license_status', arguments: {} }))
    expect(out.valid).toBe(false)
    expect(out.source).toBe('none')
  })

  it('import_url refuses hosts outside the allowlist', async () => {
    const res = await client.callTool({ name: 'creator_asset_sync', arguments: { import_url: 'https://example.com/x.png' } })
    expect(res.isError).toBe(true)
    expect(String((res.content[0] as { text: string }).text)).toMatch(/allowlist/)
  })
})
