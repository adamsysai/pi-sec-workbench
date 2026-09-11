# Target Profile: SaaS AI API Gateway / LLM Router

> Built from audits of AI API marketplaces, LLM routers, and pay-as-you-go model platforms.
> Common stack: OpenAI-compatible API + admin panel + Stripe + cloud storage + 1000+ models.

## Attack Surface

| Component | What to Look For |
|-----------|-----------------|
| **Frontend** | Next.js App Router, Vite, build commit hash in HTML |
| **Backend** | Open-source forks (one-api/new-api), Go gateways, Node.js API routes |
| **API** | OpenAI-compatible relay `/v1/*`, admin `/api/*` (channels, users, tokens) |
| **Auth** | Session cookies (HS256 JWT, 400-day expiry), API keys (`sk-` format) |
| **Storage** | Cloudflare R2 (presigned URLs), S3 |
| **Payments** | Stripe (subscription + balance), nano crypto deposits |
| **Features** | BYOK (bring your own key), web scraping, browser extension, document processing |
| **Upstream** | AWS Bedrock, OpenAI, Vertex AI, Anthropic, Replicate |

## Top Findings

### 1. 🟡 Storage Presign Leaks R2 Access Key ID (MEDIUM)
- Presigned URLs contain `X-Amz-Credential` with R2 Access Key ID
- Bucket name also exposed in URL path
- **Impact**: Key ID is semi-public, but enables targeted attacks if secret is also leaked

### 2. 🟡 SSRF Surface on Media/Document Endpoints (MEDIUM)
- `/api/media/remote-fetch`, `/api/drive/import`, `/api/process-document` accept URLs
- URL validation exists but SSRF surface remains for bypass testing
- Test `file://`, `localhost`, AWS metadata URLs

### 3. 🟠 Sensitive Config Leak via `/api/status` (MEDIUM)
- Public endpoint returns: Turnstile sitekey, OAuth client IDs, GCS bucket name, pricing, exchange rates, feature flags, smart routing presets
- Test/staging instances exposed with default config and seed data

### 4. 🟠 API Key Scoping Issues (MEDIUM)
- Relay keys (`sk-`) must be scoped to relay-only
- Admin surface must require separate session auth
- Test: can `sk-` key access `/api/*` admin endpoints?

### 5. 🔴 BYOK Key Storage (HIGH — potential)
- User-supplied API keys stored server-side
- Test if BYOK keys are accessible to other users
- Check if BYOK endpoints are accessible without balance

## Test Matrix

- [ ] Extract R2 access key ID from presigned URLs
- [ ] Test SSRF on all URL-accepting endpoints
- [ ] Fetch `/api/status` for config leaks
- [ ] Test API key scoping: relay vs admin
- [ ] Check for test/staging instances via CT logs
- [ ] Test BYOK endpoints without balance
- [ ] Check session JWT algorithm and expiry
- [ ] Look for open-source backend forks → check known CVEs
- [ ] Test OpenAPI spec at `/openapi.json`, `/.well-known/api-catalog`
- [ ] Compare documented endpoints vs SDK source → find undocumented endpoints

## What's Usually Clean
- Bundle JS secret scanning (well-built platforms keep secrets server-side)
- Turnstile when properly configured (blocks critical path)
- Admin endpoints (require session auth, not API key)
