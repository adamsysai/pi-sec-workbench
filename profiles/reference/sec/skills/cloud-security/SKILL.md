---
description: "Cloud security testing — AWS/Azure/GCP enumeration, IAM abuse, S3/blob exposure, container escape"
---
# Cloud Security Assessment

## When to Use
When assessing cloud infrastructure (AWS, Azure, GCP) for misconfigurations.

## Procedure
1. **IAM**: Check for overprivileged roles, unused credentials, missing MFA
2. **Storage**: Public S3 buckets/blob containers, missing encryption
3. **Network**: Open security groups, public subnets, missing NACLs
4. **Compute**: Public instances, exposed metadata service (SSRF to 169.254.169.254)
5. **Containers**: Privileged containers, exposed Docker socket, missing namespace isolation
6. **Serverless**: Over-permissive IAM roles, unvalidated event sources
7. **Secrets**: Secrets in env vars, code, or unencrypted storage
8. **Logging**: CloudTrail/activity log gaps, missing alarms

## Key Checks
- AWS: `aws sts get-caller-identity`, `aws s3 ls`, IAM enumeration
- Azure: `az account list`, storage account enumeration
- GCP: `gcloud projects list`, bucket enumeration
- Kubernetes: RBAC, pod security, network policies

## Verification
- Misconfiguration confirmed with API call
- Impact demonstrated (e.g., public bucket read)
- Remediation aligned with CIS benchmarks
