import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator, APIError } from '../src/client.ts';
import { URLScope } from '../src/scope.ts';
import extension from '../../extensions/coordinator.ts';
const token = 'test-only-credential'.repeat(3);
test('SDK sends credentials in headers, rejects redirects, handles empty queue', async () => {
  const client = new Coordinator('http://127.0.0.1:8787', token, async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:8787/api/claim');
    assert.equal((init?.headers as Record<string,string>).Authorization, `Bearer ${token}`);
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init?.body)), { worker: 'w1', kind: 'demo' });
    return new Response(null, { status: 204 });
  });
  assert.equal(await client.claim('w1', 'demo'), null);
});
test('SDK exposes lease conflicts and propagates cancellation', async () => {
  const controller = new AbortController(); controller.abort();
  const client = new Coordinator('http://localhost:8787', token, async (_url, init) => {
    assert.equal(init?.signal?.aborted, true);
    return Response.json({ error: 'lease expired' }, { status: 409 });
  });
  await assert.rejects(client.snapshot(controller.signal), (error: unknown) => error instanceof APIError && error.status === 409);
});
test('SDK refuses credential-bearing URLs and remote plaintext', () => {
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com?token=x']) assert.throws(() => new Coordinator(url, token));
});
test('exact-origin scope blocks suffix tricks, credentials, other ports and protocols', () => {
  const scope = new URLScope(['https://example.com']);
  assert.equal(scope.allows('https://EXAMPLE.com/path?q=1'), true);
  for (const url of ['https://example.com.evil.test', 'https://example.com@evil.test', 'https://user@example.com', 'http://example.com', 'https://example.com:444', 'file:///etc/passwd', 'curl https://example.com']) assert.equal(scope.allows(url), false, url);
  assert.throws(() => new URLScope([]));
});
test('Pi adapter registers valid tools with the actual execute(id, params, signal) contract', async () => {
  const registered: { name: string; parameters: unknown; execute: Function }[] = [];
  extension({ registerTool(tool) { registered.push(tool); } });
  assert.deepEqual(registered.map(t => t.name), ['workbench_create_task', 'workbench_status', 'workbench_claim_task', 'workbench_update_task']);
  const original = globalThis.fetch;
  const previous = process.env.API_TOKEN;
  process.env.API_TOKEN = token;
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).title, 'Real parameters');
    return Response.json({ id: 'a'.repeat(32) }, { status: 201 });
  };
  try { await registered[0]!.execute('tool-call-1', { request_key: 'r1', title: 'Real parameters' }, undefined); }
  finally { globalThis.fetch = original; if (previous === undefined) delete process.env.API_TOKEN; else process.env.API_TOKEN = previous; }
});
