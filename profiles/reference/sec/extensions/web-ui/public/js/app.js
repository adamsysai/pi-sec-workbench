/**
 * pi-sec web console — main application
 * Vanilla JS, no frameworks. WebSocket realtime + REST API.
 */
'use strict';

// ─── Boot config ──────────────────────────────────────────────
const boot = JSON.parse(document.getElementById('boot-config').textContent);
const { wsPath, apiBase, pollInterval, maxLogEntries, maxActivityEntries } = boot;

// ─── State ────────────────────────────────────────────────────
const state = {
  ws: null,
  connected: false,
  agents: [],
  events: [],
  hypotheses: [],
  findings: [],
  tasks: [],
  graph: { nodes: [], edges: [] },
  scope: {},
  costs: {},
  runtime: 0,
  currentView: 'live',
  filters: { agent: '', type: '', severity: '', search: '' },
  replay: { active: false, events: [], index: 0, speed: 1, timer: null },
  graphCanvas: null,
  graphCtx: null,
  graphTransform: { x: 0, y: 0, scale: 1 },
  graphDrag: { active: false, startX: 0, startY: 0, lastX: 0, lastY: 0 },
  graphNodePositions: new Map(),
  graphSelectedNode: null,
};

// ─── Helpers ──────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('en-US', { hour12: false });
const fmtDuration = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
};
const fmtCost = (c) => `$${(c || 0).toFixed(2)}`;
const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const AGENT_COLORS = {
  idle: '#555', thinking: '#fbbf24', working: '#4ade80',
  waiting: '#4fc3f7', blocked: '#ef4444', validating: '#c084fc', failed: '#b71c1c'
};
const SEVERITY_COLORS = {
  critical: '#b71c1c', high: '#e53935', medium: '#fb8c00', low: '#4fc3f7', info: '#555'
};
const HYPOTHESIS_STATES = [
  'created', 'investigating', 'correlated', 'challenged', 'validating', 'confirmed', 'rejected'
];
const HYPOTHESIS_COLORS = {
  created: '#555', investigating: '#fbbf24', correlated: '#4fc3f7',
  challenged: '#fb8c00', validating: '#c084fc', confirmed: '#4ade80', rejected: '#ef4444'
};
const NODE_COLORS = {
  host: '#4fc3f7', service: '#81c784', endpoint: '#ffb74d', api: '#f48fb1',
  user: '#ce93d8', identity: '#ba68c8', role: '#9575cd', org: '#7986cb',
  domain: '#64b5f6', subdomain: '#90caf9', credential: '#ffd54f', token: '#ffca28',
  workflow: '#4db6ac', permission: '#81d4fa', finding: '#ef5350', hypothesis: '#ab47bc',
  trust_boundary: '#78909c', database: '#8d6e63', queue: '#a1887f'
};

// ─── WebSocket ────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}${wsPath}`;
  state.ws = new WebSocket(url);

  state.ws.onopen = () => {
    state.connected = true;
    $('#status-indicator').classList.add('connected');
  };

  state.ws.onclose = () => {
    state.connected = false;
    $('#status-indicator').classList.remove('connected');
    setTimeout(connectWS, 3000);
  };

  state.ws.onerror = () => { state.ws.close(); };

  state.ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleMessage(msg);
    } catch (e) { console.error('WS parse error:', e); }
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'status_snapshot':
      state.agents = msg.data?.agents || [];
      state.hypotheses = msg.data?.hypotheses || [];
      state.findings = msg.data?.findings || [];
      state.tasks = msg.data?.tasks || [];
      state.graph = msg.data?.graph || { nodes: [], edges: [] };
      state.scope = msg.data?.scope || {};
      state.costs = msg.data?.costs || {};
      state.runtime = msg.data?.runtime || 0;
      state.events = msg.data?.recent_events || [];
      renderAll();
      break;
    case 'event':
      addEvent(msg.data);
      break;
    case 'agent_update':
      updateAgent(msg.data);
      break;
    case 'hypothesis_update':
      updateHypothesis(msg.data);
      break;
    case 'finding_update':
      updateFinding(msg.data);
      break;
    case 'task_update':
      updateTask(msg.data);
      break;
    case 'graph_update':
      state.graph = msg.data || { nodes: [], edges: [] };
      renderGraph();
      break;
    case 'cost_update':
      state.costs = msg.data || {};
      renderStats();
      break;
    case 'scope_update':
      state.scope = msg.data || {};
      break;
  }
}

