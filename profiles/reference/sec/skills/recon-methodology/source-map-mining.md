# Recon Methodology: Source Map Mining

> Source maps expose full unminified source code. Found on 40% of SaaS targets.

## Detection

```bash
# Append .map to every JS chunk URL
for url in $(cat js_urls.txt); do
  code=$(curl -sI "https://target.com${url}.map" -o /dev/null -w "%{http_code}")
  [ "$code" = "200" ] && echo "SOURCE MAP: ${url}.map"
done
```

## Extraction

```python
import json, os, sys

# Parse source map JSON
with open('chunk.js.map') as f:
    sourcemap = json.load(f)

# Extract sourcesContent
sources = sourcemap.get('sources', [])
contents = sourcemap.get('sourcesContent', [])

for source, content in zip(sources, contents):
    if content:
        # Clean up webpack:// prefix
        path = source.replace('webpack://', '').replace('./', '')
        if 'node_modules' in path:
            continue  # Skip library code

        # Create directory structure
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(path, 'w') as out:
            out.write(content)
        print(f"Extracted: {path} ({len(content)} bytes)")
```

## What to Grep For

```bash
# API keys and secrets
grep -rn "sk_live_\|sk-ant-\|sk-or-\|AIza\|ghp_\|xox\|AKIA\|whsec_" extracted/

# Environment configuration
grep -rn "process.env\|NEXT_PUBLIC_\|VITE_\|SUPABASE_\|FIREBASE_" extracted/

# Internal URLs
grep -rn "internal\.\|staging\.\|dev\.\|admin\.\|grafana\." extracted/

# API routes
grep -rn "/api/\|/v1/\|/v2/" extracted/

# Auth configuration
grep -rn "jwt\|secret\|token\|password\|apiKey\|clientId" extracted/

# Feature flags
grep -rn "featureFlag\|isEnabled\|FEATURE_" extracted/

# Admin paths
grep -rn "admin\|backoffice\|dashboard\|management" extracted/
```

## Common Findings

| Finding | Frequency | Impact |
|---------|-----------|--------|
| Full source code (TypeScript/React) | 40% of targets | Complete app logic |
| API endpoint paths | Universal | Expanded attack surface |
| Environment variable names | Common | Reveals what secrets exist |
| Internal hostnames | Common | Infrastructure mapping |
| Admin route paths | Common | Access control testing |
| Feature flags | Common | Unreleased feature discovery |
| Third-party service keys | Common | Service-specific abuse |
| Comments with sensitive info | Sometimes | Developer hints, TODOs |

## Key Insight

One audit recovered **2,479 source files** from **72 source maps** on a single target. Source maps are the fastest path to complete application understanding — always check for them before deep-diving into minified bundles.
