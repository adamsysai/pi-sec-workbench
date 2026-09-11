# Recon Methodology: Subdomain Enumeration

> Certificate transparency is the single best subdomain discovery tool.

## Technique 1: Certificate Transparency (crt.sh)

```bash
# crt.sh — primary source
curl -s "https://crt.sh/?q=%25.target.com&output=json" | jq -r '.[].name_value' | sort -u

# Expected results:
# Small SaaS: 5-25 subdomains
# Medium SaaS: 25-100 subdomains
# Enterprise/iGaming: 100-500+ subdomains
```

## Technique 2: DNS Brute Force

```bash
# Common subdomain wordlist
for sub in api app admin dev staging internal grafana auth cdn \
           docs mail vpn portal dashboard beta test preview \
           api-dev api-staging backend billing payments webhook \
           ws wss socket chat image video media assets static \
           blog shop store checkout oss ci cd jenkins gitlab \
           monitoring metrics prometheus alertmanager kibana \
           sonarqube argocd terraform consul vault nomad; do
  ip=$(dig +short ${sub}.target.com A 2>/dev/null)
  [ -n "$ip" ] && echo "${sub}.target.com → $ip"
done
```

## Technique 3: Search Engines

```bash
# Google dorking
# site:target.com -www
# site:target.com inurl:admin
# site:target.com inurl:api

# Shodan
# hostname:target.com
# org:"Target Company"
# ssl.cert.subject.CN:target.com
```

## What to Look For

| Subdomain | Interest Level | Why |
|-----------|---------------|-----|
| `dev.` / `staging.` / `preview.` | 🔴 HIGH | Weaker auth, different secrets, same backend |
| `api.` / `api2.` | 🟠 HIGH | Direct API access, may bypass WAF |
| `admin.` / `backoffice.` | 🟠 HIGH | Admin panel access |
| `internal.` | 🟠 HIGH | Internal services, monitoring |
| `grafana.` / `kibana.` | 🟠 HIGH | Monitoring dashboards |
| `n8n.` / `airflow.` | 🔴 HIGH | Automation tools, often unpatched |
| `ci.` / `jenkins.` | 🟠 HIGH | CI/CD, potential RCE |
| `auth.` / `login.` | 🟡 MEDIUM | Auth infrastructure |
| `cdn.` / `assets.` | 🟢 LOW | Static assets, usually safe |
| `blog.` / `docs.` | 🟢 LOW | Marketing content |

## Dev/Staging Environment Deep Dive

If dev/staging found:
```bash
# Compare with production
# Dev environments often have:
# - Weaker auth (no WAF, simpler tokens)
# - Different secrets (same structure, different values)
# - Debug mode enabled (stack traces, verbose errors)
# - Test data (but sometimes real data)
# - Same backend as prod (IDOR across environments)

# Download dev JS bundles
curl -s https://dev.target.com | grep -oP 'src="[^"]+\.js"'

# Compare secrets between dev and prod
grep "sk_live_" dev_chunks/*.js
grep "sk_live_" prod_chunks/*.js
# If dev has sk_live_ (secret key, not pk_live_) → CRITICAL
```
