# Target Profile: iGaming / Online Casino Platform

> Built from audits of enterprise iGaming platforms with live casino, slots, and sports betting.
> Common stack: Java/JSP on EKS + Spring Boot microservices + Strapi CMS + WordPress + multi-region infra.

## Attack Surface

| Component | What to Look For |
|-----------|-----------------|
| **Backend** | Java/JSP on Amazon EKS (Kubernetes), Spring Boot microservices, WebLogic |
| **CMS** | Strapi (2+ instances, check registration), WordPress (4+ instances, 237+ REST routes) |
| **Secrets** | HashiCorp Vault for secrets management |
| **Data** | PostgreSQL, Redis, RabbitMQ (multi-region EU/Asia), Kafka (Amazon MSK) |
| **Streaming** | HLS video streaming, WebSocket feeds |
| **DevOps** | Grafana, ArgoCD, Jenkins, SonarQube, Metabase |
| **Subdomains** | 500+ via certificate transparency |
| **Access** | Gravitational Teleport for remote access |
| **WAF** | CloudFront + Cloudflare CDN |

## Top Findings

### 1. 🔴 Spring Boot Actuator Heapdump (CRITICAL — CVSS 10.0)
- `/actuator/heapdump` accessible via WAF bypass
- **WAF bypass technique**: URL-encode first letter: `/actuator/%68eapdump`
- CloudFront WAF matches literal string; Spring Boot decodes URL-encoded chars
- 958MB heapdump contains: PostgreSQL credentials, Kafka/RabbitMQ tokens, Redis keys, JWT HS512 secret, active player sessions, **full Vault secrets dump in cleartext**

### 2. 🔴 HashiCorp Vault Complete Dump (CRITICAL)
- Vault client caches ALL secrets in JVM heap as JSON
- Heapdump analysis reveals complete credentials tree
- Contains: PostgreSQL creds, RabbitMQ creds, Vault token, RGS shared secret, 200+ internal proxy URLs, Kafka MSK brokers
- No need to access Vault directly — it's all in memory

### 3. 🔴 Unauthenticated Prize Drop Injection (CRITICAL)
- `POST /api/promo/prizeDropWin` on all 8 production game servers
- Requires no authentication
- Accepts arbitrary prize injection (errorCode 0 = success)
- Can inject winnings to any player account

### 4. 🔴 RTP Configuration Exposed (CRITICAL)
- Return to Player percentage is operator-configurable
- 3-tier discrimination confirmed (94%, 92%, lower)
- Can be modified to rig games

### 5. 🔴 Strapi Open Registration + CORS (CRITICAL)
- 2 production Strapi CMS instances with open registration
- CORS reflects any origin with `Access-Control-Allow-Credentials: true`
- Chain: Register account → CORS exploit → full CMS takeover

### 6. 🟠 WebLogic Deserialization RCE (HIGH)
- WSAT and AsyncResponseService active on all 8 game servers
- CVE-2017-10271 / CVE-2019-2725
- Java deserialization functional via `/api/promo/` endpoints

### 7. 🟠 JWT Forgery with Leaked Secret (HIGH)
- JWT HS512 secret found in heapdump (e.g., `"mySecret"`)
- Forge player JWT with arbitrary claims (operator, casino, player ID)
- Authenticate as any player/operator

## Test Matrix

### Phase 1: Infrastructure Recon
- [ ] Certificate transparency: expect 500+ subdomains
- [ ] Identify all EKS clusters, game servers, Strapi/WordPress instances
- [ ] Find Grafana, ArgoCD, Jenkins, SonarQube, Metabase instances
- [ ] Check for Gravitational Teleport exposure
- [ ] Map all S3 buckets

### Phase 2: Spring Boot Actuator
- [ ] Test `/actuator/heapdump` directly (likely blocked by WAF)
- [ ] Test `/actuator/%68eapdump` (URL-encoded bypass)
- [ ] Test `/%61%63%74%75%61%74%6f%72/%68%65%61%70%64%75%6d%70` (full encoding)
- [ ] Test `/actuator/threaddump` (also valuable: 1.4MB reveals infra)
- [ ] Test `/actuator/env`, `/actuator/beans`, `/actuator/prometheus`
- [ ] If heapdump obtained: extract with `jmap`/`jhat`/Eclipse MAT

### Phase 3: Game Server Abuse
- [ ] Test `POST /api/promo/prizeDropWin` without auth
- [ ] Test RTP configuration endpoints
- [ ] Check WebLogic endpoints for deserialization CVEs
- [ ] Test admin portal without auth
- [ ] Check all 8+ production game servers

### Phase 4: CMS Exploitation
- [ ] Check Strapi instances for open registration
- [ ] Test Strapi CORS with credentials
- [ ] Check WordPress REST API (237+ routes)
- [ ] Test Strapi host header injection on password reset

### Phase 5: Credential Extraction (if heapdump obtained)
- [ ] Extract HikariCP connection pool → PostgreSQL credentials
- [ ] Extract Vault token → access Vault directly
- [ ] Extract Kafka broker URLs and consumer groups
- [ ] Extract RabbitMQ credentials (4 multi-region servers)
- [ ] Extract Redis keys
- [ ] Extract JWT HS512 secret → forge tokens
- [ ] Extract 200+ internal proxy URLs
- [ ] Extract active player session tokens

## Exploit Chain: WAF Bypass → Heapdump → Full Compromise
```
1. Find Spring Boot Actuator behind CloudFront WAF
2. Bypass WAF: /actuator/%68eapdump (URL-encode first letter)
3. Download 958MB heapdump
4. Analyze with Eclipse MAT / jhat
5. Extract Vault secrets cache (all production credentials)
6. Extract JWT HS512 secret ("mySecret")
7. Forge admin/player JWT tokens
8. Access all game servers, databases, Kafka, RabbitMQ
9. Inject prizes via /api/promo/prizeDropWin
10. Modify RTP configuration
```

## What's Usually Clean
- Nothing. iGaming platforms are notoriously over-complex with weak per-component security.
- The complexity IS the vulnerability — 500+ subdomains means something is misconfigured.
