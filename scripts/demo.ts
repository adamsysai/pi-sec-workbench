import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../sdk/src/client.ts';
const client = new Coordinator(process.env.PI_COORDINATOR_URL ?? 'http://127.0.0.1:8787', process.env.API_TOKEN ?? '');
const run = randomUUID();
const total = Number(process.env.DEMO_TASKS ?? 40);
if (!Number.isInteger(total) || total < 1 || total > 1000) throw new Error('DEMO_TASKS must be 1..1000');
const ids = new Set<string>();
const start = performance.now();
for (let i = 0; i < total; i++) {
  const task = await client.create({ request_key: `${run}-${i}`, title: `Synthetic check ${String(i + 1).padStart(2, '0')}`, input: { index: i, fixture: 'local-demo' }, kind: `demo-${run}` });
  ids.add(task.id);
}
const latencies: number[] = [];
await Promise.all(Array.from({ length: 4 }, async (_, index) => {
  const worker = `demo-worker-${index + 1}`;
  for (;;) {
    const lease = await client.claim(worker, `demo-${run}`);
    if (!lease) return;
    const began = performance.now();
    // Short, deterministic local work, below the minimum supported one-second lease.
    // Long-running real workers must heartbeat and stop side effects when ownership is lost.
    await delay(25);
    const digest = createHash('sha256').update(JSON.stringify(lease.task.input)).digest('hex');
    await client.finish('complete', lease, worker, { digest });
    latencies.push(performance.now() - began);
  }
}));
for (const id of ids) if ((await client.get(id)).status !== 'completed') throw new Error(`Task incomplete: ${id}`);
latencies.sort((a,b) => a-b);
console.log(JSON.stringify({ tasks: total, workers: 4, completed: latencies.length, elapsed_ms: Math.round(performance.now()-start), work_and_ack_p50_ms: Math.round(latencies[Math.floor(latencies.length*.5)]!), work_and_ack_p95_ms: Math.round(latencies[Math.min(latencies.length-1, Math.floor(latencies.length*.95))]!), note: 'Synthetic local demo; includes 25ms simulated work. Not a production scale claim.' }, null, 2));
