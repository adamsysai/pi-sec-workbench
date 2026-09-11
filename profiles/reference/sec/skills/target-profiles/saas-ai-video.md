# Target Profile: SaaS AI Video Generation Platform

> Built from 7+ real audits of platforms doing text-to-video, avatar generation, AI content creation.
> Common stack: Next.js/Vue/Nuxt frontend + Java/Node/Python backend + cloud storage + Stripe + AI providers.

## Attack Surface

| Component | What to Look For |
|-----------|-----------------|
| **Frontend** | Next.js build manifests (`_buildManifest.js`), Vue/Nuxt SSR payloads (`window.__NUXT__`), SvelteKit inline config |
| **Backend** | gRPC-Web/Connect JSON gateways, Spring Boot Actuator, Node.js API routes, FastAPI |
| **Storage** | S3 presigned URLs, GCS buckets, Cloudflare R2, Firebase Storage |
| **Auth** | WorkOS opaque tokens, Supabase JWTs, Firebase Auth, hex tokens, HS256 JWTs |
| **Payments** | Stripe (live keys in bundles), Cryptomus, Paystack, USDT TRC20 |
| **AI Providers** | Replicate, fal.ai, OpenAI, Google Vertex, ByteDance Doubao, ElevenLabs, MiniMax |
| **Infrastructure** | Cloud Run, EC2, Vercel, n8n, Airflow, Grafana, Kafka |

## Top 5 Findings (By Frequency)

### 1. 🔴 Credit/Billing Manipulation (CRITICAL — 4/7 targets)
- **Negative integer injection**: `generateCount: -5000` → negative credits → balance increases
- **Anonymous temp user farming**: `/gen-temp-user` endpoint creates accounts with free credits, no CAPTCHA/rate limit
- **Payment webhook bypass**: Webhook accepts `{"handle": "any"}` without signature verification → marks user as paid
- **Paid model bypass**: `paidRequired` check evaluates `requiredCredits > 0`, so negative credits bypass paywall

### 2. 🔴 SSRF via Server-Side URL Fetch (CRITICAL — 5/7 targets)
- **Image/video import**: Endpoints that fetch user-supplied URLs and re-upload to public storage
- **imgproxy chains**: SVG upload → imgproxy render → SSRF/XXE via `<image href="file:///etc/passwd">`
- **Cloud metadata**: Server has IAM role → fetch `metadata.google.internal` → extract service account tokens
- **Internal service reachability**: Billing service, Stripe webhook, internal APIs reachable via SSRF

### 3. 🔴 IDOR / Missing Authorization (HIGH — 5/7 targets)
- **Community workspace abuse**: `workspaceId=00000000-...` grants access to other users' data
- **UUID v1 enumeration**: Timestamp-based UUIDs allow adjacent brute-force
- **Missing ownership checks**: Poll/status endpoints return data without verifying UUID ownership
- **Sequential IDs**: User/workspace IDs are sequential, enabling enumeration

### 4. 🟠 Cloud Credential Exposure (HIGH — 5/7 targets)
- **Presigned URL credential extraction**: `X-Amz-Credential` leaks AWS Access Key ID, `X-Goog-Credential` leaks GCP service account email
- **STS token over-scoping**: Session policy allows `s3:GetObject` on entire prefix, not just user's
- **R2 Access Key ID**: Cloudflare R2 presigned URLs leak access key IDs
- **S3 cross-user read**: STS credentials allow reading other users' generated content

### 5. 🟠 Information Disclosure (HIGH — 7/7 targets)
- **Stripe live keys in JS bundles**: `pk_live_*` found in 4/5 deep-scanned targets
- **SSR config leaks**: `window.__NUXT__.config.public` contains antibot secrets, API URLs, OAuth client IDs
- **Build manifests**: `_buildManifest.js` exposes all API routes including admin endpoints
- **Proto schema reconstruction**: `FileDescriptorProto` base64 in JS chunks → full gRPC schema
- **Source maps**: Append `.map` to JS chunk URLs → full unminified source code

## Test Matrix (Priority Order)

### Phase 1: Recon (30 min)
- [ ] Download ALL JS chunks from `/_next/static/chunks/` or equivalent
- [ ] Check for source maps (append `.map` to every JS URL)
- [ ] Grep for: `sk_live`, `pk_live`, `AIza`, `eyJhbGc`, `supabase`, `AKIA`, `ghp_`, `xox`, `secret`, `key`
- [ ] Extract build manifest → map all API routes
- [ ] Check for SSR payload: `window.__NUXT__`, `__NEXT_DATA__`, `__APP_CONFIG__`
- [ ] Enumerate subdomains via crt.sh
- [ ] Check for dev/staging environments (dev., staging., preview., internal.)

