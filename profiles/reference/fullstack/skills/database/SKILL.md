---
description: "Database design and optimization — SQL, PostgreSQL, MongoDB, Redis, migrations, indexing"
---
# PostgreSQL + Redis

## When to Use

- Designing a database schema or writing migrations
- Optimizing slow queries or adding indexes
- Implementing Redis caching, rate limiting, or pub/sub
- Diagnosing connection pooling or cache invalidation issues

## Procedure

1. **Normalize by default** — use JSONB columns for flexible/nested data that doesn't need its own table:
   ```sql
   CREATE TABLE products (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       name TEXT NOT NULL,
       metadata JSONB DEFAULT '{}'::jsonb
   );
   ```

2. **Add indexes deliberately** — not on every column:
   ```sql
   CREATE INDEX idx_orders_user_status ON orders (user_id, status)
     WHERE status != 'completed';  -- partial index for active orders
   CREATE INDEX idx_products_metadata ON products USING GIN (metadata);  -- JSONB
   ```

3. **Run migrations forward-only** with a tool like golang-migrate, Alembic, or prisma migrate:
   ```bash
   migrate -path ./migrations -database $DATABASE_URL up
   ```

4. **Always test with `EXPLAIN ANALYZE`** to verify index usage and catch seq scans:
   ```sql
   EXPLAIN ANALYZE SELECT * FROM orders WHERE user_id = $1 AND status = 'pending';
   ```

5. **Detect and fix N+1 queries** — use batch loading or joins:
   ```sql
   -- Bad: one query per user
   -- Good: single query with join
   SELECT u.*, o.id FROM users u
     JOIN orders o ON o.user_id = u.id WHERE u.active = true;
   ```

6. **Use connection pooling** — pgbouncer in transaction mode, or the driver's built-in pool.

7. **Implement Redis cache-aside pattern:**
   ```
   1. Check Redis for key
   2. If miss → query DB → set Redis with TTL
   3. Return data
   ```

8. **Rate limit with INCR + EXPIRE:**
   ```python
   count = redis.incr(f"rate:{user_id}")
   if count == 1: redis.expire(f"rate:{user_id}", 60)
   if count > 100: raise RateLimitError()
   ```

9. **Use distributed locks** with `SET key value NX EX 30` — never rely on GET+SET.

10. **Set TTLs on all cached keys** — no TTL means unbounded memory growth.

## Pitfalls

- Adding indexes on write-heavy tables slows inserts — measure before and after
- Offset pagination (`OFFSET 10000`) gets slower with depth — use cursor-based pagination
- Redis cache without TTL grows forever — always set expiry
- Migration that locks a large table in production — run during low traffic or use `CREATE INDEX CONCURRENTLY`

## Verification

- `EXPLAIN ANALYZE` shows index scans, not seq scans on hot queries
- Migration applies cleanly on a fresh database and on staging
- Redis `INFO memory` shows stable usage (no unbounded growth)
- No N+1 queries — enable ORM query logging in dev and verify batch loading
- Connection pool stats show no exhaustion under load testing
