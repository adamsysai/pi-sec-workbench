# Recon Methodology: Cloud Storage Enumeration

> S3, GCS, R2, Firebase buckets are consistently misconfigured.

## S3 Bucket Enumeration

```bash
# Common bucket naming patterns
for name in target target-prod target-staging target-test target-ci \
           target-backup target-uploads target-public target-cdn \
           target-assets target-media target-private target-logs \
           target-app target-thumbnails target-data target-screenshots \
           target-reports target-exports target-files target-images \
           target-videos target-audio; do

  # Path-style
  code=$(curl -sI "https://${name}.s3.amazonaws.com/" | head -1)
  echo "$code $name"

  # Virtual-hosted style
  code=$(curl -sI "https://s3.amazonaws.com/${name}/" | head -1)
  echo "$code $name (vhost)"
done

# Response codes:
# 200 = bucket exists AND listing is public (CRITICAL)
# 403 = bucket exists but listing denied (try specific objects)
# 404 = bucket doesn't exist
```

## GCS Bucket Enumeration

```bash
# GCS XML API
for name in target target-prod target-staging target-test target-ci \
           target-backup target-uploads target-public target-cdn; do

  code=$(curl -sI "https://storage.googleapis.com/${name}/" | head -1)
  echo "$code $name"
done

# If listing is public, get objects
curl -s "https://storage.googleapis.com/target-bucket/" | grep -oP '<Key>[^<]+</Key>'

# Each result returns up to 1000 objects per page
# Check for pagination: <NextMarker>
```

## Cloudflare R2 Enumeration

```bash
# R2 uses S3-compatible API
curl -sI "https://[account].r2.cloudflarestorage.com/[bucket]/"

# Presigned URLs leak R2 Access Key IDs
# Parse X-Amz-Credential parameter from any presigned URL
```

## Firebase Storage Enumeration

```bash
# Firebase Storage REST API
curl "https://firebasestorage.googleapis.com/v0/b/[project].appspot.com/o"

# Direct bucket access
curl "https://[project].appspot.com/"

# If listing is denied, try specific object paths
# Paths often use Firebase Auth UIDs as directory prefixes:
# /users/[uid]/avatar.jpg
# /users/[uid]/documents/[filename]
```

## Google Dorks

```
site:storage.googleapis.com "ListBucketResult"
site:s3.amazonaws.com "ListBucketResult"
site:storage.googleapis.com target
site:s3.amazonaws.com target
```

## Presigned URL Credential Extraction

```bash
# AWS/R2 presigned URLs
echo "[presigned_url]" | grep -oP 'X-Amz-Credential=\K[^&]+'
# Returns: AKIAIOSFODNN7EXAMPLE/20260826/us-east-1/s3/aws4_request
# Access Key ID: AKIAIOSFODNN7EXAMPLE

# GCS presigned URLs
echo "[presigned_url]" | grep -oP 'X-Goog-Credential=\K[^&]+'
# Returns: service-account@project.iam.gserviceaccount.com/20260826/...
# Service Account: service-account@project.iam.gserviceaccount.com
# GCP Project: project
```

## Key Insights

1. **Even when listing is blocked, individual objects may be readable** — guess paths from API responses
2. **Presigned URLs leak access key IDs** — not the full credential, but enables targeted attacks
3. **Firebase UID paths enable user enumeration** — directory listing reveals user count
4. **Dev/staging buckets often have different (weaker) policies**
5. **Common bucket naming patterns work 60-70% of the time**