### Phase 2: Auth & Access Control (30 min)
- [ ] Create account → analyze JWT (algorithm, expiry, claims, user_metadata writability)
- [ ] Test IDOR on all endpoints with sequential/UUID identifiers
- [ ] Check community/shared workspace IDs (00000000-...)
- [ ] Test mass assignment (try `role: "admin"`, `is_admin: true`, `credits: 99999`)
- [ ] Test CORS with credentials (send `Origin: https://evil.com` → check `Access-Control-Allow-Credentials: true`)
- [ ] Check if `user_metadata` is user-writable and propagated into JWT claims

### Phase 3: Credit & Billing (20 min)
- [ ] Test negative values on `generateCount`, `credits`, `quantity` parameters
- [ ] Check for temp/anonymous user creation without CAPTCHA/rate limit
- [ ] Test payment webhook for signature verification
- [ ] Check if `paidRequired` or similar guards use `> 0` comparison (bypassable with negatives)
- [ ] Test Stripe checkout session creation with leaked `pk_live` key

### Phase 4: SSRF Surface (20 min)
- [ ] Find all endpoints that accept URLs (import, fetch, proxy, webhook, upload from URL)
- [ ] Test with: `http://localhost`, `http://127.0.0.1`, `http://vcap.me` (resolves to 127.0.0.1)
- [ ] Test cloud metadata: `http://metadata.google.internal/computeMetadata/v1/` (with `Metadata-Flavor: Google` header)
- [ ] Test AWS metadata: `http://169.254.169.254/latest/meta-data/`
- [ ] Test IPv6: `http://[::1]:3000/`
- [ ] Check if SSRF response is stored/retrievable (full-read SSRF)

### Phase 5: Storage & Cloud (15 min)
- [ ] Extract AWS/R2/GCP access key IDs from presigned URLs
- [ ] Test STS credentials for over-scoped permissions
- [ ] Enumerate storage buckets (S3, GCS, R2, Firebase)
- [ ] Check for public bucket listing
- [ ] Test file upload extension validation (try .svg, .html, .js)

### Phase 6: LLM/AI Specific (15 min)
- [ ] Check if LLM endpoints accept `role: "system"` from client
- [ ] Attempt system prompt extraction
- [ ] Test inference endpoints without credits/balance
- [ ] Check for model name leakage in error messages
- [ ] Test API key scoping (can relay key access admin endpoints?)

## Exploit Chains

### Chain 1: Bundle → Anon Key → RLS Bypass → DB Dump
```
1. Extract Supabase anon key from JS bundle
2. Grep bundle for .from("table_name") patterns
3. Query /rest/v1/{table}?select=*&limit=5 with anon key
4. If 200 → RLS disabled → dump all tables
5. Test INSERT/UPDATE/DELETE (some RLS only protect SELECT)
```

### Chain 2: Negative Credits → Free Premium Generation
```
1. Create account, find generation endpoint
2. Send generateCount: -5000 in request body
3. Server calculates requiredCredits = -10000
4. Balance increases by 10000
5. Use credits for premium models (Sora, Veo) for free
```

### Chain 3: SSRF → Cloud Metadata → Credential Theft
```
1. Find URL-fetch endpoint (image import, media download)
2. Provide URL: http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token
3. Add header: Metadata-Flavor: Google
4. Extract service account access token
5. Use token to access cloud resources (GCS, Cloud Run, etc.)
```

### Chain 4: SVG Upload → XXE → File Read → OCR Exfiltration
```
1. Get presigned S3 upload URL
2. Upload SVG with XXE payload: <!ENTITY xxe SYSTEM "file:///etc/passwd">
3. Trigger imgproxy render with format:png
4. If rendered PNG contains file contents → OCR to extract text
5. Alternative: SVG <image href="https://webhook.site/..."> for OOB confirmation
```

### Chain 5: Payment Webhook → Free Service
```
1. Find payment webhook endpoint (often on old/separate backend)
2. POST {"handle": "victim_username"} without signature
3. Server returns 204 → user marked as paid
4. Access premium features without payment
```

## What's Usually Clean
- OpenAI/Anthropic API keys (usually server-side only, 1/7 leaked)
- Admin endpoints in well-built platforms (403 properly enforced)
- Auth0/Clerk JWTs (RS256, non-forgeable)
- S3 write access (usually properly denied)
- Source maps on main app (marketing site may still expose them)
