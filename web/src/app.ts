// UI deliberately uses textContent, never task-provided HTML. Credentials are tab-memory only.
interface Task { id: string; title: string; status: string; worker: string; attempts: number; max_attempts: number }
interface Snapshot { tasks: Task[]; counts: Record<string,number>; events: { id: number; action: string; task_id: string; worker: string; created_at: string }[] }
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const notice = (message: string, error = false) => { el('notice').textContent = message; el('notice').classList.toggle('error', error); };
let token = '';
let connection: AbortController | undefined;
let attempt = 0;
let connected = false;
function render(snapshot: Snapshot) {
  for (const state of ['pending','running','completed','failed']) el(state).textContent = String(snapshot.counts[state] ?? 0);
  el('task-count').textContent = String(snapshot.tasks.length);
  el('empty').hidden = snapshot.tasks.length > 0;
  el('no-events').hidden = snapshot.events.length > 0;
  el('tasks').replaceChildren(...snapshot.tasks.map(task => {
    const row = document.createElement('tr');
    const title = document.createElement('td'); title.textContent = task.title;
    const id = document.createElement('small'); id.textContent = task.id.slice(0,12); title.append(id);
    const status = document.createElement('td'); const badge = document.createElement('span'); badge.className = `status ${['pending','running','completed','failed'].includes(task.status) ? task.status : ''}`; badge.textContent = task.status; status.append(badge);
    const worker = document.createElement('td'); worker.textContent = task.worker || '—';
    const tries = document.createElement('td'); tries.textContent = `${task.attempts} / ${task.max_attempts}`;
    row.append(title,status,worker,tries); return row;
  }));
  el('events').replaceChildren(...snapshot.events.slice(0,30).map(event => {
    const item = document.createElement('li'); item.textContent = event.action.replaceAll('_',' ');
    const detail = document.createElement('small'); detail.textContent = `${event.task_id.slice(0,8)} · ${event.worker || 'coordinator'} · ${new Date(event.created_at).toLocaleTimeString()}`;
    item.append(detail); return item;
  }));
}
function setConnected(value: boolean) {
  connected = value;
  el('connection-status').textContent = value ? 'Live workspace' : 'Disconnected';
  el('connection-dot').classList.toggle('live',value);
  el<HTMLInputElement>('title').disabled = !value; el<HTMLButtonElement>('create').disabled = !value;
  el('disconnect').hidden = !value;
}
async function request(path: string, signal: AbortSignal, body?: unknown) {
  const response = await fetch(path,{ method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type':'application/json' }, redirect:'error', signal, ...(body ? {body:JSON.stringify(body)} : {}) });
  if (!response.ok) throw new Error(response.status === 401 ? 'Token rejected. Check API_TOKEN on your coordinator.' : `Request failed (${response.status}).`);
  return response;
}
async function connect() {
  connection?.abort(); const controller = new AbortController(); connection = controller;
  const ownAttempt = ++attempt;
  setConnected(false);
  try {
    const response = await request('/api/stream',controller.signal);
    if (!response.body) throw new Error('Streaming unavailable');
    setConnected(true); notice('Connected · live summaries refresh every two seconds.');
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('Connection closed. Reconnect to resume live updates.');
        buffer += value;
        if (buffer.length > 2_000_000) throw new Error('Unexpected stream size');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0,end); buffer = buffer.slice(end+2);
          const data = frame.split('\n').find(line=>line.startsWith('data: '));
          if (data && ownAttempt === attempt) render(JSON.parse(data.slice(6)) as Snapshot);
        }
      }
    } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
  } catch (error) {
    if (!controller.signal.aborted && ownAttempt === attempt) { setConnected(false); notice(error instanceof Error ? error.message : 'Connection failed', true); }
  }
}
el('connect-form').addEventListener('submit',event=>{
  event.preventDefault(); token = el<HTMLInputElement>('token').value; el<HTMLInputElement>('token').value=''; void connect();
});
el('disconnect').addEventListener('click',()=>{
  ++attempt; connection?.abort(); token=''; setConnected(false); render({tasks:[],events:[],counts:{}}); notice('Disconnected. Token cleared from memory.');
});
let draftKey: string | undefined;
let draftTitle = '';
el('task-form').addEventListener('submit',async event=>{
  event.preventDefault(); if (!connected) return;
  const title = el<HTMLInputElement>('title').value.trim(); if (!title) return;
  if (draftTitle !== title || !draftKey) { draftTitle=title; draftKey=crypto.randomUUID(); }
  el<HTMLButtonElement>('create').disabled = true;
  try {
    await request('/api/tasks', AbortSignal.timeout(10_000), { request_key:draftKey,title,kind:'manual' });
    draftKey=undefined; el<HTMLInputElement>('title').value=''; notice('Task queued. A worker supporting kind “manual” can claim it.');
  } catch(error) { notice(error instanceof Error ? error.message : 'Could not create task',true); }
  finally { el<HTMLButtonElement>('create').disabled=!connected; }
});
window.addEventListener('pagehide',()=>{ connection?.abort(); token=''; });
