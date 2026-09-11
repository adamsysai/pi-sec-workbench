---
description: "API design — REST principles, GraphQL schemas, versioning, pagination, error handling"
---
# API Design

## When to Use

- Designing a new REST or GraphQL API
- Reviewing API contracts for consistency and correctness
- Implementing pagination, error handling, or versioning
- Generating or validating OpenAPI specifications

## Procedure

1. **Name resources as plural nouns** under their natural hierarchy:
   ```
   GET    /v1/users          # list users
   POST   /v1/users          # create user
   GET    /v1/users/:id      # get one user
   PATCH  /v1/users/:id      # partial update
   DELETE /v1/users/:id      # delete
   GET    /v1/users/:id/orders   # nested relationship
   ```

2. **Use HTTP methods with correct semantics:**
   - `GET` — safe, idempotent, no body
   - `POST` — create, not idempotent (use idempotency keys for retries)
   - `PUT` — full replacement, idempotent
   - `PATCH` — partial update
   - `DELETE` — idempotent

3. **Return correct status codes:**
   - `200` OK, `201` Created, `204` No Content
   - `400` Bad Request, `401` Unauthorized, `403` Forbidden, `404` Not Found
   - `409` Conflict, `422` Unprocessable Entity
   - `429` Too Many Requests, `500` Internal Server Error

4. **Version in the URL path** (`/v1/`) — simpler than header-based versioning.

5. **Use cursor-based pagination** for large datasets:
   ```
   GET /v1/users?cursor=eyJpZCI6MTIzfQ&limit=20
   # Response:
   { "data": [...], "next_cursor": "eyJpZCI6MTQzfQ" }
   ```

6. **Return a consistent error shape:**
   ```json
   {
     "error": {
       "code": "VALIDATION_ERROR",
       "message": "Email is required",
       "details": [{ "field": "email", "message": "required" }],
       "traceId": "req_abc123"
     }
   }
   ```

7. **Add idempotency keys** for POST to handle safe retries:
   ```
   POST /v1/payments
   Idempotency-Key: client-uuid-here
   ```

8. **Include rate limit headers:**
   ```
   X-RateLimit-Limit: 100
   X-RateLimit-Remaining: 42
   X-RateLimit-Reset: 1699999999
   ```

9. **Generate OpenAPI spec** from code annotations or schema definitions, then validate:
   ```bash
   redocly lint openapi.yaml
   ```

10. **Design GraphQL schemas** with typed inputs, connections for pagination, and DataLoader for N+1 prevention.

## Pitfalls

- Mixing singular and plural resource names (`/user` vs `/users`)
- Using `200 OK` for errors — clients and proxies rely on status codes
- Offset pagination on large tables — performance degrades with depth
- Returning different error shapes from different endpoints — keep it uniform

## Verification

- All endpoints follow the same naming and response conventions
- OpenAPI spec validates with `redocly lint`
- Error responses match the standard error shape across all endpoints
- Rate limit headers present on list/search endpoints
- API client generated from the spec compiles and works against the server