// ─── State updates ────────────────────────────────────────────
function addEvent(ev) {
  state.events.unshift(ev);
  if (state.events.length > maxLogEntries) state.events.pop();
  renderActivityStream();
  renderLiveLog();
  renderStats();
}

function updateAgent(data) {
  const idx = state.agents.findIndex(a => a.name === data.name);
  if (idx >= 0) state.agents[idx] = { ...state.agents[idx], ...data };
  else state.agents.push(data);
  renderAgentList();
  renderStats();
}

function updateHypothesis(data) {
  const idx = state.hypotheses.findIndex(h => h.id === data.id);
  if (idx >= 0) state.hypotheses[idx] = { ...state.hypotheses[idx], ...data };
  else state.hypotheses.push(data);
  renderHypothesisBoard();
  renderStats();
}

function updateFinding(data) {
  const idx = state.findings.findIndex(f => f.id === data.id);
  if (idx >= 0) state.findings[idx] = { ...state.findings[idx], ...data };
  else state.findings.push(data);
  renderFindings();
  renderStats();
}

function updateTask(data) {
  const idx = state.tasks.findIndex(t => t.id === data.id);
  if (idx >= 0) state.tasks[idx] = { ...state.tasks[idx], ...data };
  else state.tasks.push(data);
  renderTaskGraph();
  renderStats();
}

// ─── Rendering ───────────────────────────────────────────────
function renderAll() {
  renderAgentList();
  renderActivityStream();
  renderLiveLog();
  renderHypothesisBoard();
  renderFindings();
  renderTaskGraph();
  renderGraph();
  renderStats();
}

function renderStats() {
  const agentCount = state.agents.length;
  const activeAgents = state.agents.filter(a => a.status === 'working' || a.status === 'thinking').length;
  const taskCount = state.tasks.length;
  const runningTasks = state.tasks.filter(t => t.status === 'running' || t.status === 'claimed').length;
  const hypCount = state.hypotheses.length;
  const chains = state.findings.filter(f => f.attack_path && f.attack_path.length > 1).length;
  const highFindings = state.findings.filter(f => f.confidence >= 0.8 && f.status === 'validated').length;
  const cost = state.costs?.total_cost || 0;

  $('#stat-agents').textContent = agentCount;
  $('#stat-tasks').textContent = taskCount;
  $('#stat-hypotheses').textContent = hypCount;
  $('#stat-chains').textContent = chains;
  $('#stat-findings').textContent = highFindings;
  $('#stat-cost').textContent = fmtCost(cost);
  $('#agent-count').textContent = agentCount;
  $('#activity-count').textContent = state.events.length;

  if (state.runtime) {
    const elapsed = Date.now() - state.runtime;
    $('#stat-runtime').textContent = fmtDuration(elapsed);
  }
}

function renderAgentList() {
  const el = $('#agent-list');
  if (!el) return;
  if (!state.agents.length) {
    el.innerHTML = '<div class="empty-state">No agents active</div>';
    return;
  }
  el.innerHTML = state.agents.map(a => {
    const color = AGENT_COLORS[a.status] || '#555';
    const dot = `<span class="agent-dot" style="background:${color}"></span>`;
    const task = a.current_task ? esc(a.current_task) : '—';
    const model = a.model ? `<span class="label-mono">${esc(a.model)}</span>` : '';
    const elapsed = a.started_at ? fmtDuration(Date.now() - a.started_at) : '';
    return `<div class="agent-card" data-agent="${esc(a.name)}">
      <div class="agent-header">${dot}<span class="agent-name">${esc(a.name)}</span></div>
      <div class="agent-task">${task}</div>
      <div class="agent-meta">${model}<span class="label-mono">${esc(a.status)}</span>${elapsed ? `<span>${elapsed}</span>` : ''}</div>
    </div>`;
  }).join('');

  // Click to open detail
  el.querySelectorAll('.agent-card').forEach(card => {
    card.addEventListener('click', () => showAgentDetail(card.dataset.agent));
  });
}

