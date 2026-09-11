import { Type, type TSchema, type Static } from '@sinclair/typebox';
import { Coordinator } from '../sdk/src/client.ts';

// Structural subset of Pi's extension API; Pi provides its own runtime.
interface PiHost {
  registerTool<T extends TSchema>(tool: {
    name: string; label: string; description: string; parameters: T;
    execute(id: string, params: Static<T>, signal: AbortSignal | undefined): Promise<{
      content: { type: 'text'; text: string }[]; details: unknown;
    }>;
  }): void;
}
const output = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], details: value });
export default function extension(pi: PiHost) {
  const client = () => new Coordinator(process.env.PI_COORDINATOR_URL ?? 'http://127.0.0.1:8787', process.env.API_TOKEN ?? '');
  pi.registerTool({
    name: 'workbench_create_task', label: 'Create durable task',
    description: 'Create a task in the shared coordinator. Reuse request_key only for retries of exactly the same request. Dependencies must already exist.',
    parameters: Type.Object({ request_key: Type.String({ minLength: 1, maxLength: 128 }), title: Type.String({ minLength: 1, maxLength: 200 }), kind: Type.Optional(Type.String({ maxLength: 64 })), dependencies: Type.Optional(Type.Array(Type.String({ pattern: '^[a-f0-9]{32}$' }), { maxItems: 32 })) }),
    async execute(_id, params, signal) { return output(await client().create(params, signal)); },
  });
  pi.registerTool({
    name: 'workbench_status', label: 'Workbench status',
    description: 'Read task counts and the latest 100 task/event summaries. Task payloads and lease tokens are omitted.',
    parameters: Type.Object({}),
    async execute(_id, _params, signal) { return output(await client().snapshot(signal)); },
  });
  pi.registerTool({
    name: 'workbench_claim_task', label: 'Claim durable task',
    description: 'Claim one ready task for this worker and kind. Keep its lease_token; heartbeat during long work. A null result means no task is immediately available; retry later.',
    parameters: Type.Object({ worker: Type.String({ minLength: 1, maxLength: 100 }), kind: Type.String({ minLength: 1, maxLength: 64 }) }),
    async execute(_id, params, signal) { return output(await client().claim(params.worker, params.kind, signal)); },
  });
  pi.registerTool({
    name: 'workbench_update_task', label: 'Update owned task',
    description: 'Heartbeat, complete or fail an owned lease. A 409 means ownership is lost: stop work and do not retry side effects. Completion does not make external side effects exactly once.',
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-f0-9]{32}$' }), worker: Type.String({ minLength: 1, maxLength: 100 }), lease_token: Type.String({ pattern: '^[a-f0-9]{32}$' }), action: Type.Union([Type.Literal('heartbeat'), Type.Literal('complete'), Type.Literal('fail')]), result: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
    async execute(_id, params, signal) {
      const api = client();
      const task = await api.get(params.id, signal);
      return output(await api.finish(params.action, { task, lease_token: params.lease_token }, params.worker, params.result ?? {}, signal));
    },
  });
}
