# Target Profile: SaaS Analytics / E-Commerce Intelligence Platform

> Built from audits of analytics platforms, spy tools, e-commerce intelligence SaaS.
> Common stack: Next.js + NestJS/FastAPI + Supabase + Chrome extension + infrastructure tools.

## Attack Surface

| Component | What to Look For |
|-----------|-----------------|
| **Frontend** | Next.js App Router (RSC) on Vercel + Cloudflare |
| **Backend** | NestJS (Docker replicas), FastAPI spider service |
| **Database** | Supabase (PostgreSQL) — 129+ tables, 73+ RPCs via PostgREST |
| **Automation** | n8n, Apache Airflow, Kafka, Grafana, Prometheus, Squid proxy |
| **Extension** | Chrome extension published on Web Store with hardcoded credentials |
| **Storage** | Cloudflare R2 with Access Key ID exposed |
| **Subdomains** | 25+ via certificate transparency |

## Top Findings

### 1. 🔴 RLS Bypass on User Profiles (CRITICAL)
- 68,000+ profiles readable by any authenticated user
- Contains names, avatars, referral codes, Stripe promo codes
- Check `content-range` header to determine how many rows each query returns

### 2. 🔴 Chrome Extension Leaks Supabase Credentials (CRITICAL)
- Anon key, project ref, OAuth client IDs, GCP project number
- Cloud Run URL, PostHog API key — all in public extension code
- Download extension from Web Store → extract source

### 3. 🔴 Full DB Schema Exposed (CRITICAL)
- 129 tables, 73 RPCs, 1100+ columns via PostgREST OpenAPI spec
- Sensitive tables: `user_profiles`, `billing_customers`, `admin`, `authorized_ids`
- Error codes PGRST205 and 42703 leak table/column names

### 4. 🔴 Infrastructure Without Auth (CRITICAL)
- n8n 1.108.2 with 15+ CVEs (CVSS 10.0 file access, 9.9 RCE)
- Airflow exposed in HTTP, no auth, no rate limit
- Grafana default credentials (`admin/admin123`)
- Kafka webhook pipeline accepts arbitrary messages without auth

### 5. 🔴 IDOR on workspace_members (CRITICAL)
- Any user can INSERT into `workspace_members`
- Add themselves as admin/owner to any workspace
- No authorization check on the table

### 6. 🟠 JWT Metadata Injection (HIGH)
- Users can write arbitrary fields to `user_metadata` via `PUT /auth/v1/user`
- Propagated into signed JWT claims
- Any code checking `user_metadata.role` is vulnerable to privilege escalation
- Try: `role: "admin"`, `is_admin: true`

### 7. 🟠 SSRF via Media Download + Shopify Tools (HIGH)
- Media download endpoint fetches server-side URLs
- Shopify theme detector has SSRF (maps internal Docker networks)
- Internal IPs revealed: 172.18.0.x, 172.19.0.x

### 8. 🔴 PostHog Ingestion Endpoints Open (CRITICAL)
- 6 endpoints accept destructive commands (`$merge_dangerously`, `$identify` + `$set`/`$unset`)
- No rate limit
- CORS wildcard with credentials

## Test Matrix

- [ ] Fetch PostgREST OpenAPI spec: `/rest/v1/` with anon key
- [ ] Test RLS on every table: `curl /rest/v1/{table}?select=*&limit=5` with anon key
- [ ] Check `content-range` headers for row count estimation
- [ ] Download Chrome extension from Web Store → extract credentials
- [ ] Test `user_metadata` writability: `PUT /auth/v1/user` with `user_metadata: {"role": "admin"}`
- [ ] Check if JWT claims include `user_metadata` fields
- [ ] Scan for n8n: `GET /rest/settings` returns full config
- [ ] Scan for Airflow: check if HTTP (not HTTPS), test default login
- [ ] Scan for Grafana: test `admin/admin`, `admin/admin123`
- [ ] Test PostHog ingestion endpoints for destructive commands
- [ ] Test workspace_members INSERT for IDOR
- [ ] Call "admin" RPCs as regular user
- [ ] Check for Squid proxy exposure
- [ ] Enumerate all 25+ subdomains via crt.sh

## Exploit Chain: Extension → Supabase → Full DB Access
```
1. Download Chrome extension from Web Store
2. Extract Supabase anon key, project ref from extension source
3. Use anon key to query PostgREST API
4. Test RLS on all tables → 129 tables, 73 RPCs
5. Dump user_profiles (68K+ rows)
6. Access billing_customers table
7. Call admin RPCs as regular user
```

## Exploit Chain: JWT Metadata → Admin Escalation
```
1. Create account, get JWT
2. Decode JWT, check if user_metadata is in claims
3. PUT /auth/v1/user with body: {"data": {"role": "admin", "is_admin": true}}
4. Get new JWT with modified claims
5. Access admin endpoints that check user_metadata.role
```