function renderActivityStream() {
  const el = $('#activity-stream');
  if (!el) return;
  const events = state.events.slice(0, maxActivityEntries);
  let filtered = events;
  if (state.filters.agent) filtered = filtered.filter(e => e.agent?.toLowerCase().includes(state.filters.agent));
  if (state.filters.type) filtered = filtered.filter(e => e.event_type?.includes(state.filters.type));
  if (state.filters.severity) filtered = filtered.filter(e => e.severity === state.filters.severity);

  if (!filtered.length) {
    el.innerHTML = '<div class="empty-state">No events</div>';
    return;
  }
  el.innerHTML = filtered.map(ev => {
    const t = ev.timestamp ? fmtTime(ev.timestamp) : '';
    const agent = ev.agent || ev.source || '';
    const type = ev.event_type || '';
    const desc = ev.description || ev.message || esc(JSON.stringify(ev.data || ''));
    const sevColor = ev.severity ? SEVERITY_COLORS[ev.severity] || '' : '';
    return `<div class="event-row">
      <span class="event-time label-mono">${t}</span>
      <span class="event-agent label-mono">${esc(agent.toUpperCase())}</span>
      <span class="event-type label-mono" style="color:${sevColor}">${esc(type)}</span>
      <span class="event-desc">${esc(desc).substring(0,200)}</span>
    </div>`;
  }).join('');
}

function renderLiveLog() {
  const el = $('#live-log');
  if (!el) return;
  const events = state.events.slice(0, 100);
  if (!events.length) { el.innerHTML = '<div class="empty-state">No activity</div>'; return; }

  let filtered = events;
  const search = state.filters.search?.toLowerCase();
  if (search) filtered = filtered.filter(e => JSON.stringify(e).toLowerCase().includes(search));

  // Virtualized: only render visible
  el.innerHTML = filtered.slice(0, 100).map(ev => {
    const t = ev.timestamp ? fmtTime(ev.timestamp) : '';
    const agent = ev.agent || ev.source || '';
    const desc = ev.description || ev.message || ev.event_type || '';
    return `<div class="log-line">
      <span class="log-time">${t}</span>
      <span class="log-agent">${esc(agent.toUpperCase())}</span>
      <span class="log-msg">${esc(desc).substring(0,300)}</span>
    </div>`;
  }).join('');
}

function renderHypothesisBoard() {
  const el = $('#hypothesis-board');
  if (!el) return;
  const columns = {};
  for (const s of HYPOTHESIS_STATES) columns[s] = [];

  for (const h of state.hypotheses) {
    const lifecycle = h.lifecycle || 'created';
    if (columns[lifecycle]) columns[lifecycle].push(h);
    else columns['created'].push(h);
  }

  el.innerHTML = HYPOTHESIS_STATES.map(state_name => {
    const items = columns[state_name];
    const color = HYPOTHESIS_COLORS[state_name] || '#555';
    return `<div class="kanban-col">
      <div class="kanban-header" style="border-color:${color}">
        <span class="kanban-title">${state_name.toUpperCase()}</span>
        <span class="kanban-count label-mono">${items.length}</span>
      </div>
      <div class="kanban-body">
        ${items.map(h => {
          const conf = Math.round((h.confidence || 0) * 100);
          return `<div class="hyp-card" data-hyp="${esc(h.id)}">
            <div class="hyp-id label-mono">${esc(h.id)}</div>
            <div class="hyp-title">${esc(h.title || 'Untitled')}</div>
            <div class="hyp-meta">
              <span class="label-mono">${conf}%</span>
              <span>${esc(h.created_by || '')}</span>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.hyp-card').forEach(card => {
    card.addEventListener('click', () => showHypothesisDetail(card.dataset.hyp));
  });
}

