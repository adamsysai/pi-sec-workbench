/**
 * pi-sec Web Console — HTTP + WebSocket server for real-time swarm monitoring
 *
 * Serves a static UI from public/ and exposes a REST + WS API backed by
 * the sec-data state files. Taps into the Pi EventBus for live event streaming.
 *
 * State files (read from ~/.pi/agent/sec-data/):
 *   swarm-state.json    — agents, tasks, hypotheses, findings, activity
 *   security-graph.json — nodes, edges, attack chains
 *   task-graph.json     — task DAG
 *   events.jsonl        — append-only event log (written by this extension)
 *   scope.yaml          — authorized testing scope
 *
 * Commands:
 *   /sec-web       — start the web console server
 *   /sec-web-stop  — stop the web console server
 *
 * Env:
 *   PI_SEC_WEB_PORT   — HTTP port (default 8787)
 *   PI_SEC_WEB_HOST   — bind address (default localhost; 0.0.0.0 for remote)
 *   PI_SEC_WEB_TOKEN  — bearer token required when host != localhost
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as url from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WebSocketServer, WebSocket } from "ws";

// ═══════════════════════════════════════════════════════════════════════════
//  Paths & Config
// ═══════════════════════════════════════════════════════════════════════════

const DATA_DIR = path.resolve(process.env.PI_SEC_DATA_DIR || ".local/reference-data");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
const SWARM_STATE_FILE = path.join(DATA_DIR, "swarm-state.json");
const SECURITY_GRAPH_FILE = path.join(DATA_DIR, "security-graph.json");
const TASK_GRAPH_FILE = path.join(DATA_DIR, "task-graph.json");
const SCOPE_FILE = path.join(DATA_DIR, "scope.yaml");

const PUBLIC_DIR = (typeof __dirname !== "undefined"
  ? path.join(__dirname, "public")
  : path.join(__filename.replace(/index\.[jt]s$/, ""), "public"));

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "localhost";

// Known Pi event types to subscribe to for live streaming
const PI_EVENT_TYPES = [
  "session_start",
  "session_end",
  "before_agent_start",
  "after_agent_start",
  "tool_call",
  "tool_result",
  "message",
  "task.created",
  "task.claimed",
  "task.completed",
  "asset.discovered",
  "endpoint.discovered",
  "identity.discovered",
  "hypothesis.created",
  "hypothesis.updated",
  "hypothesis.disputed",
  "hypothesis.validated",
  "hypothesis.rejected",
  "finding.discovered",
  "scope.violation",
  "agent.spawned",
  "agent.failed",
];

// ═══════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════

interface SwarmEvent {
  id: string;
  event_type: string;
  source: string;
  target?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

interface ServerState {
  server: http.Server | null;
  wss: WebSocketServer | null;
  clients: Set<WebSocket>;
  eventSubscriptions: Array<() => void>;
  startedAt: string | null;
  port: number;
  host: string;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ANSI Colors (for CLI output)
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
};

// ═══════════════════════════════════════════════════════════════════════════
//  File Helpers
// ═══════════════════════════════════════════════════════════════════════════

function readJSON(filePath: string, fallback: any): any {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readYAML(filePath: string, fallback: any): any {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const result: Record<string, any> = {};
    let currentKey = "";
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("- ")) {
        if (!Array.isArray(result[currentKey])) result[currentKey] = [];
        result[currentKey].push(trimmed.slice(2).trim());
        continue;
      }
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      if (val === "") {
        currentKey = key;
      } else {
        result[key] = val.replace(/^["']|["']$/g, "");
      }
    }
    return { ...fallback, ...result };
  } catch {
    return fallback;
  }
}

function readJSONL(filePath: string): SwarmEvent[] {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const events: SwarmEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // skip malformed lines
      }
    }
    return events;
  } catch {
    return [];
  }
}

function appendJSONL(filePath: string, record: any): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // non-fatal — event log is best-effort
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  HTTP Helpers
// ═══════════════════════════════════════════════════════════════════════════

function sendJSON(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJSON(res, { error: message, status }, status);
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, filePath: string): void {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendError(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
      ".map": "application/json",
    };
    const contentType = mimeTypes[ext] ?? "application/octet-stream";
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    sendError(res, 500, "Failed to serve file");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Authentication
// ═══════════════════════════════════════════════════════════════════════════

function checkAuth(req: http.IncomingMessage, requireToken: boolean, expectedToken: string): boolean {
  if (!requireToken) return true;
  const auth = req.headers.authorization;
  if (!auth) return false;
  if (auth.startsWith("Bearer ")) {
    return auth.slice(7) === expectedToken;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Snapshot Builder — current state for WS clients on connect
// ═══════════════════════════════════════════════════════════════════════════

function buildSnapshot(): Record<string, unknown> {
  const swarmState = readJSON(SWARM_STATE_FILE, null);
  const secGraph = readJSON(SECURITY_GRAPH_FILE, { nodes: [], edges: [] });
  const taskGraph = readJSON(TASK_GRAPH_FILE, { tasks: [], counter: 0 });
  const scope = readYAML(SCOPE_FILE, { authorized: false, targets: [] });

  return {
    type: "snapshot",
    timestamp: new Date().toISOString(),
    swarm: swarmState,
    graph: secGraph,
    tasks: taskGraph,
    scope,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  REST API Handlers
// ═══════════════════════════════════════════════════════════════════════════

function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  query: URLSearchParams,
): void {
  // ── GET /api/status ──────────────────────────────────────────────────
  if (pathname === "/api/status") {
    const state = readJSON(SWARM_STATE_FILE, {
      agents: {}, tasks: {}, hypotheses: {}, findings: {},
      activity: [], totalTokensIn: 0, totalTokensOut: 0, totalCost: 0,
      createdAt: null, updatedAt: null,
    });
    const agentCount = Object.keys(state.agents ?? {}).length;
    const taskCount = Object.keys(state.tasks ?? {}).length;
    const hypCount = Object.keys(state.hypotheses ?? {}).length;
    const findingCount = Object.keys(state.findings ?? {}).length;
    sendJSON(res, {
      status: "operational",
      swarm: {
        agents: agentCount,
        tasks: taskCount,
        hypotheses: hypCount,
        findings: findingCount,
        totalTokensIn: state.totalTokensIn ?? 0,
        totalTokensOut: state.totalTokensOut ?? 0,
        totalCost: state.totalCost ?? 0,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      },
      serverTime: new Date().toISOString(),
    });
    return;
  }

  // ── GET /api/agents ──────────────────────────────────────────────────
  if (pathname === "/api/agents") {
    const state = readJSON(SWARM_STATE_FILE, { agents: {} });
    const agents = Object.values(state.agents ?? {});
    sendJSON(res, {
      count: agents.length,
      agents,
    });
    return;
  }

  // ── GET /api/agents/:name ────────────────────────────────────────────
  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch) {
    const name = decodeURIComponent(agentMatch[1]);
    const state = readJSON(SWARM_STATE_FILE, { agents: {} });
    const agents = state.agents ?? {};
    const agent = Object.values(agents).find((a: any) =>
      a.name === name || a.id === name,
    );
    if (!agent) {
      sendError(res, 404, `Agent '${name}' not found`);
      return;
    }
    // Enrich with recent events
    const events = readJSONL(EVENTS_FILE).filter(
      (e) => e.source === name || e.target === name,
    ).slice(0, 50);
    sendJSON(res, {
      agent,
      recentEvents: events,
    });
    return;
  }

  // ── GET /api/events ──────────────────────────────────────────────────
  if (pathname === "/api/events") {
    let events = readJSONL(EVENTS_FILE);
    const limit = parseInt(query.get("limit") ?? "100", 10);
    const offset = parseInt(query.get("offset") ?? "0", 10);
    const agentFilter = query.get("agent");
    const typeFilter = query.get("type");

    if (agentFilter) {
      events = events.filter(
        (e) => e.source === agentFilter || e.target === agentFilter,
      );
    }
    if (typeFilter) {
      events = events.filter((e) =>
        e.event_type === typeFilter || e.event_type.includes(typeFilter!),
      );
    }

    const total = events.length;
    events = events.slice(offset, offset + limit);

    sendJSON(res, {
      count: events.length,
      total,
      offset,
      limit,
      events,
    });
    return;
  }

  // ── GET /api/hypotheses ──────────────────────────────────────────────
  if (pathname === "/api/hypotheses") {
    const state = readJSON(SWARM_STATE_FILE, { hypotheses: {} });
    const hypotheses = Object.values(state.hypotheses ?? {});
    sendJSON(res, {
      count: hypotheses.length,
      hypotheses,
    });
    return;
  }

  // ── GET /api/hypotheses/:id ──────────────────────────────────────────
  const hypMatch = pathname.match(/^\/api\/hypotheses\/([^/]+)$/);
  if (hypMatch) {
    const id = decodeURIComponent(hypMatch[1]);
    const state = readJSON(SWARM_STATE_FILE, { hypotheses: {} });
    const hyps = state.hypotheses ?? {};
    const hyp = hyps[id];
    if (!hyp) {
      sendError(res, 404, `Hypothesis '${id}' not found`);
      return;
    }
    // Build timeline from event log
    const allEvents = readJSONL(EVENTS_FILE);
    const timeline = allEvents.filter(
      (e) =>
        e.target === id ||
        e.source === id ||
        (e.data as any)?.hypothesisId === id,
    );
    sendJSON(res, {
      hypothesis: hyp,
      timeline,
    });
    return;
  }

  // ── GET /api/findings ────────────────────────────────────────────────
  if (pathname === "/api/findings") {
    const state = readJSON(SWARM_STATE_FILE, { findings: {} });
    const findings = Object.values(state.findings ?? {});
    sendJSON(res, {
      count: findings.length,
      findings,
    });
    return;
  }

  // ── GET /api/tasks ───────────────────────────────────────────────────
  if (pathname === "/api/tasks") {
    const taskGraph = readJSON(TASK_GRAPH_FILE, { tasks: [], counter: 0 });
    sendJSON(res, {
      count: taskGraph.tasks?.length ?? 0,
      counter: taskGraph.counter ?? 0,
      tasks: taskGraph.tasks ?? [],
    });
    return;
  }

  // ── GET /api/graph ───────────────────────────────────────────────────
  if (pathname === "/api/graph") {
    const secGraph = readJSON(SECURITY_GRAPH_FILE, { nodes: [], edges: [] });
    sendJSON(res, {
      nodes: secGraph.nodes ?? [],
      edges: secGraph.edges ?? [],
      meta: secGraph.meta ?? {},
      nodeCount: (secGraph.nodes ?? []).length,
      edgeCount: (secGraph.edges ?? []).length,
    });
    return;
  }

  // ── GET /api/graph/chains ────────────────────────────────────────────
  if (pathname === "/api/graph/chains") {
    const secGraph = readJSON(SECURITY_GRAPH_FILE, { nodes: [], edges: [] });
    const nodes = secGraph.nodes ?? [];
    const edges = secGraph.edges ?? [];

    // Find nodes with severity critical or high — potential chain endpoints
    const criticalNodes = nodes.filter(
      (n: any) => n.severity === "critical" || n.severity === "high",
    );

    // Build adjacency list
    const adj: Record<string, string[]> = {};
    for (const edge of edges) {
      if (!adj[edge.from]) adj[edge.from] = [];
      adj[edge.from].push(edge.to);
    }

    // Simple DFS to find paths to critical nodes
    const chains: Array<{ path: string[]; nodes: any[] }> = [];
    const maxDepth = 10;

    function dfs(current: string, visited: Set<string>, path: string[]): void {
      if (chains.length >= 50) return;
      if (path.length > maxDepth) return;

      const node = nodes.find((n: any) => n.id === current);
      if (node && (node.severity === "critical" || node.severity === "high") && path.length > 1) {
        const pathNodes = path
          .map((id) => nodes.find((n: any) => n.id === id))
          .filter(Boolean);
        chains.push({ path: [...path], nodes: pathNodes });
      }

      const neighbors = adj[current] ?? [];
      for (const next of neighbors) {
        if (visited.has(next)) continue;
        visited.add(next);
        dfs(next, visited, [...path, next]);
        visited.delete(next);
      }
    }

    for (const node of nodes) {
      if (!adj[(node as any).id]) continue;
      dfs((node as any).id, new Set([(node as any).id]), [(node as any).id]);
    }

    sendJSON(res, {
      count: chains.length,
      chains: chains.slice(0, 50),
    });
    return;
  }

  // ── GET /api/scope ───────────────────────────────────────────────────
  if (pathname === "/api/scope") {
    const scope = readYAML(SCOPE_FILE, { authorized: false, targets: [], excluded: [], enforce: true });
    // Also check profile.json for authoritative scope
    const profilePath = path.join(os.homedir(), ".pi", "agent", "profiles", "sec", "profile.json");
    const profile = readJSON(profilePath, { scope: null });
    const mergedScope = profile.scope ?? scope;
    sendJSON(res, mergedScope);
    return;
  }

  // ── GET /api/cost ────────────────────────────────────────────────────
  if (pathname === "/api/cost") {
    const state = readJSON(SWARM_STATE_FILE, {
      agents: {}, totalTokensIn: 0, totalTokensOut: 0, totalCost: 0,
    });
    const agents = Object.values(state.agents ?? {});

    // Group by model
    const byModel: Record<string, { tokensIn: number; tokensOut: number; cost: number; agents: number }> = {};
    for (const agent of agents as any[]) {
      const model = agent.model ?? "unknown";
      if (!byModel[model]) byModel[model] = { tokensIn: 0, tokensOut: 0, cost: 0, agents: 0 };
      byModel[model].tokensIn += agent.tokensIn ?? 0;
      byModel[model].tokensOut += agent.tokensOut ?? 0;
      byModel[model].cost += agent.estimatedCost ?? 0;
      byModel[model].agents++;
    }

    sendJSON(res, {
      totalTokensIn: state.totalTokensIn ?? 0,
      totalTokensOut: state.totalTokensOut ?? 0,
      totalCost: state.totalCost ?? 0,
      byModel,
      byAgent: agents.map((a: any) => ({
        id: a.id,
        name: a.name,
        model: a.model,
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
        cost: a.estimatedCost,
        status: a.status,
      })),
    });
    return;
  }

  // ── GET /api/replay/:investigationId ────────────────────────────────
  const replayMatch = pathname.match(/^\/api\/replay\/([^/]+)$/);
  if (replayMatch) {
    const investigationId = decodeURIComponent(replayMatch[1]);
    const allEvents = readJSONL(EVENTS_FILE);
    // Filter events that belong to this investigation
    const events = allEvents.filter(
      (e) =>
        (e.data as any)?.investigationId === investigationId ||
        (e.data as any)?.investigation === investigationId ||
        e.source === investigationId ||
        e.target === investigationId,
    );

    if (events.length === 0) {
      sendError(res, 404, `No events found for investigation '${investigationId}'`);
      return;
    }

    sendJSON(res, {
      investigationId,
      eventCount: events.length,
      firstEvent: events[0],
      lastEvent: events[events.length - 1],
      events,
    });
    return;
  }

  // ── Fallback ─────────────────────────────────────────────────────────
  sendError(res, 404, `API endpoint not found: ${pathname}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Server Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

const serverState: ServerState = {
  server: null,
  wss: null,
  clients: new Set(),
  eventSubscriptions: [],
  startedAt: null,
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
};

function startServer(pi: ExtensionAPI): Promise<string> {
  if (serverState.server) {
    return Promise.resolve(`${C.yellow}⚠ Web console already running on ${serverState.host}:${serverState.port}${C.reset}`);
  }

  const port = parseInt(process.env.PI_SEC_WEB_PORT ?? String(DEFAULT_PORT), 10);
  const host = process.env.PI_SEC_WEB_HOST ?? DEFAULT_HOST;
  const isRemote = host !== "localhost" && host !== "127.0.0.1";
  const token = process.env.PI_SEC_WEB_TOKEN;

  if (isRemote && !token) {
    return Promise.resolve(`${C.red}✗ Remote access (host=${host}) requires PI_SEC_WEB_TOKEN to be set${C.reset}\n` +
      `  Set it with: export PI_SEC_WEB_TOKEN=<your-secret>`);
  }

  // ── HTTP Server ──────────────────────────────────────────────────────
  serverState.server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    const parsed = url.parse(req.url ?? "/", true);
    const pathname = parsed.pathname ?? "/";
    const query = parsed.query as URLSearchParams & Record<string, string>;

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    // Auth check for API and WS upgrade requests
    if (isRemote) {
      // Token check for API routes
      if (pathname.startsWith("/api/") || pathname.startsWith("/ws")) {
        if (!checkAuth(req, true, token!)) {
          sendError(res, 401, "Authentication required. Provide Bearer token in Authorization header.");
          return;
        }
      }
    }

    // ── API Routes ─────────────────────────────────────────────────────
    if (pathname.startsWith("/api/")) {
      handleApiRequest(req, res, pathname, query);
      return;
    }

    // ── Static Files ───────────────────────────────────────────────────
    if (pathname === "/" || pathname === "/index.html") {
      serveStatic(req, res, path.join(PUBLIC_DIR, "index.html"));
      return;
    }

    // Prevent path traversal
    const requestedPath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(PUBLIC_DIR, requestedPath);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      sendError(res, 403, "Forbidden");
      return;
    }
    serveStatic(req, res, filePath);
  });

  // ── WebSocket Server ─────────────────────────────────────────────────
  serverState.wss = new WebSocketServer({ noServer: true });

  serverState.server.on("upgrade", (req: http.IncomingMessage, socket: any, head: Buffer) => {
    const parsed = url.parse(req.url ?? "/", true);

    // Only handle /ws upgrade
    if (parsed.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    // Auth check for remote
    if (isRemote) {
      const auth = req.headers.authorization;
      const queryToken = (parsed.query as any)?.token;
      if (!token || (auth?.slice(7) !== token && queryToken !== token)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    serverState.wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      serverState.wss!.emit("connection", ws, req);
    });
  });

  serverState.wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
    const parsed = url.parse(req.url ?? "/ws", true);
    const query = parsed.query;
    const filterAgent = (query as any)?.agent as string | undefined;
    const filterType = (query as any)?.type as string | undefined;

    serverState.clients.add(ws);

    // Send snapshot on connect
    const snapshot = buildSnapshot();
    ws.send(JSON.stringify(snapshot));

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        // Support client requesting a fresh snapshot
        if (msg.type === "snapshot") {
          ws.send(JSON.stringify(buildSnapshot()));
        }
      } catch {
        // ignore malformed client messages
      }
    });

    ws.on("close", () => {
      serverState.clients.delete(ws);
    });

    ws.on("error", () => {
      serverState.clients.delete(ws);
    });

    // Store filter context on the ws object for event filtering
    (ws as any)._filter = { agent: filterAgent, type: filterType };
  });

  // ── EventBus Subscriptions ───────────────────────────────────────────
  // Tap into pi.on() for all known event types. Each handler captures the
  // event, persists it to events.jsonl, and broadcasts to WS clients.

  const eventTypes = [...PI_EVENT_TYPES];

  // Also try to subscribe to a wildcard event if supported
  eventTypes.push("*" as any);

  for (const eventType of eventTypes) {
    try {
      const unsubscribe = pi.on(eventType as any, async (event: any) => {
        // Normalize the event into our SwarmEvent shape
        const swarmEvent: SwarmEvent = {
          id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          event_type: event?.event_type ?? event?.type ?? eventType,
          source: event?.source ?? event?.agent ?? "unknown",
          target: event?.target ?? "",
          data: event?.data ?? event?.detail ?? {},
          timestamp: event?.timestamp ?? new Date().toISOString(),
        };

        // Persist to events.jsonl
        appendJSONL(EVENTS_FILE, swarmEvent);

        // Broadcast to connected WS clients (respecting filters)
        const payload = JSON.stringify({ type: "event", event: swarmEvent });
        for (const client of serverState.clients) {
          if (client.readyState !== WebSocket.OPEN) continue;

          const filter = (client as any)._filter;
          if (filter?.agent) {
            if (
              swarmEvent.source !== filter.agent &&
              swarmEvent.target !== filter.agent
            ) {
              continue;
            }
          }
          if (filter?.type) {
            if (
              swarmEvent.event_type !== filter.type &&
              !swarmEvent.event_type.includes(filter.type)
            ) {
              continue;
            }
          }

          client.send(payload);
        }
      });

      // Store unsubscribe function if returned
      if (typeof unsubscribe === "function") {
        serverState.eventSubscriptions.push(unsubscribe);
      }
    } catch {
      // Event type may not be supported by this Pi version — skip silently
    }
  }

  // ── Start listening ──────────────────────────────────────────────────
  return new Promise<string>((resolve) => {
    serverState.server!.listen(port, host, () => {
      serverState.startedAt = new Date().toISOString();
      serverState.port = port;
      serverState.host = host;

      const lines: string[] = [];
      lines.push(`${C.bold}${C.cyan}╔════════════════════════════════════════════════════╗${C.reset}`);
      lines.push(`${C.bold}${C.cyan}║${C.reset}  ${C.bold}PI-SEC WEB CONSOLE${C.reset}                              ${C.cyan}║${C.reset}`);
      lines.push(`${C.bold}${C.cyan}╚════════════════════════════════════════════════════╝${C.reset}`);
      lines.push("");
      lines.push(`  ${C.green}✓${C.reset} Server running at ${C.bold}http://${host}:${port}${C.reset}`);
      lines.push(`  ${C.gray}┌─────────────────────────────────────────────┐${C.reset}`);
      lines.push(`  ${C.gray}│${C.reset}  REST API:   ${C.cyan}http://${host}:${port}/api/status${C.reset}      ${C.gray}│${C.reset}`);
      lines.push(`  ${C.gray}│${C.reset}  WebSocket: ${C.cyan}ws://${host}:${port}/ws${C.reset}              ${C.gray}│${C.reset}`);
      lines.push(`  ${C.gray}│${C.reset}  Static UI: ${C.cyan}http://${host}:${port}/${C.reset}                  ${C.gray}│${C.reset}`);
      lines.push(`  ${C.gray}└─────────────────────────────────────────────┘${C.reset}`);
      lines.push("");
      lines.push(`  ${C.gray}Auth:${C.reset}        ${isRemote ? `${C.yellow}bearer token required${C.reset}` : `${C.green}localhost (no auth)${C.reset}`}`);
      lines.push(`  ${C.gray}Event tap:${C.reset}    ${C.green}${eventTypes.length} event types subscribed${C.reset}`);
      lines.push(`  ${C.gray}Event log:${C.reset}     ${C.gray}${EVENTS_FILE}${C.reset}`);
      lines.push(`  ${C.gray}Static dir:${C.reset}    ${C.gray}${PUBLIC_DIR}${C.reset}`);
      lines.push(`  ${C.gray}Started:${C.reset}       ${C.gray}${serverState.startedAt}${C.reset}`);
      lines.push("");
      lines.push(`  ${C.dim}Stop with: /sec-web-stop${C.reset}`);

      resolve(lines.join("\n"));
    });

    serverState.server!.on("error", (err: any) => {
      serverState.server = null;
      serverState.wss = null;
      serverState.startedAt = null;

      if (err.code === "EADDRINUSE") {
        resolve(`${C.red}✗ Port ${port} is already in use. Set PI_SEC_WEB_PORT to a different port.${C.reset}`);
      } else {
        resolve(`${C.red}✗ Failed to start server: ${err.message}${C.reset}`);
      }
    });
  });
}

function stopServer(): Promise<string> {
  if (!serverState.server) {
    return Promise.resolve(`${C.yellow}⚠ Web console is not running${C.reset}`);
  }

  // Unsubscribe from EventBus
  for (const unsub of serverState.eventSubscriptions) {
    try {
      unsub();
    } catch {
      // ignore
    }
  }
  serverState.eventSubscriptions = [];

  // Close all WS clients
  for (const client of serverState.clients) {
    try {
      client.close(1001, "Server shutting down");
    } catch {
      // ignore
    }
  }
  serverState.clients.clear();

  // Close WS server
  if (serverState.wss) {
    serverState.wss.close();
    serverState.wss = null;
  }

  // Close HTTP server
  return new Promise<string>((resolve) => {
    serverState.server!.close(() => {
      serverState.server = null;
      serverState.startedAt = null;

      resolve([
        `${C.green}✓ Web console stopped${C.reset}`,
        `  ${C.gray}Port ${serverState.port} released${C.reset}`,
        `  ${C.gray}Event log preserved at ${EVENTS_FILE}${C.reset}`,
      ].join("\n"));
    });

    // Force-close after 2s if hanging
    setTimeout(() => {
      if (serverState.server) {
        serverState.server = null;
        serverState.startedAt = null;
        resolve(`${C.yellow}⚠ Web console force-stopped (connections terminated)${C.reset}`);
      }
    }, 2000);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  Extension Registration
// ═══════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {

  // ── Command: /sec-web ────────────────────────────────────────────────
  pi.registerCommand("sec-web", {
    description:
      "Start the pi-sec web console server. Provides HTTP REST API and WebSocket " +
      "streaming for real-time swarm monitoring. Config: PI_SEC_WEB_PORT (default 8787), " +
      "PI_SEC_WEB_HOST (default localhost), PI_SEC_WEB_TOKEN (required for remote).",
    handler: async (_args: string) => {
      return startServer(pi);
    },
  });

  // ── Command: /sec-web-stop ───────────────────────────────────────────
  pi.registerCommand("sec-web-stop", {
    description: "Stop the pi-sec web console server and release the port.",
    handler: async (_args: string) => {
      return stopServer();
    },
  });

  // ── Session cleanup ──────────────────────────────────────────────────
  pi.on("session_end", async () => {
    if (serverState.server) {
      await stopServer();
    }
  });
}
