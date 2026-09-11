---
description: "Node.js backend development — Express, Fastify, streams, worker threads, npm"
---
# Node.js Backend

## When to Use

- Building or modifying a Node.js API server (Express/Fastify)
- Handling streaming, worker threads, or process lifecycle
- Configuring package management, logging, or error handling
- Setting up graceful shutdown or process management

## Procedure

1. **Prefer Fastify** over Express for new projects — schema-based validation, plugin system, and 2-3x throughput:
   ```ts
   const fastify = Fastify({ logger: pino() });
   fastify.post('/users', { schema: { body: UserSchema } }, handler);
   ```

2. **Wrap async route handlers** so rejected promises reach error middleware:
   ```ts
   const wrap = (fn) => (req, reply) => fn(req, reply).catch(req.log.error);
   // Fastify auto-catches async rejections — Express needs this wrapper
   ```

3. **Use streams with `pipeline()`** — never raw `.pipe()`:
   ```ts
   import { pipeline } from 'node:stream/promises';
   await pipeline(readable, transform, writable);
   ```

4. **Offload CPU-bound work** to `worker_threads` — never block the event loop:
   ```ts
   import { Worker } from 'node:worker_threads';
   const worker = new Worker('./heavy-task.js', { workerData: input });
   ```

5. **Implement graceful shutdown:**
   ```ts
   process.on('SIGTERM', async () => {
     server.close();
     await db.close();
     process.exit(0);
   });
   ```

6. **Use centralized error handling** — one error middleware that maps errors to status codes and logs context.

7. **Log with `pino`** for structured JSON logging:
   ```ts
   const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
   ```

8. **Prefer ESM** (`"type": "module"` in package.json). Use `node --watch` for dev instead of nodemon.

9. **Manage processes** with pm2 (clustering, zero-downtime reload) or systemd in production.

10. **Select package manager:** pnpm for monorepos (fast, disk-efficient), npm for simple projects, yarn only if already in use.

## Pitfalls

- Blocking the event loop with synchronous crypto/JSON.parse on large payloads
- Not handling `unhandledRejection` — add `process.on('unhandledRejection', ...)`
- Forgetting to `await server.close()` before `process.exit()` drops in-flight requests
- Mixing ESM and CJS in the same project causes import errors

## Verification

- `node --check` or `tsc --noEmit` passes
- Server shuts down cleanly on SIGTERM (no dropped connections)
- Pino logs are valid JSON in production
- Load test (e.g., `autocannon`) shows no event-loop lag > 100ms