function renderFindings() {
  const el = $('#findings-list');
  if (!el) return;
  if (!state.findings.length) {
    el.innerHTML = '<div class="empty-state">No findings yet</div>';
    return;
  }
  // Group by status
  const groups = { validated: [], potential: [], rejected: [] };
  for (const f of state.findings) {
    if (f.status === 'validated' || f.status === 'confirmed') groups.validated.push(f);
    else if (f.status === 'rejected') groups.rejected.push(f);
    else groups.potential.push(f);
  }

  const renderGroup = (title, items) => {
    if (!items.length) return '';
    return `<div class="findings-group">
      <div class="findings-group-header"><span>${title}</span><span class="label-mono">${items.length}</span></div>
      ${items.map(f => {
        const sev = f.severity || 'info';
        const sevColor = SEVERITY_COLORS[sev] || '#555';
        const conf = Math.round((f.confidence || 0) * 100);
        return `<div class="finding-card" data-finding="${esc(f.id)}" style="border-left:3px solid ${sevColor}">
          <div class="finding-header">
            <span class="finding-sev label-mono" style="color:${sevColor}">${sev.toUpperCase()}</span>
            <span class="finding-title">${esc(f.title || 'Untitled')}</span>
          </div>
          <div class="finding-meta">
            <span class="label-mono">${conf}%</span>
            <span>${esc(f.affected_component || '')}</span>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  };

  el.innerHTML = renderGroup('Validated', groups.validated) + renderGroup('Potential', groups.potential) + renderGroup('Rejected', groups.rejected);
}

function renderTaskGraph() {
  const el = $('#view-tasks .view-body');
  if (!el) return;
  if (!state.tasks.length) {
    el.innerHTML = '<div class="empty-state">No tasks created</div>';
    return;
  }

  // Build tree from tasks
  const byStatus = {};
  for (const t of state.tasks) {
    const s = t.status || 'pending';
    if (!byStatus[s]) byStatus[s] = [];
    byStatus[s].push(t);
  }

  const statusColors = {
    pending: '#555', claimed: '#4fc3f7', running: '#4ade80',
    blocked: '#ef4444', completed: '#888', failed: '#b71c1c', cancelled: '#666'
  };

  const renderTask = (t, depth) => {
    const color = statusColors[t.status] || '#555';
    const indent = depth * 20;
    return `<div class="task-row" style="margin-left:${indent}px">
      <span class="task-dot" style="background:${color}"></span>
      <span class="task-id label-mono">${esc(t.id)}</span>
      <span class="task-status label-mono">${esc(t.status)}</span>
      <span class="task-target">${esc(t.target || '')}</span>
      <span class="task-owner">${esc(t.owner || 'unassigned')}</span>
    </div>`;
  };

  const lines = [];
  const roots = state.tasks.filter(t => !t.parent_task);
  const children = state.tasks.filter(t => t.parent_task);

  const renderTree = (task, depth) => {
    lines.push(renderTask(task, depth));
    const kids = children.filter(c => c.parent_task === task.id);
    kids.forEach(c => renderTree(c, depth + 1));
  };
  roots.forEach(r => renderTree(r, 0));

  el.innerHTML = lines.join('');
}

// ─── Graph rendering (canvas) ─────────────────────────────────
function renderGraph() {
  const canvas = $('#graph-canvas-el');
  if (!canvas) return;
  if (!state.graphCanvas) {
    state.graphCanvas = canvas;
    state.graphCtx = canvas.getContext('2d');
    setupGraphInteraction(canvas);
    resizeCanvas(canvas);
    window.addEventListener('resize', () => resizeCanvas(canvas));
  }
  drawGraph();
}

function resizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  state.graphCtx.scale(dpr, dpr);
}

