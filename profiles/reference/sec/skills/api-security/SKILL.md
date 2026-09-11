---
description: "API security testing — REST/GraphQL enumeration, auth bypass, injection, IDOR"
---
# API Security Testing

## When to Use
When testing REST, GraphQL, or gRPC APIs for security vulnerabilities.

## Procedure
1. **Discovery**: Enumerate endpoints via docs (Swagger/OpenAPI), source, or fuzzing
2. **Authentication**: Test API key, JWT, OAuth flows for weaknesses
3. **Authorization**: Test BOLA/IDOR — access other users' resources by manipulating IDs
4. **Rate limiting**: Test for missing rate limits, brute-force protection
5. **Parameter tampering**: Test for mass assignment, type confusion, parameter pollution
6. **Injection**: SQLi, NoSQLi, command injection via API parameters
7. **GraphQL**: Introspection, batching attacks, deep nested queries, field suggestions
8. **Content-type**: Test XML (XXE), JSON parsing differences
9. **Webhooks**: Test webhook replay, SSRF via callback URLs
10. **Versioning**: Test old API versions for deprecated/unpatched endpoints

## Key Patterns
- JWT: none algorithm, key confusion (RS256→HS256), weak secrets
- BOLA: `/api/users/123` → `/api/users/124`
- Mass assignment: `{"role":"admin"}` in update endpoints
- GraphQL: `__schema` introspection, aliasing for brute force

## Verification
- All API tests documented with request/response
- PoC curl commands provided
- Impact clearly stated
