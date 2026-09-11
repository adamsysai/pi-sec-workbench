# Architecture

## Components

The coordinator exposes an HTTP API for task creation, claims, heartbeats and completion. PostgreSQL persists tasks and events. The Pi extension and other workers use the TypeScript SDK; the console subscribes to authenticated SSE snapshots.

All callers use the same state transitions. Request contexts propagate deadlines and cancellation into database operations. A bounded connection pool and request admission limits control concurrent work inside each coordinator process.

## Atomicity and ownership

Task creation and its event commit together. Reusing a request key compares a SHA-256 hash of normalized request input; JSON property order and insignificant whitespace are canonicalized. Numbers retain their original decimal representation, so different numeric spellings such as `1` and `1.0` can conflict deliberately. Different integers above JavaScript's safe range remain distinguishable in the Go API; JavaScript callers should encode such values as strings.

A claim transaction performs bounded recovery, locks a ready row with SKIP LOCKED, changes ownership and appends an event. A claim may return no immediately available task while another transaction holds locks, even if a previous snapshot showed pending work. Persistent workers should back off and retry. The short demo is a finite synthetic run with final completion assertions, not a general worker supervisor.

A terminal update first locks the row, then checks its token, worker, running state and expiry against the database clock. This prevents a worker that waited for a row lock from acting on an expiry check evaluated before that wait. Heartbeat uses the same ownership check. An explicit worker failure is terminal; crashes/timeouts retry until `max_attempts`.

The event log contains state transitions, not heartbeat entries. It is append-only and transactionally tied to transitions. SSE sends replaceable snapshots every two seconds, not a durable replay stream. Reconnecting clients obtain current state without claiming exactly-once event delivery.

## Boundaries and costs

This is one trusted workspace per database, with a shared bearer token. A token holder can see task payloads through the task detail endpoint and can operate workers. Random lease tokens prevent accidental/stale ownership reuse; they do not isolate mutually hostile token holders.

Dependencies live in bounded JSON arrays (maximum 32) and reference only existing tasks. There is no task deletion endpoint. A normalized edge table would be better for large graphs, database-level foreign keys and graph maintenance; those needs are not demonstrated here.

Snapshot rows are bounded but count aggregation scans history. Recovery scans pending dependencies and expired running tasks. Events and tasks have no retention policy; queue size is not capped.

## Next experiments

1. Test two coordinator processes sharing a database under network interruption and PostgreSQL failover.
2. Separate recovery cadence from claim traffic; measure batch latency under a large expired backlog.
3. Profile dependency scans and count aggregation at 100k/1m retained tasks before changing the schema.
4. Add tenant-scoped authentication, auditable retention, quotas and tracing if this becomes a hosted service.
5. Implement idempotent external worker adapters with lease-loss cancellation; do not execute arbitrary shell input from task payloads.

These experiments are not yet implemented. Current measurements are in [benchmarks](benchmarks.md).
