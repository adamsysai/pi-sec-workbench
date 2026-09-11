---
description: "Vulnerability validation and PoC construction — confirm exploitability, eliminate false positives"
---
# Vulnerability Validation

## When to Use
After a potential vulnerability is discovered — validate it is real, reproducible, and assess impact.

## Procedure
1. **Reproduce**: Run the PoC again to confirm the finding
2. **Minimize**: Strip the PoC to the minimal reproduction
3. **Impact assessment**: Determine what an attacker can actually do
4. **False positive check**: Rule out configuration artifacts, test-specific conditions
5. **Severity scoring**: Assign CVSS or DREAD score
6. **Chain analysis**: Check if this finding chains with others for greater impact
7. **Environment check**: Confirm the vulnerability exists in production-equivalent environment

## Validation Checklist
- [ ] PoC works consistently (not intermittent)
- [ ] PoC works without special privileges
- [ ] Impact is realistic, not theoretical
- [ ] No false positive conditions (WAF, test data, etc.)
- [ ] Severity matches actual impact

## Common False Positives
- Vulnerabilities only in debug/test endpoints
- Self-XSS (user can only inject into their own page)
- CSRF on stateless APIs
- SSRF to localhost when in a containerized environment
- Open redirect on domains you control

## Verification
- Validated PoC saved as evidence
- Impact assessment written
- Severity justified
