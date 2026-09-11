# Target Profile: Job Search / Career Platform

> Built from audits of Next.js-based job platforms with AI features (CV generation, analysis).
> Common stack: Next.js on Vercel + Supabase + NextAuth + Stripe + Anthropic Claude API.

## Attack Surface

| Component | What to Look For |
|-----------|-----------------|
| **Frontend** | Next.js App Router (Turbopack) on Vercel |
| **Backend** | Next.js API routes (server-side), 20+ routes |
| **Auth** | NextAuth/Auth.js (credentials + Google OAuth) |
| **Database** | Supabase (properly isolated server-side) |
| **Payments** | Stripe (web), Apple + RevenueCat (iOS) |
| **AI** | Anthropic Claude API (CV/cover letter generation) |
| **Mobile** | Capacitor wrapper |
| **APIs** | France Travail, La Bonne Alternance, Job-Room, Dropcontact |

## Top Findings

### 1. 🟠 RevenueCat API Key in Client Bundle (HIGH)
- API key hardcoded in client JS bundle
- Enables subscription/billing manipulation
- Common when same codebase serves web + mobile

### 2. 🟡 Source Maps Exposed (MEDIUM)
- 5 chunks with source maps (112-227KB each)
- Append `.map` to chunk URLs → full source code
- Facilitates frontend reverse engineering

### 3. 🟡 User Enumeration via Registration (MEDIUM)
- `/api/auth/register` returns different responses for existing vs new emails
- Enables account enumeration

### 4. 🟡 Security Headers Missing (MEDIUM)
- CSP, X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy
- All missing — low-hanging fruit

### 5. 🟡 Unauthenticated API Scraping (LOW)
- `/api/search` returns 163KB of job offers with PII
- Recruiter emails, phone numbers
- No auth or rate limiting

## Test Matrix

- [ ] Append `.map` to all JS chunk URLs for source maps
- [ ] Grep bundles for `pk_`, `rc_`, `sk_`, RevenueCat keys
- [ ] Test registration endpoint with existing vs non-existing emails
- [ ] Test search endpoints without auth
- [ ] Check all security headers (6+ should be present)
- [ ] Test Next.js API routes for auth enforcement
- [ ] Check for Capacitor mobile app vulnerabilities
- [ ] Test Anthropic API integration for prompt injection

## What's Usually Clean
- Supabase server-side isolation (key not in client bundle)
- NextAuth JWT (RS256, non-forgeable)
- Next.js API routes (generally well-protected server-side)
