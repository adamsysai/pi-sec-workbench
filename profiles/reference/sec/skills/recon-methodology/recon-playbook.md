# Recon Methodology: Full Playbook

> The complete recon pipeline. Run this on every new target before any exploitation.

## Phase 1: Passive Recon (15 min)

### DNS Enumeration
```bash
# Basic records
dig target.com A
dig target.com MX
dig target.com TXT
dig target.com NS
dig target.com CNAME

# Check for SPF/DKIM/DMARC
dig txt _dmarc.target.com

# Check for interesting subdomains via DNS
for sub in api app admin dev staging internal grafana auth cdn \
           docs mail vpn portal dashboard beta test preview; do
  ip=$(dig +short ${sub}.target.com A)
  [ -n "$ip" ] && echo "${sub}.target.com → $ip"
done
```

### Certificate Transparency (Subdomain Discovery)
```bash
# crt.sh — best single source for subdomains
curl -s "https://crt.sh/?q=%25.target.com&output=json" | jq -r '.[].name_value' | sort -u

# Expect: 5-25 subdomains for small SaaS, 100-500+ for enterprise
# Look for: dev, staging, internal, admin, grafana, api, auth, cdn
```

### WHOIS & OSINT
```bash
whois target.com
# Look for: registrar, creation date, registrant email, name servers
# Cross-reference email with GitHub, LinkedIn
```

### Tech Stack Identification
```bash
# Headers
curl -sI https://target.com

# Framework detection
curl -sI https://target.com | grep -i "x-powered-by\|x-nextjs\|server\|via\|x-vercel\|x-amz"
# Next.js: x-powered-by: Next.js, x-nextjs-prerender
# Vercel: x-vercel-id, x-vercel-cache
# Cloudflare: server: cloudflare, cf-ray
# AWS: x-amz-request-id
# Heroku: via: heroku-router
# Rails: x-runtime, x-request-id
```

### WAF/CDN Detection (CRITICAL — may need to skip)
```bash
# Cloudflare check
curl -sI https://target.com | grep -i "cloudflare\|cf-"
# If cf-mitigated: challenge → SKIP (or use CDP bypass)
# If just server: cloudflare → try anyway, might be DNS only

# Other WAFs
curl -sI https://target.com | grep -i "akamai\|sucuri\|imperva\|aws-waf"
```

## Phase 2: Active Recon (30 min)

### JS Bundle Download
```bash
# Extract all JS URLs from HTML
curl -s https://target.com | grep -oP 'src="[^"]+\.js"' | sed 's/src="//;s/"//'

# Download all chunks
mkdir -p chunks && cd chunks
for url in $(cat ../js_urls.txt); do
  curl -s "https://target.com${url}" -o "$(basename $url)"
done
```

### Source Map Check
```bash
# Append .map to every JS URL
for chunk in chunks/*.js; do
  code=$(curl -sI "https://target.com${chunk}.map" | head -1)
  echo "$code $chunk"
  # 200 = source map exists!
done
```

### Build Manifest Extraction (Next.js)
```bash
# Find build ID in HTML
BUILD_ID=$(curl -s https://target.com | grep -oP '__NEXT_DATA__.*?buildId":"[^"]+' | grep -oP '"[^"]+"$' | tr -d '"')

# Fetch build manifest
curl -s "https://target.com/_next/static/${BUILD_ID}/_buildManifest.js"
# Contains ALL API routes — 300+ routes possible
```

### SSR Payload Extraction
```bash
# Nuxt
curl -s https://target.com | grep -oP 'window\.__NUPTX__[^<]+' | head -c 5000

# Next.js
curl -s https://target.com | grep -oP '__NEXT_DATA__[^<]+' | head -c 5000

# SvelteKit
curl -s https://target.com | grep -oP '__sveltekit[^;]+;'

# App config
curl -s https://target.com | grep -oP '__APP_CONFIG__[^<]+'
```

### Sensitive File Probing
```bash
for file in .env .env.production .env.local .env.staging .env.bak .env.old \
            .git/HEAD .git/config .DS_Store backup.zip dump.sql \
            config.json docker-compose.yml package.json; do
  code=$(curl -sI "https://target.com/${file}" | head -1)
  echo "$code $file"
done
```

### API Discovery
```bash
# OpenAPI spec
curl -s https://target.com/openapi.json | jq '.paths | keys'
curl -s https://target.com/.well-known/api-catalog

# robots.txt
curl -s https://target.com/robots.txt

# Common API paths
for path in api/v1/status api/status api/config api/health \
            api/v1/users api/v1/me api/v1/settings api/v1/models; do
  code=$(curl -sI "https://target.com/${path}" | head -1)
  echo "$code $path"
done
```

## Phase 3: Cloud Storage Enumeration

### S3/GCS/R2/Firebase
```bash
# Guess bucket names
for name in target target-prod target-staging target-test target-ci \
           target-backup target-uploads target-public target-cdn \
           target-assets target-media target-private target-logs \
           target-app target-thumbnails target-data; do
  # S3
  code=$(curl -sI "https://${name}.s3.amazonaws.com/" | head -1)
  echo "S3: $code $name"
  # GCS
  code=$(curl -sI "https://storage.googleapis.com/${name}/" | head -1)
  echo "GCS: $code $name"
done

# Firebase
curl -s "https://target.firebaseio.com/.json"
curl -s "https://target.appspot.com/"
```

## Phase 4: GitHub Recon
```bash
# Find target's GitHub org
curl "https://api.github.com/search/users?q=company:target"

# List repos
curl "https://api.github.com/orgs/target-org/repos?per_page=100" | jq '.[].name'

# Scan for secrets (if repos found)
gitleaks detect --source . --no-git
trufflehog git file://. --no-update
```

## Phase 5: Account Creation & Auth Testing
```bash
# Create test account
curl -X POST https://target.com/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "test+audit@gmail.com", "password": "Test1234!"}'

# Analyze JWT
echo "[jwt_token]" | cut -d. -f2 | base64 -d 2>/dev/null | jq .
# Check: algorithm (HS256=crackable), expiry, claims, user_metadata
```

## Summary: What to Document

| Field | Value |
|-------|-------|
| Target type | SaaS AI video / crypto / analytics / etc. |
| Tech stack | Framework, backend, DB, cloud, payments |
| WAF/CDN | Cloudflare (skip?) / none / other |
| Subdomains | Count + interesting ones |
| JS chunks | Count + size |
| Source maps | Exposed? Count |
| Build manifest | Routes count |
| Secrets in bundle | List |
| Supabase/Firebase | Detected? Key extracted? |
| API endpoints | Count + auth status |
| Cloud storage | Buckets found |
| GitHub | Org found? Repos count |
| Account created | Success? Method? |
| JWT analysis | Algorithm, expiry, claims |
