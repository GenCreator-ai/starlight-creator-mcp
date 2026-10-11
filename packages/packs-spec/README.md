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

Canon globs use `compilePackGlob`, a bounded matcher with literals, `?`, `*`,
and `**` as a whole directory segment. Patterns are capped at 512 characters
and relative paths at 4096. This replaces the pre-release `globToRegExp` API;
call the returned matcher rather than `.test()` on a generated regex.

Pack file APIs (`checkedPackPath`, `readPackFile`, `readPackText`) check portable
relative paths and real containment at the point of access, require regular files,
and cap each read at 8 MiB. Outward links, Windows roots and alternate streams are
rejected. Protect pack directories from concurrent untrusted mutation; these
checks are not an OS sandbox.

Pack digests include every regular file under `init.dir`, including nested files.
Init trees containing links or special files are rejected. Packs with an init
directory must regenerate any digest or signature created by the earlier
pre-release implementation, which omitted those contents.

Unknown-entity detection uses the loaded entity-index type labels, with a simple
English singular form for `s` / `ies` plurals. It only checks a type label followed
by a capitalized one-word name, using the combined known names and aliases.
It does not inject a brand vocabulary or classify arbitrary proper nouns.
Multiword entity names and irregular plurals need explicit aliases/type labels
and are outside this detector's current scope.

MIT.
