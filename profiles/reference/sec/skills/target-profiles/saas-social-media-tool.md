# Target Profile: Social Media Management / OAuth Aggregator Platform

> Built from audits of social media scheduling tools, MCP-integrated platforms, OAuth aggregators.
> Common stack: REST API + MCP server + Supabase + OAuth integrations + Cloudflare/Vercel.

## Attack Surface

| Component | What to Look For |
|-----------|-----------------|
| **API** | REST (32+ endpoints), MCP server (71+ tools), Swagger/OpenAPI at `/docs` |
| **Backend** | Supabase (primary + secondary), webhook system |
| **OAuth** | 7+ social platforms (Instagram, YouTube, TikTok, X/Twitter, WhatsApp, Telegram) |
| **Media** | Upload/processing pipeline (URL fetch + storage) |
| **MCP** | Model Context Protocol server with broadcast, ad management, comment automation tools |

## Top Findings

### 1. 🔴 Supabase RLS Completely Disabled (CRITICAL)
- Anon key allows full read/write/modify/delete on ALL tables
- OAuth access tokens stored in plaintext (19+ tokens across 7 platforms)
- Tables exposed: profiles, customers, OAuth tokens, post targets, webhooks

### 2. 🔴 CORS Wildcard on Authenticated Endpoints (CRITICAL)
- `Access-Control-Allow-Origin: *` on all API endpoints
- Enables cross-origin credential theft from any website

### 3. 🔴 OAuth State Parameter Forgeable (HIGH)
- State is base64-encoded JSON with no HMAC signature
- Attacker can forge state to bind their social account to victim's profile
- Results in CSRF account takeover

### 4. 🔴 PKCE Code Verifier Leakage (HIGH)
- X/Twitter OAuth flow leaks `code_verifier` in the state parameter
- Attacker intercepts authorization code and exchanges for tokens

### 5. 🟠 OAuth Dynamic Client Registration Unauthenticated (HIGH)
- `/oauth/register` accepts arbitrary client registration
- Attacker creates rogue OAuth client with attacker-controlled redirect URIs
- Enables code interception attacks

### 6. 🟠 SSRF via MCP Tools (HIGH)
- `upload_media` tool fetches server-side URLs
- `http://localhost:3000/` returns internal service responses
- IPv6 reachable: `http://[::1]:3000/`
- AWS metadata partially blocked but worth testing

### 7. 🔴 Media Files Without Auth (CRITICAL)
- `/v1/media/file/{filename}` serves files without ownership verification
- Any user's uploaded media accessible by filename

## Test Matrix

- [ ] Extract Supabase anon key → test RLS on ALL tables (read AND write)
- [ ] Test CORS: send `Origin: https://evil.com` → check `Allow-Credentials: true`
- [ ] Analyze OAuth state parameter: is it HMAC-signed or just base64 JSON?
- [ ] Check PKCE flow: is `code_verifier` in client-visible state?
- [ ] Test `/oauth/register` for unauthenticated DCR
- [ ] Fetch `/docs` or `/swagger` for OpenAPI spec
- [ ] Enumerate MCP tools via `tools/list`
- [ ] Test SSRF on `upload_media` and similar URL-fetch tools
- [ ] Test media file access without auth: `/v1/media/file/{filename}`
- [ ] Check webhook creation for arbitrary URL acceptance
- [ ] Test `connect_account_manually` for arbitrary token acceptance
- [ ] Check `/.well-known/oauth-authorization-server`

## Exploit Chain: OAuth State Forgery → Account Takeover
```
1. Decode OAuth state parameter (base64 JSON)
2. Craft state with victim's profileId
3. Initiate OAuth flow with attacker's social account
4. Callback binds attacker's social to victim's profile
5. Attacker now has access to victim's social media via platform
```
