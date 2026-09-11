export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';
export interface Task {
  id: string; title: string; kind: string; input: Record<string, unknown>;
  dependencies: string[]; status: TaskStatus; worker: string; lease_until: string | null;
  attempts: number; max_attempts: number; result: Record<string, unknown>;
  created_at: string; updated_at: string;
}
export interface Lease { task: Task; lease_token: string }
export interface Snapshot {
  tasks: Task[];
  events: { id: number; task_id: string; action: string; worker: string; created_at: string }[];
  counts: Partial<Record<TaskStatus, number>>;
}
export interface CreateTask {
  request_key: string; title: string; kind?: string; input?: Record<string, unknown>;
  dependencies?: string[]; max_attempts?: number;
}
export class APIError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'APIError'; }
}
/** One trusted workspace per coordinator. Tokens never enter URLs or persistent browser storage. */
export class Coordinator {
  private readonly base: string;
  private readonly token: string;
  private readonly transport: typeof fetch;
  constructor(base: string, token: string, transport: typeof fetch = fetch) {
    this.token = token; this.transport = transport;
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid coordinator URL');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote coordinators require HTTPS');
    if (token.length < 32) throw new Error('API token must contain at least 32 characters');
    this.base = url.href.replace(/\/$/, '');
  }
  private async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.transport(this.base + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail: unknown = await response.json().catch(() => null);
      const message = detail && typeof detail === 'object' && 'error' in detail && typeof detail.error === 'string' ? detail.error : `Coordinator returned ${response.status}`;
      throw new APIError(response.status, message);
    }
    return (response.status === 204 ? null : await response.json()) as T;
  }
  create(input: CreateTask, signal?: AbortSignal): Promise<Task> { return this.request('/api/tasks', input, signal); }
  snapshot(signal?: AbortSignal): Promise<Snapshot> { return this.request('/api/snapshot', undefined, signal); }
  get(id: string, signal?: AbortSignal): Promise<Task> { return this.request(`/api/tasks/${encodeURIComponent(id)}`, undefined, signal); }
  claim(worker: string, kind: string, signal?: AbortSignal): Promise<Lease | null> { return this.request('/api/claim', { worker, kind }, signal); }
  finish(action: 'heartbeat' | 'complete' | 'fail', lease: Lease, worker: string, result: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Task> {
    return this.request(`/api/tasks/${encodeURIComponent(lease.task.id)}/${action}`, { worker, lease_token: lease.lease_token, result }, signal);
  }
}