function setupGraphInteraction(canvas) {
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    state.graphTransform.scale *= delta;
    state.graphTransform.scale = Math.max(0.1, Math.min(5, state.graphTransform.scale));
    drawGraph();
  });

  canvas.addEventListener('mousedown', (e) => {
    state.graphDrag.active = true;
    state.graphDrag.startX = e.offsetX;
    state.graphDrag.startY = e.offsetY;
    state.graphDrag.lastX = e.offsetX;
    state.graphDrag.lastY = e.offsetY;
  });

  canvas.addEventListener('mousemove', (e) => {
    if (state.graphDrag.active) {
      state.graphTransform.x += e.offsetX - state.graphDrag.lastX;
      state.graphTransform.y += e.offsetY - state.graphDrag.lastY;
      state.graphDrag.lastX = e.offsetX;
      state.graphDrag.lastY = e.offsetY;
      drawGraph();
    } else {
      // Hover detection
      checkGraphHover(e.offsetX, e.offsetY);
    }
  });

  canvas.addEventListener('mouseup', () => { state.graphDrag.active = false; });
  canvas.addEventListener('mouseleave', () => { state.graphDrag.active = false; });

  canvas.addEventListener('click', (e) => {
    const node = findNodeAt(e.offsetX, e.offsetY);
    if (node) showNodeDetail(node);
  });
}

function getNodePos(node) {
  if (!state.graphNodePositions.has(node.id)) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 100 + Math.random() * 150;
    state.graphNodePositions.set(node.id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0, vy: 0,
    });
  }
  return state.graphNodePositions.get(node.id);
}

function simulatePhysics() {
  const nodes = state.graph.nodes || [];
  const edges = state.graph.edges || [];
  const positions = nodes.map(n => ({ id: n.id, ...getNodePos(n) }));

  // Repulsion
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const dx = positions[i].x - positions[j].x;
      const dy = positions[i].y - positions[j].y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const force = 2000 / (dist * dist);
      positions[i].vx += (dx / dist) * force;
      positions[i].vy += (dy / dist) * force;
      positions[j].vx -= (dx / dist) * force;
      positions[j].vy -= (dy / dist) * force;
    }
  }

  // Attraction (edges)
  for (const edge of edges) {
    const a = positions.find(p => p.id === edge.from);
    const b = positions.find(p => p.id === edge.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const force = (dist - 80) * 0.01;
    a.vx += (dx / dist) * force;
    a.vy += (dy / dist) * force;
    b.vx -= (dx / dist) * force;
    b.vy -= (dy / dist) * force;
  }

  // Update
  for (const pos of positions) {
    pos.x += pos.vx * 0.1;
    pos.y += pos.vy * 0.1;
    pos.vx *= 0.85;
    pos.vy *= 0.85;
    const stored = state.graphNodePositions.get(pos.id);
    if (stored) { stored.x = pos.x; stored.y = pos.y; stored.vx = pos.vx; stored.vy = pos.vy; }
  }
}

function drawGraph() {
  const ctx = state.graphCtx;
  if (!ctx) return;
  const canvas = state.graphCanvas;
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);

  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2 + state.graphTransform.x, h / 2 + state.graphTransform.y);
  ctx.scale(state.graphTransform.scale, state.graphTransform.scale);

  // Simulate
  for (let i = 0; i < 3; i++) simulatePhysics();

  const nodes = state.graph.nodes || [];
  const edges = state.graph.edges || [];

  // Draw edges
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.font = '8px monospace';
  for (const edge of edges) {
    const a = state.graphNodePositions.get(edge.from);
    const b = state.graphNodePositions.get(edge.to);
    if (!a || !b) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    // Label
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    ctx.fillStyle = '#555';
    ctx.fillText(edge.label || '', mx, my);
  }

  // Draw nodes
  for (const node of nodes) {
    const pos = state.graphNodePositions.get(node.id);
    if (!pos) continue;
    const color = NODE_COLORS[node.type] || '#666';
    const r = node.type === 'finding' ? 8 : 6;

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Label
    ctx.fillStyle = '#aaa';
    ctx.font = '9px monospace';
    ctx.fillText(node.label || node.id, pos.x + 10, pos.y + 3);
  }

  ctx.restore();
}

function findNodeAt(x, y) {
  const nodes = state.graph.nodes || [];
  for (const node of nodes) {
    const pos = state.graphNodePositions.get(node.id);
    if (!pos) continue;
    const sx = pos.x * state.graphTransform.scale + state.graphCanvas.width / 2 + state.graphTransform.x;
    const sy = pos.y * state.graphTransform.scale + state.graphCanvas.height / 2 + state.graphTransform.y;
    const dist = Math.sqrt((x - sx) ** 2 + (y - sy) ** 2);
    if (dist < 12) return node;
  }
  return null;
}

