---
description: "Security report writing — findings structure, evidence, CVSS, remediation, executive summary"
---
# Security Report Writing

## When to Use
When documenting findings into a professional pentest report.

## Procedure
1. **Structure**: Executive summary → findings → technical details → remediation
2. **Executive summary**: Business impact in non-technical language
3. **Findings**: One section per finding with:
   - Title and severity
   - Description of the vulnerability
   - Affected component/endpoint
   - Proof of concept (step-by-step)
   - Evidence (screenshots, request/response)
   - Impact assessment
   - Remediation recommendation
4. **Appendices**: Full scan data, raw outputs, methodology

## Report Format
Use the `report` tool to save findings:
```
report(title="SQL Injection in /api/search", severity="critical", content="...")
```

## Severity Scale
- **Critical**: Remote code execution, full DB access, full account takeover
- **High**: Privilege escalation, sensitive data exposure, auth bypass
- **Medium**: Stored XSS, CSRF on sensitive actions, partial data exposure
- **Low**: Reflected XSS, information disclosure, missing headers
- **Info**: Best practice recommendations, cosmetic issues

## Pitfalls
- Don't overstate impact — be realistic
- Don't report theoretical issues without PoC
- Don't forget remediation guidance
- Keep executive summary separate from technical details

## Verification
- Every finding has evidence
- Severity is justified
- Remediation is actionable
