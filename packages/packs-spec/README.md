# @starlight-intelligence/creator-packs-spec

creator-pack-manifest.v1: schema, validator, merge rules and CLI for data-only creator packs.

The `creator-pack-manifest.v1` specification: Zod schema, validator, merge rules (extends ordering, semver canon requirements, per-key preference replace), canon linting, and the `creator-pack` CLI.

A **pack is data, not code**: canon, rubrics, prompts, styles, templates and routing preferences in a directory with a `pack.json`. Two packs compose — a brand pack loaded after a base pack replaces rubrics by id and preference lists by key, and unions deny lists and banned phrases.

Part of the [Starlight creator substrate](https://github.com/frankxai/starlight-creator-mcp). BYOK and local-first: provider keys stay in the user's OS keychain and generated media stays on their machine.

Routing intents and canon forbidden patterns use a bounded literal grammar:
case-insensitive ASCII text, up to 32 `|` alternatives, an optional outer group,
optional outer `\b` word boundaries, `\s+` whitespace gaps, and a final `\w*`
word suffix per alternative. For example, `\b(logo|typograph\w*)\b` matches
logo and typography; `11th\s+gate|gate\s+11` matches either canon phrase.
Patterns allow at most 512 characters and input at most 65,536 characters.
Directory validation and runtime matching reject other regular-expression syntax.
Existing packs using arbitrary regexes must migrate to this grammar.

MIT.
