# Pi-Sec Web Console

Real-time agentic security research dashboard for the pi-sec profile.

## Quick Start

The web console starts automatically when the pi-sec profile launches. Open:

```
http://localhost:8787
```

## Architecture

```
Pi EventBus (pi.events.on)
       ↓
  Web UI Extension (index.ts)
       ↓
  HTTP Server (port 8787) + WebSocket
       ↓
  Static SPA (HTML + CSS + JS)
```

The extension taps into Pi's EventBus to capture all swarm events in real time. Events are:
1. Streamed to connected WebSocket clients
2. Persisted to `~/.pi/agent/sec-data/events.jsonl` for replay
3. Queryable via REST API

## Configuration

Environment variables (set in profile.json `env` or shell):

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_SEC_WEB_PORT` | `8787` | HTTP port |
| `PI_SEC_WEB_HOST` | `127.0.0.1` | Bind address (use `0.0.0.0` for remote) |
| `PI_SEC_WEB_TOKEN` | (none) | Bearer token for remote auth (required if host is not localhost) |

## Features

### Top Bar
- Target name, swarm status, runtime timer
- Live stats: agents, tasks, hypotheses, chains, findings, cost

### Agent Panel (left)
- Real-time agent list with status dots (idle/thinking/working/waiting/blocked/validating/failed)
- Current task, model, elapsed time per agent
- Click agent → detail view with observations, messages, hypotheses

### Live Investigation (center)
- Tabbed views: Live Investigation, Security Graph, Hypothesis Board, Task Graph, Findings
- Live event stream with filtering by agent, type, severity, search
- Virtualized event list (handles thousands of events)

### Security Graph
- Canvas-based force-directed graph visualization
- Node types: host, service, endpoint, api, user, identity, role, org, domain, subdomain, credential, token, workflow, permission, finding, hypothesis, trust_boundary, database, queue
- Relationships: OWNS, ACCESSES, CALLS, TRUSTS, BELONGS_TO, AUTHENTICATES, AUTHORIZES, READS, WRITES, DEPENDS_ON, FLOWS_TO, EXPOSES, REQUIRES
- Zoom (wheel), pan (drag), click nodes for details

### Hypothesis Board
- Kanban columns: NEW → INVESTIGATING → CORRELATED → CHALLENGED → VALIDATING → CONFIRMED / REJECTED
- Each card shows ID, title, confidence %, originating agent
- Click for full investigation timeline

### Task Graph
- Tree visualization of task dependencies
- Status colors: pending, claimed, running, blocked, completed, failed, cancelled

### Findings
- Grouped by status: Validated, Potential, Rejected
- Severity colors: critical, high, medium, low, info
- Confidence percentages

### Activity Stream (right)
- Real-time events from all agents
- Filterable by agent, event type, severity, text search

### Command Palette
- `Ctrl/Cmd + K` to open
- Fuzzy search commands
- Quick navigation between views

### Investigation Replay
- Load historical events for an investigation
- Play/pause, timeline scrubber
- Speed: 1×, 2×, 4×

## Mobile

- Bottom navigation with: Overview, Agents, Activity, Hypotheses, Chains, Findings
- Responsive layout adapts for phone screens
- Swipe-friendly panels
- Touch-optimized graph interaction

## Security

- **Localhost-only by default** — binds to `127.0.0.1`
- **Remote access requires auth** — set `PI_SEC_WEB_TOKEN` and `PI_SEC_WEB_HOST=0.0.0.0`
- **No secrets exposed** — credentials, API keys, and chain-of-thought are never sent to the UI
- **Input validation** — all API inputs validated
- **Safe event rendering** — all event data treated as untrusted, HTML-escaped

## Telegram Integration

The web UI and `@llblab/pi-telegram` consume the same Pi EventBus. No custom Telegram bot needed.

- **Web UI** — full visualization, primary interface
- **Telegram** — alerts, status updates, important findings (via existing pi-telegram)

## REST API

| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | Swarm status JSON |
| `GET /api/agents` | List all agents |
| `GET /api/agents/:name` | Agent detail |
| `GET /api/events?limit=&offset=&agent=&type=` | Paginated events |
| `GET /api/hypotheses` | List hypotheses |
| `GET /api/hypotheses/:id` | Hypothesis detail with timeline |
| `GET /api/findings` | List findings |
| `GET /api/tasks` | Task graph |
| `GET /api/graph` | Security graph data |
| `GET /api/graph/chains` | Attack chains |
| `GET /api/scope` | Current scope |
| `GET /api/cost` | Cost breakdown |
| `GET /api/replay/:investigationId` | Replay events |
| `WS /ws` | Realtime event stream |

## Tests

```bash
node ~/.pi/agent/profiles/sec/tests/test-web-ui.js
```
