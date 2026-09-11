# Security boundaries

The maintained coordinator and SDK are designed for a **single trusted workspace**, bound to loopback by default. Do not expose the sample directly to the public internet. Shared bearer authentication is not multi-user authorization; deploy separate databases/coordinators for separate trust domains until authorization is implemented.

## Implemented controls

- Every `/api/` endpoint requires a bearer token of at least 32 characters configured at startup; generate 32 random bytes with the supplied setup script.
- Origin checks reject foreign browser origins. Tokens do not appear in query strings; the UI does not persist them in browser storage. The SDK rejects redirects, URL credentials and remote plaintext HTTP.
- JSON request sizes and task input/result sizes are bounded; unknown top-level fields are rejected. SQL values use parameters.
- Task summaries omit input, result and lease token fields. Titles and worker IDs remain visible to authorized console users; do not put secrets in titles.
- The static handler only serves a fixed asset allowlist. CSP, no-store, nosniff and no-referrer headers are set. User-controlled labels use `textContent`.
- Claims and terminal updates use transactions. Retry generations get fresh random lease tokens, and expired owners receive a conflict.
- Work happens only in callers. The coordinator never executes a command embedded in a task.

The SDK trusts the authenticated server's JSON contract and does not runtime-validate every response field. TLS and server authentication are required remotely. The synthetic demo is intentionally short; a long-running real worker must implement a heartbeat loop and stop on ownership loss. Completion fences do not guarantee exactly-once external effects.

## Profile collection

`profiles/reference` is source documentation, not an enabled runtime. It includes the original graph, budget, scope, memory, RAG, ingestion, evaluation and learning tools along with full-stack skills. Known legacy issues include JSON persistence races, incomplete scope interception and tests that previously duplicated implementation logic. They are preserved for design context rather than represented as hardened tools.

The maintained `URLScope` checks exact HTTP(S) origins for typed tools. It does not parse shell commands, stop redirects or DNS rebinding, inspect subprocesses or restrict network access by itself. A real security-agent sandbox needs OS/network enforcement and explicit target authorization. No network probing is performed by this repository's demo.

## Secret handling

Generated credentials, sessions, environment files, local databases, model/auth config and scanner state are ignored by Git. Imported profiles were allowlisted by file type, had personal model/provider overrides removed, and had one token-shaped demonstration value replaced by an explicit placeholder. A manifest records resulting hashes. This is a sanitized code snapshot, not an import of the original Git history or runtime state.

Before making the repository public: repeat the full-history scan, review the reference documents for private context and establish the rights to publish any third-party-derived material. Automated secret scanning reduces risk; it cannot prove that all sensitive information is absent. The original AIworld and saas-video repositories and their histories are not copied here.
