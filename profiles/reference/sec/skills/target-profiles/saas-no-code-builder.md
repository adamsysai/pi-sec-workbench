# Target Profile: SaaS No-Code / App Builder Platform

> Built from audits of AI-powered app builders, website generators, and no-code platforms.
> Common stack: React/Remix frontend + Firebase/Supabase backend + Stripe + cloud storage.

## Attack Surface

| Component | What to Look For |
|-----------|-----------------|
| **Frontend** | React/Remix (3.6MB+ bundles), Vite, SSR data loading |
| **Backend** | Firebase Auth, Supabase, OIDC provider for sandboxes |
| **Abuse Detection** | Castle.io (client-side, bypassable via SSR) |
| **Code Execution** | Sandbox/preview environments, code execution containers |
| **Admin** | Admin endpoints (often 17+ discovered, usually 403) |

## Top Findings

### 1. 🟠 IDOR via Profile API (MEDIUM)
- `/profile/{username}` returns user data (UID, display name, bio, social links) without auth
- 43+ profiles enumerated in one audit
- Username-based path params are prime IDOR targets

### 2. 🟠 Framework-Specific Security Bypass (MEDIUM)
- Remix SSR loads data before client-side bot detection executes
- Castle.io and similar client-side abuse detection bypassed
- Next.js SSR has similar pattern: RSC payload loads before client JS

### 3. 🟡 Supabase Publishable Key Leaked (MEDIUM)
- Key embedded in deployed JS bundle (by design for Supabase)
- If RLS is missing → full database access
- Check all tables for RLS policies

### 4. 🟡 Admin Endpoint Discovery (LOW)
- 17+ admin endpoints discovered via bundle analysis
- All properly return 403 (well-secured)
- But endpoint names reveal internal architecture

### 5. 🟡 Beta/Preview Subdomain Username Enumeration (LOW)
- Preview subdomains follow predictable patterns
- Reveal team member usernames
- Enable targeted phishing or account takeover

## Test Matrix

- [ ] Mine JS bundle for API keys, internal hostnames, feature flags
- [ ] Test profile endpoints with username path params (IDOR)
- [ ] Check if framework SSR bypasses client-side security tools
- [ ] Extract Supabase anon key → test RLS on all tables
- [ ] Enumerate admin endpoints from bundle (even if 403)
- [ ] Check preview/beta subdomains for username leaks
- [ ] Test Castle.io / bot detection bypass via SSR
- [ ] Check OIDC provider configuration
- [ ] Test sandbox/preview environments for code execution abuse

## What's Usually Clean
- Admin endpoints (properly 403)
- Firebase API keys (public by design)
- Stripe publishable keys (public by design)