function checkGraphHover(x, y) {
  const node = findNodeAt(x, y);
  const tooltip = $('#graph-tooltip');
  if (node && tooltip) {
    tooltip.style.display = 'block';
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
    tooltip.innerHTML = `<div class="tooltip-type">${esc(node.type)}</div><div class="tooltip-label">${esc(node.label)}</div>`;
  } else if (tooltip) {
    tooltip.style.display = 'none';
  }
}

// ─── Detail views ─────────────────────────────────────────────
function showAgentDetail(name) {
  const agent = state.agents.find(a => a.name === name);
  if (!agent) return;
  const events = state.events.filter(e => e.agent === name).slice(0, 20);
  const color = AGENT_COLORS[agent.status] || '#555';

  const center = $('#view-live .view-body') || $('#center-panel');
  if (center) {
    center.innerHTML = `<div class="detail-view">
      <div class="detail-header">
        <span class="agent-dot" style="background:${color}"></span>
        <h2 class="label-mono">${esc(agent.name)}</h2>
        <span class="label-mono" style="color:${color}">${esc(agent.status)}</span>
      </div>
      <div class="detail-grid">
        <div class="detail-field"><label>Current task</label><span>${esc(agent.current_task || '—')}</span></div>
        <div class="detail-field"><label>Model</label><span class="label-mono">${esc(agent.model || '—')}</span></div>
        <div class="detail-field"><label>Started</label><span class="label-mono">${agent.started_at ? fmtTime(agent.started_at) : '—'}</span></div>
        <div class="detail-field"><label>Tasks completed</label><span class="label-mono">${agent.tasks_completed || 0}</span></div>
        <div class="detail-field"><label>Token usage</label><span class="label-mono">${agent.token_usage || 0}</span></div>
      </div>
      <div class="detail-section">
        <h3>Recent observations</h3>
        ${events.map(e => `<div class="detail-event"><span class="label-mono">${fmtTime(e.timestamp)}</span> ${esc(e.description || e.event_type)}</div>`).join('') || '<div class="empty-state">No events</div>'}
      </div>
    </div>`;
  }
}

function showHypothesisDetail(id) {
  const h = state.hypotheses.find(h => h.id === id);
  if (!h) return;
  const color = HYPOTHESIS_COLORS[h.lifecycle] || '#555';
  const relatedAgents = [...new Set(state.events.filter(e => e.hypothesis === id).map(e => e.agent))];

  const center = $('#view-live .view-body') || $('#center-panel');
  if (center) {
    center.innerHTML = `<div class="detail-view">
      <div class="detail-header">
        <h2 class="label-mono">${esc(h.id)}</h2>
        <span style="color:${color}">${esc(h.lifecycle)}</span>
        <span class="label-mono">${Math.round((h.confidence || 0) * 100)}%</span>
      </div>
      <div class="detail-grid">
        <div class="detail-field"><label>Title</label><span>${esc(h.title)}</span></div>
        <div class="detail-field"><label>Created by</label><span>${esc(h.created_by || '—')}</span></div>
        <div class="detail-field"><label>Impact</label><span>${esc(h.potential_impact || '—')}</span></div>
      </div>
      <div class="detail-section">
        <h3>Evidence</h3>
        <pre>${esc(JSON.stringify(h.evidence || [], null, 2))}</pre>
      </div>
      <div class="detail-section">
        <h3>Expected behavior</h3>
        <p>${esc(h.expected_behavior || '—')}</p>
      </div>
      <div class="detail-section">
        <h3>Observed behavior</h3>
        <p>${esc(h.observed_behavior || '—')}</p>
      </div>
      <div class="detail-section">
        <h3>Related agents</h3>
        <p>${relatedAgents.map(a => `<span class="label-mono">${esc(a)}</span>`).join(', ') || 'None'}</p>
      </div>
      <div class="detail-section">
        <h3>Timeline</h3>
        ${state.events.filter(e => e.hypothesis === id).map(e => `<div class="timeline-item"><span class="label-mono">${fmtTime(e.timestamp)}</span> <span>${esc(e.event_type)}</span> <span>${esc(e.description || '')}</span></div>`).join('') || '<div class="empty-state">No timeline events</div>'}
      </div>
    </div>`;
  }
}

