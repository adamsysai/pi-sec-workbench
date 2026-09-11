# Local measurements

Measured 2026-09-11 on an Apple M4 Pro, macOS arm64, Go 1.26.5, PostgreSQL 14.20 on a local Unix socket. Other desktop workloads were active. Results describe this machine and workload.

## Database lifecycle benchmark

```sh
TEST_DATABASE_URL='postgresql:///pi_sec_workbench_test?host=/tmp&sslmode=disable' \
REQUIRE_DB_TESTS=1 go test ./internal/queue -run '^$' \
  -bench BenchmarkCreateClaimComplete -benchtime=3s -benchmem -count=3
```

One operation includes creation, claim and completion, with real SQL transactions and events. `RunParallel` uses the default GOMAXPROCS (12 here); the connection pool is capped at 16. Claims retry transient empty results with a 1ms delay, within a 10-second deadline. Random per-run database schemas isolate the benchmark.

| Run | Operations | ns/op | B/op | allocs/op |
|---|---:|---:|---:|---:|
| 1 | 10,000 | 1,905,914 | 18,033 | 376 |
| 2 | 7,533 | 1,985,020 | 18,040 | 376 |
| 3 | 3,104 | 1,188,199 | 18,226 | 377 |

This is roughly 504–842 lifecycles/second in these runs. Go's parallel `ns/op` is aggregate elapsed time divided by operation count; it is **not** individual request latency. It excludes HTTP, remote network latency, browser rendering and real agent/model work. The wide variation warrants controlled reruns before optimization. [Raw output](benchmark-local.txt) is retained.

The [initial benchmark](benchmark-first-run.txt) incorrectly assumed that creating a task guaranteed an immediately available claim under contention. SKIP LOCKED can return empty while peers hold row locks; that harness assumption failed on its third repetition. The revised harness retries empties. No result from the failed repetition is used above.

## HTTP/TypeScript demo

`npm run demo` created 40 synthetic tasks and processed them with four TypeScript workers through the running HTTP service. A local run completed all 40 in 415ms, including sequential creation and final status verification. Work-plus-ack p50/p95 were 29/30ms, including a deliberately simulated 25ms task delay. The demo sample is too small for load-test percentiles.

`scripts/e2e.ts` also verifies 12 concurrent claims produce exactly one owner, heartbeat succeeds, duplicate completion is rejected, SSE redacts payloads and unauthenticated access is denied. Go tests separately exercise lease expiry, recovery, fencing, retries, dependencies and concurrent idempotent creation.

## Measurement coverage

Remote load, saturation, multi-host failover, long-duration soak and large-backlog memory usage have not been measured. To investigate CPU/heap cost, add `-cpuprofile cpu.out -memprofile mem.out` to a local benchmark invocation and inspect with `go tool pprof`; keep generated artifacts out of Git. Use controlled runs and database query plans to investigate bottlenecks.
