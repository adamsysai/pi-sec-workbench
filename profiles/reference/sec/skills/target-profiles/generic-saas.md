# Target Profile: Generic SaaS (Unknown Type)

> Catch-all profile for when target type is unknown or doesn't match a specific profile.
> Full checklist covering all common SaaS attack surfaces.

## Quick Identification

| Signal | Likely Type | Load Profile |
|--------|-------------|--------------|
| AI video, text-to-video, avatar | saas-ai-video.md | + SSRF, credits, inference |
| LLM marketplace, model router | saas-ai-api-gateway.md | + API key scoping |
| App builder, no-code | saas-no-code-builder.md | + Supabase, templates |
| Social media scheduler, OAuth | saas-social-media-tool.md | + OAuth chain |
| Analytics, spy tool | saas-analytics-ecommerce.md | + Supabase, extension |
| Crypto exchange, trading | crypto-exchange.md | + API key perms |
| DeFi, lending, AMM | defi-protocol.md | + Oracle, reentrancy |
| Casino, slots, gaming | igaming-casino.md | + Spring Boot, RTP |
| Job board, career | job-platform.md | + Source maps, PII |

## Universal Test Checklist

### Phase 1: Recon (Always)
- [ ] DNS enumeration (A, MX, TXT, NS, CNAME)
- [ ] Subdomain enumeration via crt.sh
- [ ] Tech stack identification (headers, JS frameworks, cookies)
- [ ] WAF/CDN detection (Cloudflare? Skip if `cf-mitigated: challenge`)
- [ ] Download ALL JS chunks
- [ ] Check for source maps (`.map` suffix)
- [ ] Grep JS for: `sk_live`, `pk_live`, `AIza`, `eyJhbGc`, `supabase`, `AKIA`, `ghp_`, `xox`, `whsec_`, `secret`, `key`, `token`
- [ ] Check for SSR payloads: `window.__NUXT__`, `__NEXT_DATA__`, `__APP_CONFIG__`
- [ ] Find build manifests (`_buildManifest.js` for Next.js)
- [ ] Sensitive files: `.env`, `.git/HEAD`, `.DS_Store`, `backup.zip`, `config.json`, `docker-compose.yml`
- [ ] Check for dev/staging subdomains

### Phase 2: Auth (Always)
- [ ] Create account → analyze JWT (alg, expiry, claims)
- [ ] Test JWT for: alg:none, HS256 with weak secret, alg confusion
- [ ] Check if `user_metadata` is user-writable (Supabase)
- [ ] Test mass assignment (role, isAdmin, credits, balance)
- [ ] Test registration for user enumeration
- [ ] Check password reset for user enumeration
- [ ] Test OAuth state parameter (HMAC or base64?)
- [ ] Check PKCE flow for code_verifier leakage

### Phase 3: Access Control (Always)
- [ ] Test IDOR on all endpoints with IDs (sequential, UUID)
- [ ] Check community/shared workspace IDs (00000000-...)
- [ ] Test admin endpoints (even if 403, note their existence)
- [ ] Check if UUID v1 (timestamp-based, enumerable)

### Phase 4: SSRF (If URL-fetch endpoints exist)
- [ ] Find all endpoints accepting URLs
- [ ] Test: `http://localhost`, `http://127.0.0.1`, `http://vcap.me`
- [ ] Test cloud metadata: `http://metadata.google.internal/` (GCP), `http://169.254.169.254/` (AWS)
- [ ] Test IPv6: `http://[::1]:3000/`
- [ ] Test `file://` protocol
- [ ] Check if response is stored (full-read SSRF)

### Phase 5: Cloud & Storage (If cloud infra detected)
- [ ] Extract access key IDs from presigned URLs (`X-Amz-Credential`, `X-Goog-Credential`)
- [ ] Enumerate S3/GCS/R2 buckets
- [ ] Test for public bucket listing
- [ ] Check STS credentials for over-scoping
- [ ] Check Firebase Storage rules

### Phase 6: Payments (If Stripe/payment integration detected)
- [ ] Check for `sk_live` (secret key — CRITICAL if found)
- [ ] Check for `pk_live` (publishable — public by design, not reportable)
- [ ] Test payment webhook for signature verification
- [ ] Test for negative integers in billing/credit parameters
- [ ] Check for free trial/credit farming without CAPTCHA

### Phase 7: Platform-Specific
- [ ] **Supabase**: Extract anon key → test RLS on all tables → check PostgREST OpenAPI spec
- [ ] **Firebase**: Check Firestore rules → test Storage rules → check for anonymous auth
- [ ] **Vercel**: Check for exposed `.env` → check for source maps → test Vercel WAF bypass
- [ ] **WordPress**: Check REST API (`/wp-json/wp/v2/users`) → test for user enumeration
- [ ] **Spring Boot**: Test Actuator endpoints → URL-encode bypass → heapdump
- [ ] **n8n**: Check `/rest/settings` for config → check version for CVEs
- [ ] **Grafana**: Test default credentials (`admin/admin`)
- [ ] **Strapi**: Check for open registration → test CORS

### Phase 8: LLM/AI (If AI features detected)
- [ ] Check if LLM endpoints accept `role: "system"` from client
- [ ] Attempt system prompt extraction
- [ ] Test inference without credits/balance
- [ ] Check for model name leakage in errors

## Cloudflare WAF Detection (Skip Rule)

If ANY of these indicators are present, the target is behind Cloudflare WAF:
- `server: cloudflare` header
- `cf-ray` header
- `cf-mitigated: challenge` header
- `__cf_bm` cookie (bot management)
- Cloudflare nameservers

**Action**: Skip automated scanning. Requires CDP/browser-based approach to solve JS challenge and obtain `cf_clearance` cookie.

## Priority Order (When Time-Limited)
1. JS bundle mining (highest yield, 30 min)
2. Supabase/Firebase RLS testing (if detected — instant DB access)
3. SSRF surface identification + testing
4. IDOR on primary resources
5. Credit/billing manipulation
6. OAuth misconfiguration
7. CORS with credentials
8. Storage credential leaks
9. Payment webhook bypass
10. Infrastructure exposure