function showNodeDetail(node) {
  const tooltip = $('#graph-tooltip');
  if (tooltip) {
    tooltip.style.display = 'block';
    tooltip.innerHTML = `<div class="tooltip-type">${esc(node.type)}</div><div class="tooltip-label">${esc(node.label)}</div><div class="tooltip-detail">${esc(node.detail || '')}</div>`;
  }
  state.graphSelectedNode = node;
}

// ─── View switching ──────────────────────────────────────────
function switchView(view) {
  state.currentView = view;
  $$('.view').forEach(v => { v.classList.remove('view-active'); v.setAttribute('aria-hidden', 'true'); });
  const target = $(`#view-${view}`);
  if (target) { target.classList.add('view-active'); target.setAttribute('aria-hidden', 'false'); }

  $$('.tab-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
  const btn = $(`.tab-btn[data-view="${view}"]`);
  if (btn) { btn.classList.add('active'); btn.setAttribute('aria-selected', 'true'); }

  $$('.nav-drawer-item').forEach(b => b.classList.remove('active'));
  const nav = $(`.nav-drawer-item[data-view="${view}"]`);
  if (nav) nav.classList.add('active');

  if (view === 'graph') renderGraph();
  if (view === 'hypotheses') renderHypothesisBoard();
  if (view === 'findings') renderFindings();
  if (view === 'tasks') renderTaskGraph();

  closeNavDrawer();
}

// ─── Command palette ──────────────────────────────────────────
const COMMANDS = [
  { name: 'Live Investigation', action: () => switchView('live') },
  { name: 'Security Graph', action: () => switchView('graph') },
  { name: 'Hypothesis Board', action: () => switchView('hypotheses') },
  { name: 'Task Graph', action: () => switchView('tasks') },
  { name: 'Findings', action: () => switchView('findings') },
  { name: 'Show Costs', action: () => fetchAndShowCost() },
  { name: 'Show Scope', action: () => fetchAndShowScope() },
  { name: 'Toggle Replay', action: () => toggleReplay() },
];

function openCommandPalette() {
  $('#palette-backdrop').classList.add('active');
  $('#command-palette').classList.add('active');
  $('#palette-input').value = '';
  $('#palette-input').focus();
  renderPaletteResults('');
}

function closeCommandPalette() {
  $('#palette-backdrop').classList.remove('active');
  $('#command-palette').classList.remove('active');
}

function renderPaletteResults(query) {
  const q = query.toLowerCase();
  const matches = COMMANDS.filter(c => c.name.toLowerCase().includes(q));
  const el = $('#palette-results');
  if (!matches.length) {
    el.innerHTML = '<div class="palette-empty">No matching commands</div>';
    return;
  }
  el.innerHTML = matches.map((c, i) => `<div class="palette-item" data-idx="${i}">${esc(c.name)}</div>`).join('');
  el.querySelectorAll('.palette-item').forEach(item => {
    item.addEventListener('click', () => {
      COMMANDS[parseInt(item.dataset.idx)].action();
      closeCommandPalette();
    });
  });
}

// ─── REST API calls ──────────────────────────────────────────
async function apiGet(path) {
  try {
    const res = await fetch(`${apiBase}${path}`);
    return await res.json();
  } catch (e) { console.error('API error:', e); return null; }
}

async function fetchAndShowCost() {
  const data = await apiGet('/cost');
  if (data) {
    const center = $('#view-live .view-body');
    if (center) {
      center.innerHTML = `<div class="detail-view">
        <h2>Cost Breakdown</h2>
        <div class="detail-grid">
          <div class="detail-field"><label>Total cost</label><span class="label-mono">${fmtCost(data.total_cost)}</span></div>
          <div class="detail-field"><label>Total tokens</label><span class="label-mono">${data.total_tokens || 0}</span></div>
        </div>
        <pre>${esc(JSON.stringify(data, null, 2))}</pre>
      </div>`;
    }
  }
}

async function fetchAndShowScope() {
  const data = await apiGet('/scope');
  if (data) {
    const center = $('#view-live .view-body');
    if (center) {
      center.innerHTML = `<div class="detail-view">
        <h2>Scope</h2>
        <pre>${esc(JSON.stringify(data, null, 2))}</pre>
      </div>`;
    }
  }
}

// ─── Replay ───────────────────────────────────────────────────
async function toggleReplay() {
  if (state.replay.active) {
    state.replay.active = false;
    if (state.replay.timer) clearInterval(state.replay.timer);
    state.replay.timer = null;
  } else {
    const data = await apiGet('/events?limit=1000');
    if (data?.events) {
      state.replay.events = data.events.reverse();
      state.replay.index = 0;
      state.replay.active = true;
      state.events = [];
      renderAll();
      state.replay.timer = setInterval(() => {
        if (state.replay.index >= state.replay.events.length) {
          clearInterval(state.replay.timer);
          state.replay.active = false;
          return;
        }
        const ev = state.replay.events[state.replay.index];
        addEvent(ev);
        state.replay.index++;
      }, 1000 / state.replay.speed);
    }
  }
}

// ─── Mobile nav ───────────────────────────────────────────────
function openNavDrawer() {
  $('#nav-drawer').classList.add('open');
  $('#nav-drawer-backdrop').classList.add('active');
}
function closeNavDrawer() {
  $('#nav-drawer').classList.remove('open');
  $('#nav-drawer-backdrop').classList.remove('active');
}

// ─── Filters ──────────────────────────────────────────────────
function setupFilters() {
  const search = $('#live-search');
  if (search) {
    search.addEventListener('input', (e) => {
      state.filters.search = e.target.value;
      renderLiveLog();
    });
  }
}

// ─── Init ────────────────────────────────────────────────────
function init() {
  // Hide splash
  const splash = $('#splash');
  if (splash) setTimeout(() => splash.classList.add('hidden'), 1500);

  // Connect WebSocket
  connectWS();

  // Nav items
  $$('.nav-drawer-item').forEach(item => {
    item.addEventListener('click', () => switchView(item.dataset.view));
  });

  // Tab buttons
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Mobile nav
  const navToggle = $('#mobile-nav-toggle');
  if (navToggle) navToggle.addEventListener('click', openNavDrawer);
  const navClose = $('#nav-drawer-close');
  if (navClose) navClose.addEventListener('click', closeNavDrawer);
  const backdrop = $('#nav-drawer-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeNavDrawer);

  // Command palette
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      openCommandPalette();
    }
    if (e.key === 'Escape') {
      closeCommandPalette();
      closeNavDrawer();
    }
  });

  const paletteTrigger = $('#palette-trigger');
  if (paletteTrigger) paletteTrigger.addEventListener('click', openCommandPalette);
  const paletteBackdrop = $('#palette-backdrop');
  if (paletteBackdrop) paletteBackdrop.addEventListener('click', closeCommandPalette);

  const paletteInput = $('#palette-input');
  if (paletteInput) {
    paletteInput.addEventListener('input', (e) => renderPaletteResults(e.target.value));
    paletteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = $('.palette-item');
        if (first) first.click();
      }
    });
  }

  // Filters
  setupFilters();

  // Poll for status if WS not connected
  setInterval(async () => {
    if (!state.connected) {
      const data = await apiGet('/status');
      if (data) {
        state.agents = data.agents || [];
        state.hypotheses = data.hypotheses || [];
        state.findings = data.findings || [];
        state.tasks = data.tasks || [];
        state.costs = data.costs || {};
        state.runtime = data.runtime || 0;
        renderAll();
      }
    }
  }, pollInterval);

  // Animate graph
  setInterval(() => {
    if (state.currentView === 'graph' && state.graph.nodes.length > 0) {
      drawGraph();
    }
  }, 50);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
