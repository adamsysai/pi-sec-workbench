# Recon Methodology: API Discovery

> How to enumerate all API endpoints on a target.

## Technique 1: Build Manifest (Next.js)

```bash
# Find build ID
BUILD_ID=$(curl -s https://target.com | grep -oP '"buildId":"[^"]+' | cut -d'"' -f3)

# Fetch build manifest — contains ALL routes
curl -s "https://target.com/_next/static/${BUILD_ID}/_buildManifest.js"
# Can reveal 300+ routes including admin endpoints
```

## Technique 2: OpenAPI Spec

```bash
# Standard locations
curl -s https://target.com/openapi.json
curl -s https://api.target.com/openapi.json
curl -s https://target.com/.well-known/api-catalog
curl -s https://target.com/swagger.json
curl -s https://target.com/api-docs
curl -s https://target.com/docs
```

## Technique 3: JS Bundle Grep

```bash
# Extract API paths from JS bundles
grep -rn '/api/' chunks/ | grep -oP '/api/[a-z0-9/_-]+' | sort -u
grep -rn '/v1/' chunks/ | grep -oP '/v1/[a-z0-9/_-]+' | sort -u
grep -rn '/v2/' chunks/ | grep -oP '/v2/[a-z0-9/_-]+' | sort -u

# tRPC procedures
grep -rn 'trpc\.' chunks/ | grep -oP 'trpc\.[a-z0-9_.]+' | sort -u

# GraphQL
grep -rn 'graphql\|gql' chunks/
```

## Technique 4: SDK Source Diff

```bash
# Compare documented API vs SDK methods
# SDK usually has 30-50% more endpoints than docs
diff <(grep -oP '/v[12]/[^"'\'']+' openapi.json | sort -u) \
     <(grep -oP '/v[12]/[^"'\'']+' sdk-source/ | sort -u)
```

## Technique 5: Status Code Differentiation

```bash
# Map endpoints by status code
# 401 = exists, needs auth
# 403 = exists, forbidden
# 404 = doesn't exist
# 400 = exists, bad request
# 405 = exists, wrong method

for path in admin users settings billing payments webhooks \
            internal debug test health status config; do
  code=$(curl -sI "https://target.com/api/${path}" | head -1)
  echo "$code /api/${path}"
done
```

## Technique 6: Auth Level Comparison

```bash
# Test same endpoints with different auth levels
# 1. No auth
# 2. Guest session
# 3. Authenticated user
# 4. Admin (if obtainable)

# Endpoints that respond differently across auth levels are interesting
for endpoint in $(cat endpoints.txt); do
  no_auth=$(curl -sI "https://target.com${endpoint}" -o /dev/null -w "%{http_code}")
  auth=$(curl -sI "https://target.com${endpoint}" -H "Authorization: Bearer [token]" -o /dev/null -w "%{http_code}")
  echo "$no_auth → $auth: $endpoint"
done
```

## Technique 7: PostgREST Schema Disclosure (Supabase)

```bash
# OpenAPI spec
curl "https://[project].supabase.co/rest/v1/" \
  -H "apikey: [anon_key]" | jq '.paths | keys'

# Error-based table discovery
curl "https://[project].supabase.co/rest/v1/nonexistent" \
  -H "apikey: [anon_key]"
# PGRST205: "Perhaps you meant 'profiles'?" → reveals table names

# Column discovery
curl "https://[project].supabase.co/rest/v1/profiles?select=nonexistent" \
  -H "apikey: [anon_key]"
# 42703: column "nonexistent" does not exist → reveals valid columns
```

## Technique 8: gRPC-Web / Connect JSON

```bash
# Extract proto schemas from JS chunks
grep -rn "FileDescriptorProto\|google.protobuf" chunks/
# Decode base64 proto descriptor
echo "[base64_proto]" | base64 -d | protoc --decode_raw

# Send Connect JSON requests
curl -X POST https://target.com/api/v1/Service/Method \
  -H "Content-Type: application/json" \
  -H "Connect-Protocol-Version: 1" \
  -d '{}'
```

## Technique 9: WebSocket Discovery

```bash
# Check for WebSocket endpoints
grep -rn 'ws://\|wss://' chunks/

# Connect without auth (often skips auth)
wscat -c wss://target.com/ws
```
