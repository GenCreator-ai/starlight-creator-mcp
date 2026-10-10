# Security model

The MCP client (Claude, Cursor, Antigravity, Codex) is the principal. The substrate trusts it for content. Provider credentials remain outside the MCP tool surface, and subprocesses use argument arrays. Publication requires a signed manifest after confirmation through the trusted client or local CLI; the server does not independently verify human presence.

## Credentials
- Resolution order: environment variable → OS keychain (`@napi-rs/keyring`: Windows Credential Manager, macOS Keychain, Secret Service) → AES-256-GCM file under `~/.creator-mcp/` (headless fallback, key in `vault.key` 0600 or `CREATOR_VAULT_KEY`).
- Keys are sent only to their provider, in headers (never URL query strings). Logs go to stderr and pass through a redactor that knows every vault value plus common key shapes.
- The MCP tool surface has no "set key" tool. Keys enter via `creator-mcp setup` or the client's own config/MCPB `user_config`.

## Network
- Every outbound request goes through `guardedFetch`: http(s) only, host allowlist (provider hosts + `policy.allowHosts`), private/link-local/loopback ranges blocked (including DNS results), redirects re-checked, size and time limits. Provider result URLs are fetched only when returned by a provider for a job we created.
- `import_url` must be on the allowlist; `CREATOR_ALLOW_PRIVATE_HOSTS=1` exists for tests only.
- Redirects stop after 20 hops and share one deadline through DNS checks, response headers and body consumption (including `json()`/`text()` and streamed reads). Cross-origin GET/HEAD redirects drop all caller headers and credentials; other cross-origin payloads, URL credentials and HTTPS downgrades are denied. Redirect response bodies are cancelled, and pre-cancelled calls never start a fetch. Actual body bytes are capped when `maxBytes` is configured, including chunked responses without a size header. Failed or empty DNS checks deny the request. A request-scoped Undici dispatcher checks connection-time DNS answers and passes only checked addresses to the socket, preventing a second resolution from bypassing the preflight check. Its connections are destroyed when the response finishes, fails or is cancelled; the global dispatcher is unchanged. Timing out a DNS check bounds the caller's wait but cannot cancel the OS resolver itself. These guards depend on the configured host policy and address classification; they do not attest a provider's trustworthiness or defend against compromised network infrastructure.
- The optional HTTP transport binds to 127.0.0.1, validates Host/Origin for localhost, and is stateless per request (no shared in-process state between sessions).

## Filesystem
- Writes are confined by `resolveInside()`: no absolute paths, no `..`, no UNC, symlink escape checked. Roots: `~/.creator-mcp`, the configured assets directory, the `init` target.
- No shell strings. `rclone` is invoked with `execFile` and an argument array.

## Publishing
- `creator_publication_prepare` computes a canonical payload hash; `creator_publication_approve` requires the human to type the first 8 characters of that hash through an elicitation form (or the `creator-mcp approve` terminal command). The manifest is then HMAC-SHA256 signed with a key that lives in the vault.
- `creator_publish` verifies signature, expiry (≤ 14 days), recomputed hash and asset bytes before sending; channel sends are idempotent by `sha256(payload_hash | channel | adapter)`; a per-adapter hourly limit is enforced locally.
- Numerical claims without an evidence asset are marked `blocked` and surfaced as warnings.
- Confirmation is supplied by the MCP client's elicitation channel or the local CLI. The server authenticates the resulting manifest with HMAC; it does not independently attest that a human supplied the confirmation. A compromised or automated client can return a matching code. Hosts must keep approval entry separate from untrusted agent execution before treating this as an independent human approval boundary.

## Licenses
- Polar keys are validated from the user's machine against the public customer-portal endpoint. Offline use is allowed for 14 days after a *successful online* validation of the same key fingerprint; the cache is MAC-signed so editing it does not unlock anything. There are no length or prefix heuristics.

## Reporting
Open a private security advisory on GitHub or email the maintainer listed in `package.json`.
