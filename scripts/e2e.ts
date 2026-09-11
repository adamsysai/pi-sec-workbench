import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Coordinator, APIError } from '../sdk/src/client.ts';
const base = process.env.PI_COORDINATOR_URL ?? 'http://127.0.0.1:8787';
const token = process.env.API_TOKEN ?? '';
const client = new Coordinator(base, token);
const key = randomUUID(); const kind = `e2e-${key}`;
const task = await client.create({request_key:key,title:'SDK end-to-end',kind,input:{private:'redaction-fixture'}});
assert.equal((await client.create({request_key:key,title:'SDK end-to-end',kind,input:{private:'redaction-fixture'}})).id,task.id);
const claims = await Promise.all(Array.from({length:12},(_,i)=>client.claim(`worker-${i}`,kind)));
const won = claims.filter(x=>x!==null); assert.equal(won.length,1);
const lease = won[0]!;
assert.equal((await client.finish('heartbeat',lease,lease.task.worker)).status,'running');
assert.equal((await client.finish('complete',lease,lease.task.worker,{ok:true})).status,'completed');
await assert.rejects(client.finish('complete',lease,lease.task.worker), (e:unknown)=>e instanceof APIError&&e.status===409);
const snapshot = await client.snapshot();
assert.equal(JSON.stringify(snapshot).includes('redaction-fixture'),false);
const controller = new AbortController();
const response = await fetch(`${base}/api/stream`,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal});
assert.equal(response.status,200);
const reader = response.body!.getReader();
try {
  const frame = await reader.read();
  assert.match(new TextDecoder().decode(frame.value),/event: snapshot/);
  assert.equal(new TextDecoder().decode(frame.value).includes('lease_token'),false);
} finally { controller.abort(); await reader.cancel().catch(()=>{}); }
assert.equal((await fetch(`${base}/api/snapshot`)).status,401);
console.log('E2E passed: 12 competing workers, one owner, heartbeat, completion, stale-token conflict, redacted SSE and authentication.');
