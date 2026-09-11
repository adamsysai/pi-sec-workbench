/**
 * Security Graph — centralized security research graph for pi-sec
 *
 * Manages a persistent graph of security-relevant entities (hosts, services,
 * endpoints, credentials, findings, trust boundaries, etc.) and their relationships.
 * Supports querying, attack-chain discovery, and HTML visualization.
 *
 * Storage: ~/.pi/agent/sec-data/security-graph.json
 * Visual:  ~/.pi/agent/sec-data/security-graph.html
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Paths ───────────────────────────────────────────────────────────────────

const DATA_DIR   = path.resolve(process.env.PI_SEC_DATA_DIR || ".local/reference-data");
const GRAPH_FILE = path.join(DATA_DIR, "security-graph.json");
const HTML_FILE  = path.join(DATA_DIR, "security-graph.html");

// ─── Types ───────────────────────────────────────────────────────────────────

type NodeType =
  | "host" | "service" | "endpoint" | "api"
  | "user" | "identity" | "role" | "org"
  | "domain" | "subdomain"
  | "credential" | "token"
  | "workflow" | "permission" | "finding" | "hypothesis"
  | "trust_boundary" | "database" | "queue";

type Relationship =
  | "OWNS" | "ACCESSES" | "CALLS" | "TRUSTS" | "BELONGS_TO"
  | "AUTHENTICATES" | "AUTHORIZES" | "READS" | "WRITES"
  | "DEPENDS_ON" | "FLOWS_TO" | "EXPOSES" | "REQUIRES" | "ENABLES" | "COMBINES_WITH";

type Severity = "critical" | "high" | "medium" | "low" | "info";

interface SecNode {
  id: string;
  type: NodeType;
  label: string;
  detail?: string;
  severity?: Severity;
  metadata?: Record<string, string>;
  created?: string;
}

interface SecEdge {
  from: string;
  to: string;
  relationship: Relationship;
  detail?: string;
}

interface SecGraph {
  nodes: SecNode[];
  edges: SecEdge[];
  meta?: {
    target?: string;
    engagement?: string;
    updated?: string;
  };
}

// ─── Node metadata for attack-chain scoring ──────────────────────────────────

/** Privilege level per node type — higher = more impact if reached. */
const PRIVILEGE_LEVEL: Record<NodeType, number> = {
  trust_boundary: 0,
  domain: 1,
  subdomain: 1,
  org: 1,
  host: 2,
  queue: 2,
  database: 3,
  service: 3,
  endpoint: 3,
  api: 3,
  workflow: 3,
  permission: 4,
  role: 4,
  user: 4,
  identity: 5,
  credential: 5,
  token: 5,
  finding: 0,
  hypothesis: 0,
};

/** Relationships that represent privilege escalation or lateral movement. */
const ESCALATION_RELATIONSHIPS: Set<Relationship> = new Set([
  "ACCESSES", "AUTHENTICATES", "AUTHORIZES", "FLOWS_TO",
  "ENABLES", "COMBINES_WITH", "TRUSTS",
]);

/** Relationships that represent data flow or access. */
const ACCESS_RELATIONSHIPS: Set<Relationship> = new Set([
  "READS", "WRITES", "ACCESSES", "CALLS", "FLOWS_TO",
]);

// ─── Persistence ──────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function load(): SecGraph {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(GRAPH_FILE, "utf8"));
  } catch {
    return { nodes: [], edges: [], meta: {} };
  }
}

function save(g: SecGraph) {
  ensureDataDir();
  g.meta = { ...g.meta, updated: new Date().toISOString() };
  fs.writeFileSync(GRAPH_FILE, JSON.stringify(g, null, 2));
}

// ─── Graph operations ──────────────────────────────────────────────────────────

function findNode(g: SecGraph, id: string): SecNode | undefined {
  return g.nodes.find((n) => n.id === id);
}

function upsertNode(g: SecGraph, node: SecNode): void {
  const idx = g.nodes.findIndex((n) => n.id === node.id);
  if (idx >= 0) g.nodes[idx] = node;
  else g.nodes.push(node);
}

function addEdge(g: SecGraph, edge: SecEdge): void {
  // Prevent exact duplicates
  const dup = g.edges.find(
    (e) =>
      e.from === edge.from &&
      e.to === edge.to &&
      e.relationship === edge.relationship,
  );
  if (dup) {
    if (edge.detail) dup.detail = edge.detail;
    return;
  }
  g.edges.push(edge);
}

/** Build adjacency list (outgoing edges). */
function adjacency(g: SecGraph): Map<string, SecEdge[]> {
  const adj = new Map<string, SecEdge[]>();
  for (const n of g.nodes) adj.set(n.id, []);
  for (const e of g.edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e);
  }
  return adj;
}

/** BFS to find all paths from source to target (max depth to prevent explosion). */
function findPaths(
  g: SecGraph,
  source: string,
  target: string,
  maxDepth: number = 8,
): string[][] {
  const adj = adjacency(g);
  const paths: string[][] = [];
  const queue: { node: string; path: string[]; visited: Set<string> }[] = [
    { node: source, path: [source], visited: new Set([source]) },
  ];

  while (queue.length > 0 && paths.length < 20) {
    const { node, path, visited } = queue.shift()!;
    if (path.length - 1 >= maxDepth) continue;

    const neighbors = adj.get(node) ?? [];
    for (const edge of neighbors) {
      if (visited.has(edge.to)) continue;

      const newPath = [...path, edge.to];
      if (edge.to === target) {
        paths.push(newPath);
      } else if (newPath.length - 1 < maxDepth) {
        queue.push({
          node: edge.to,
          path: newPath,
          visited: new Set([...visited, edge.to]),
        });
      }
    }
  }

  return paths;
}

/**
 * Find attack chains — paths from low-privilege nodes to high-impact nodes
 * where edges represent escalation, access, or trust relationships.
 */
function findAttackChains(g: SecGraph, maxDepth: number = 10): {
  chains: { path: string[]; edges: SecEdge[]; start: SecNode; end: SecNode; score: number }[];
} {
  const adj = adjacency(g);
  const nodeMap = new Map(g.nodes.map((n) => [n.id, n]));

  // Low-privilege starting points (privilege 0-2)
  const lowPriv = g.nodes.filter((n) => PRIVILEGE_LEVEL[n.type] <= 2);
  // High-impact targets (privilege >= 4)
  const highImpact = g.nodes.filter((n) => PRIVILEGE_LEVEL[n.type] >= 4);

  const chains: { path: string[]; edges: SecEdge[]; start: SecNode; end: SecNode; score: number }[] = [];

  for (const start of lowPriv) {
    for (const end of highImpact) {
      if (start.id === end.id) continue;

      // BFS using only escalation/access/trust edges
      const queue: { node: string; path: string[]; edges: SecEdge[]; visited: Set<string> }[] = [
        { node: start.id, path: [start.id], edges: [], visited: new Set([start.id]) },
      ];

      while (queue.length > 0 && chains.length < 50) {
        const { node, path, edges, visited } = queue.shift()!;
        if (path.length - 1 >= maxDepth) continue;

        const neighbors = adj.get(node) ?? [];
        for (const edge of neighbors) {
          if (visited.has(edge.to)) continue;
          if (!ESCALATION_RELATIONSHIPS.has(edge.relationship) && !ACCESS_RELATIONSHIPS.has(edge.relationship)) continue;

          const newPath = [...path, edge.to];
          const newEdges = [...edges, edge];
          const endNode = nodeMap.get(edge.to);

          if (edge.to === end.id) {
            // Score: higher privilege gap + shorter path = higher score
            const privGap = PRIVILEGE_LEVEL[end.type] - PRIVILEGE_LEVEL[start.type];
            const score = privGap * 10 - (newPath.length - 1);
            chains.push({
              path: newPath,
              edges: newEdges,
              start,
              end,
              score: Math.max(score, 1),
            });
          } else if (newPath.length - 1 < maxDepth) {
            queue.push({
              node: edge.to,
              path: newPath,
              edges: newEdges,
              visited: new Set([...visited, edge.to]),
            });
          }
        }
      }
    }
  }

  chains.sort((a, b) => b.score - a.score);
  return { chains };
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function graphSummary(g: SecGraph): string {
  if (!g.nodes.length) return "(security graph empty — add nodes with sec_graph_add)";

  const byType = g.nodes.reduce((acc, n) => {
    acc[n.type] = (acc[n.type] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const byRel = g.edges.reduce((acc, e) => {
    acc[e.relationship] = (acc[e.relationship] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const findings = g.nodes.filter((n) => n.type === "finding");
  const critFindings = findings.filter((n) => n.severity === "critical" || n.severity === "high");
  const creds = g.nodes.filter((n) => n.type === "credential" || n.type === "token");
  const trustBoundaries = g.nodes.filter((n) => n.type === "trust_boundary");
  const hypotheses = g.nodes.filter((n) => n.type === "hypothesis");

  const chains = findAttackChains(g);
  const topChains = chains.chains.slice(0, 5);

  const lines = [
    "## Security Graph (current state)",
    "",
    `**Nodes**: ${g.nodes.length} | **Edges**: ${g.edges.length}`,
    "",
    "**By type**:",
    ...Object.entries(byType).map(([t, c]) => `  ${t}: ${c}`),
    "",
    byRel && Object.keys(byRel).length
      ? ["**By relationship**:", ...Object.entries(byRel).map(([r, c]) => `  ${r}: ${c}`)].join("\n")
      : "",
    "",
    trustBoundaries.length ? `**Trust boundaries**: ${trustBoundaries.map((n) => n.label).join(", ")}` : "",
    creds.length ? `**Credentials/tokens**: ${creds.length} found` : "",
    findings.length ? `**Findings**: ${findings.length} (${critFindings.length} critical/high)` : "",
    hypotheses.length ? `**Hypotheses**: ${hypotheses.length} open` : "",
    "",
    topChains.length
      ? [
          "**Top attack chains**:",
          ...topChains.map((c, i) =>
            `  ${i + 1}. ${c.start.label} → ${c.end.label} (${c.path.length - 1} hops, score ${c.score})`,
          ),
        ].join("\n")
      : "",
    "",
    `Data: ${GRAPH_FILE}`,
    `Visual: ${HTML_FILE}`,
  ];

  return lines.filter((l) => l !== "" || true).join("\n");
}

// ─── HTML visualization ───────────────────────────────────────────────────────

function generateHtml(g: SecGraph): string {
  const colors: Record<NodeType, string> = {
    host:           "#4fc3f7",
    service:        "#ffb74d",
    endpoint:       "#4dd0e1",
    api:            "#26c6da",
    user:           "#ab47bc",
    identity:       "#7e57c2",
    role:           "#ba68c8",
    org:            "#78909c",
    domain:         "#ce93d8",
    subdomain:      "#f48fb1",
    credential:     "#ffd54f",
    token:          "#ffca28",
    workflow:       "#66bb6a",
    permission:     "#ef5350",
    finding:        "#f44336",
    hypothesis:     "#ffa726",
    trust_boundary: "#5c6bc0",
    database:       "#8d6e63",
    queue:          "#789262",
  };

  const severityBorder: Record<Severity, string> = {
    critical: "#b71c1c",
    high:     "#e53935",
    medium:   "#fb8c00",
    low:      "#fdd835",
    info:     "#78909c",
  };

  const visNodes = g.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    title:
      `<b>${n.type.toUpperCase()}</b>` +
      (n.severity ? ` [${n.severity}]` : "") +
      `<br>${n.detail ?? ""}` +
      (n.metadata ? `<br><pre>${JSON.stringify(n.metadata, null, 0)}</pre>` : ""),
    color: {
      background: colors[n.type] ?? "#90a4ae",
      border: n.severity ? (severityBorder[n.severity] ?? "#546e7a") : "#546e7a",
      highlight: { background: "#ffffff", border: "#1565c0" },
    },
    borderWidth: n.severity === "critical" ? 4 : n.severity === "high" ? 3 : 2,
    font: { color: "#111", size: 13, bold: n.type === "trust_boundary" || n.type === "finding" },
    shape:
      n.type === "trust_boundary" ? "box"
      : n.type === "finding" || n.type === "hypothesis" ? "diamond"
      : n.type === "credential" || n.type === "token" ? "star"
      : n.type === "permission" || n.type === "role" ? "triangle"
      : n.type === "database" || n.type === "queue" ? "hexagon"
      : "ellipse",
    size: n.type === "trust_boundary" ? 30 : n.type === "finding" ? 25 : 18,
  }));

  const visEdges = g.edges.map((e, i) => ({
    id: i,
    from: e.from,
    to: e.to,
    label: e.relationship,
    arrows: "to",
    color: {
      color: ESCALATION_RELATIONSHIPS.has(e.relationship) ? "#ef5350" : "#78909c",
      highlight: "#1565c0",
    },
    font: {
      size: 11,
      color: ESCALATION_RELATIONSHIPS.has(e.relationship) ? "#ef5350" : "#546e7a",
    },
    dashes: ACCESS_RELATIONSHIPS.has(e.relationship) && !ESCALATION_RELATIONSHIPS.has(e.relationship),
  }));

  const legend = Object.entries(colors)
    .map(([type, color]) => `<span class="badge" style="background:${color}">${type}</span>`)
    .join(" ");

  // Compute attack chains for the dashboard
  const chains = findAttackChains(g);
  const chainHtml = chains.chains.slice(0, 10).map((c, i) => {
    const pathStr = c.path
      .map((id) => {
        const node = g.nodes.find((n) => n.id === id);
        return node ? node.label : id;
      })
      .join(" → ");
    const edgeStr = c.edges.map((e) => e.relationship).join(" → ");
    return `<tr><td>${i + 1}</td><td>${c.start.label}</td><td>${c.end.label}</td><td>${c.path.length - 1}</td><td>${c.score}</td><td class="path">${pathStr}</td><td class="path">${edgeStr}</td></tr>`;
  }).join("");

  const byTypeStats = g.nodes.reduce((acc, n) => {
    acc[n.type] = (acc[n.type] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Security Graph${g.meta?.target ? " — " + g.meta.target : ""}</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d1117; color: #e6edf3; font-family: 'Segoe UI', system-ui, sans-serif; height: 100vh; display: flex; flex-direction: column; }
  header { padding: 12px 20px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 15px; font-weight: 600; color: #58a6ff; }
  header .meta { font-size: 12px; color: #8b949e; }
  .legend { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }
  .badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; color: #111; }
  #graph { flex: 1; min-height: 400px; }
  #detail { position: fixed; bottom: 0; left: 0; right: 0; background: #161b22; border-top: 1px solid #30363d; padding: 10px 20px; font-size: 12px; color: #8b949e; max-height: 120px; overflow-y: auto; }
  #detail b { color: #58a6ff; }
  .stats { display: flex; gap: 20px; padding: 8px 20px; background: #0d1117; border-bottom: 1px solid #21262d; font-size: 12px; color: #8b949e; flex-wrap: wrap; }
  .stat { display: flex; gap: 6px; align-items: center; }
  .stat b { color: #e6edf3; }
  .stat .critical { color: #ef5350; }
  .stat .warn { color: #ffd54f; }
  #chains { background: #161b22; border-top: 1px solid #30363d; padding: 12px 20px; max-height: 300px; overflow-y: auto; }
  #chains h2 { font-size: 13px; color: #f85149; margin-bottom: 8px; }
  #chains table { width: 100%; border-collapse: collapse; font-size: 11px; }
  #chains th, #chains td { padding: 4px 8px; text-align: left; border-bottom: 1px solid #21262d; }
  #chains th { color: #8b949e; font-weight: 600; text-transform: uppercase; font-size: 10px; }
  #chains td.path { color: #8b949e; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #chains td.path:hover { white-space: normal; overflow: visible; }
  #chains tr:hover { background: #1c2128; }
</style>
</head>
<body>
<header>
  <h1>Security Graph${g.meta?.target ? " — " + g.meta.target : ""}</h1>
  <span class="meta">${g.meta?.updated ? new Date(g.meta.updated).toLocaleString() : new Date().toLocaleString()}</span>
  <div class="legend">${legend}</div>
</header>
<div class="stats">
  <div class="stat">Nodes: <b>${g.nodes.length}</b></div>
  <div class="stat">Edges: <b>${g.edges.length}</b></div>
  <div class="stat">Hosts: <b>${byTypeStats.host ?? 0}</b></div>
  <div class="stat">Services: <b>${byTypeStats.service ?? 0}</b></div>
  <div class="stat">Endpoints: <b>${byTypeStats.endpoint ?? 0}</b></div>
  <div class="stat">APIs: <b>${byTypeStats.api ?? 0}</b></div>
  <div class="stat">Findings: <b class="critical">${byTypeStats.finding ?? 0}</b></div>
  <div class="stat">Credentials: <b class="warn">${(byTypeStats.credential ?? 0) + (byTypeStats.token ?? 0)}</b></div>
  <div class="stat">Trust Boundaries: <b>${byTypeStats.trust_boundary ?? 0}</b></div>
  <div class="stat">Attack Chains: <b class="critical">${chains.chains.length}</b></div>
</div>
<div id="graph"></div>
${chains.chains.length ? `
<div id="chains">
  <h2>Attack Chains (top ${Math.min(chains.chains.length, 10)} of ${chains.chains.length})</h2>
  <table>
    <thead><tr><th>#</th><th>Start</th><th>Target</th><th>Hops</th><th>Score</th><th>Path</th><th>Edges</th></tr></thead>
    <tbody>${chainHtml}</tbody>
  </table>
</div>
` : ""}
<div id="detail">Click on a node to see details</div>
<script>
const nodes = new vis.DataSet(${JSON.stringify(visNodes)});
const edges = new vis.DataSet(${JSON.stringify(visEdges)});
const container = document.getElementById("graph");
const network = new vis.Network(container, { nodes, edges }, {
  physics: { solver: "forceAtlas2Based", forceAtlas2Based: { gravitationalConstant: -60, springLength: 120 }, stabilization: { iterations: 150 } },
  interaction: { hover: true, tooltipDelay: 100, multiselect: true },
  layout: { improvedLayout: true },
});
network.on("click", (e) => {
  const nodeId = e.nodes[0];
  if (!nodeId) { document.getElementById("detail").innerHTML = "Click on a node to see details"; return; }
  const n = nodes.get(nodeId);
  document.getElementById("detail").innerHTML = n.title || n.label;
});
network.on("stabilizationIterationsDone", () => network.fit({ animation: { duration: 500 } }));
</script>
</body>
</html>`;
}

// ─── Extension registration ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // Inject graph summary as context at the start of each agent turn
  pi.on("before_agent_start", async (event: any) => {
    const g = load();
    if (!g.nodes.length) return;
    const summary = graphSummary(g);
    if (!summary) return;
    return { systemPrompt: (event.systemPrompt ?? "") + "\n\n" + summary };
  });

  // ── sec_graph_add ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "sec_graph_add",
    description:
      "Add or update a node in the security graph. Use for hosts, services, endpoints, APIs, users, identities, roles, orgs, domains, subdomains, credentials, tokens, workflows, permissions, findings, hypotheses, trust boundaries, databases, and queues.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Unique node ID (e.g. 'host:10.0.0.1', 'api:/v1/users', 'cred:aws-root', 'finding:sqli-login')",
        },
        type: {
          type: "string",
          enum: [
            "host", "service", "endpoint", "api",
            "user", "identity", "role", "org",
            "domain", "subdomain",
            "credential", "token",
            "workflow", "permission", "finding", "hypothesis",
            "trust_boundary", "database", "queue",
          ],
          description: "Node type",
        },
        label: { type: "string", description: "Short display label" },
        detail: { type: "string", description: "Detailed info (version, evidence, CVSS, etc.)" },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low", "info"],
          description: "Severity level (especially for findings)",
        },
        metadata: {
          type: "object",
          description: "Additional key-value metadata (e.g. { port: '443', version: 'Apache 2.4.49' })",
          additionalProperties: { type: "string" },
        },
      },
      required: ["id", "type", "label"],
    },
    execute: async (params: any) => {
      const g = load();
      const node: SecNode = {
        id: params.id,
        type: params.type,
        label: params.label,
        detail: params.detail,
        severity: params.severity,
        metadata: params.metadata,
        created: new Date().toISOString(),
      };
      // Preserve original creation timestamp on update
      const existing = findNode(g, params.id);
      if (existing?.created) node.created = existing.created;

      upsertNode(g, node);
      save(g);
      fs.writeFileSync(HTML_FILE, generateHtml(g));

      return {
        content: `✓ ${params.type}: ${params.label} → security graph updated (${g.nodes.length} nodes, ${g.edges.length} edges)`,
      };
    },
  });

  // ── sec_graph_link ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "sec_graph_link",
    description:
      "Create a directed edge between two security graph nodes. Relationships: OWNS, ACCESSES, CALLS, TRUSTS, BELONGS_TO, AUTHENTICATES, AUTHORIZES, READS, WRITES, DEPENDS_ON, FLOWS_TO, EXPOSES, REQUIRES, ENABLES, COMBINES_WITH.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source node ID" },
        to: { type: "string", description: "Target node ID" },
        relationship: {
          type: "string",
          enum: [
            "OWNS", "ACCESSES", "CALLS", "TRUSTS", "BELONGS_TO",
            "AUTHENTICATES", "AUTHORIZES", "READS", "WRITES",
            "DEPENDS_ON", "FLOWS_TO", "EXPOSES", "REQUIRES", "ENABLES", "COMBINES_WITH",
          ],
          description: "Type of relationship from source to target",
        },
        detail: { type: "string", description: "Optional detail about the relationship" },
      },
      required: ["from", "to", "relationship"],
    },
    execute: async (params: any) => {
      const g = load();

      // Warn if nodes don't exist (but still allow — may be added later)
      const warnings: string[] = [];
      if (!findNode(g, params.from)) warnings.push(`⚠ Source node '${params.from}' not in graph`);
      if (!findNode(g, params.to)) warnings.push(`⚠ Target node '${params.to}' not in graph`);

      const edge: SecEdge = {
        from: params.from,
        to: params.to,
        relationship: params.relationship,
        detail: params.detail,
      };
      addEdge(g, edge);
      save(g);
      fs.writeFileSync(HTML_FILE, generateHtml(g));

      return {
        content: `✓ ${params.from} ──${params.relationship}──► ${params.to}` +
          (warnings.length ? `\n${warnings.join("\n")}` : ""),
      };
    },
  });

  // ── sec_graph_query ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "sec_graph_query",
    description:
      "Query the security graph. Filter by node type, by relationship type, find paths between two nodes, or search by text. Returns matching nodes, edges, or paths.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["by_type", "by_relationship", "paths", "search", "neighbors"],
          description: "Query mode: by_type (filter nodes by type), by_relationship (filter edges), paths (find paths between two nodes), search (text search across all nodes), neighbors (get neighbors of a node)",
        },
        node_type: {
          type: "string",
          description: "For by_type mode: filter nodes by this type",
        },
        relationship: {
          type: "string",
          description: "For by_relationship mode: filter edges by this relationship",
        },
        source: {
          type: "string",
          description: "For paths/neighbors mode: source node ID",
        },
        target: {
          type: "string",
          description: "For paths mode: target node ID",
        },
        search: {
          type: "string",
          description: "For search mode: text to search in node labels, details, and IDs",
        },
        max_depth: {
          type: "number",
          description: "For paths mode: maximum path depth (default 8)",
        },
        direction: {
          type: "string",
          enum: ["out", "in", "both"],
          description: "For neighbors mode: edge direction (default: both)",
        },
      },
      required: ["mode"],
    },
    execute: async (params: any) => {
      const g = load();

      switch (params.mode) {
        case "by_type": {
          const filtered = g.nodes.filter((n) => n.type === params.node_type);
          return {
            content: JSON.stringify({
              mode: "by_type",
              type: params.node_type,
              count: filtered.length,
              nodes: filtered.map((n) => ({ id: n.id, label: n.label, severity: n.severity, detail: n.detail })),
            }, null, 2),
          };
        }

        case "by_relationship": {
          const filtered = g.edges.filter((e) => e.relationship === params.relationship);
          return {
            content: JSON.stringify({
              mode: "by_relationship",
              relationship: params.relationship,
              count: filtered.length,
              edges: filtered.map((e) => ({
                from: e.from,
                to: e.to,
                relationship: e.relationship,
                detail: e.detail,
              })),
            }, null, 2),
          };
        }

        case "paths": {
          if (!params.source || !params.target) {
            return { content: "Error: paths mode requires 'source' and 'target' parameters" };
          }
          const maxDepth = params.max_depth ?? 8;
          const paths = findPaths(g, params.source, params.target, maxDepth);
          return {
            content: JSON.stringify({
              mode: "paths",
              source: params.source,
              target: params.target,
              count: paths.length,
              max_depth: maxDepth,
              paths: paths.map((p) => {
                const pathLabels = p.map((id) => {
                  const node = findNode(g, id);
                  return node ? node.label : id;
                });
                // Collect edges along the path
                const pathEdges: string[] = [];
                for (let i = 0; i < p.length - 1; i++) {
                  const edge = g.edges.find(
                    (e) => e.from === p[i] && e.to === p[i + 1],
                  );
                  pathEdges.push(edge ? edge.relationship : "?");
                }
                return { path: pathLabels, edges: pathEdges };
              }),
            }, null, 2),
          };
        }

        case "search": {
          if (!params.search) {
            return { content: "Error: search mode requires 'search' parameter" };
          }
          const q = params.search.toLowerCase();
          const nodeMatches = g.nodes.filter(
            (n) =>
              n.id.toLowerCase().includes(q) ||
              n.label.toLowerCase().includes(q) ||
              (n.detail?.toLowerCase().includes(q) ?? false),
          );
          const edgeMatches = g.edges.filter(
            (e) =>
              e.from.toLowerCase().includes(q) ||
              e.to.toLowerCase().includes(q) ||
              e.relationship.toLowerCase().includes(q) ||
              (e.detail?.toLowerCase().includes(q) ?? false),
          );
          return {
            content: JSON.stringify({
              mode: "search",
              query: params.search,
              nodes_found: nodeMatches.length,
              edges_found: edgeMatches.length,
              nodes: nodeMatches.map((n) => ({ id: n.id, type: n.type, label: n.label, severity: n.severity })),
              edges: edgeMatches.map((e) => ({ from: e.from, to: e.to, relationship: e.relationship })),
            }, null, 2),
          };
        }

        case "neighbors": {
          if (!params.source) {
            return { content: "Error: neighbors mode requires 'source' parameter" };
          }
          const dir = params.direction ?? "both";
          const outEdges = dir === "in" ? [] : g.edges.filter((e) => e.from === params.source);
          const inEdges = dir === "out" ? [] : g.edges.filter((e) => e.to === params.source);

          const neighborIds = new Set<string>();
          for (const e of outEdges) neighborIds.add(e.to);
          for (const e of inEdges) neighborIds.add(e.from);

          const neighbors = [...neighborIds]
            .map((id) => findNode(g, id))
            .filter(Boolean);

          return {
            content: JSON.stringify({
              mode: "neighbors",
              source: params.source,
              direction: dir,
              count: neighbors.length,
              outgoing: outEdges.map((e) => ({ to: e.to, relationship: e.relationship, detail: e.detail })),
              incoming: inEdges.map((e) => ({ from: e.from, relationship: e.relationship, detail: e.detail })),
              neighbors: neighbors.map((n) => ({ id: n!.id, type: n!.type, label: n!.label })),
            }, null, 2),
          };
        }

        default:
          return { content: `Unknown mode: ${params.mode}` };
      }
    },
  });

  // ── sec_graph_find_chains ────────────────────────────────────────────────────

  pi.registerTool({
    name: "sec_graph_find_chains",
    description:
      "Find attack chains in the security graph — paths from low-privilege nodes (hosts, domains, subdomains, trust boundaries) to high-impact nodes (credentials, tokens, identities, users, roles). Chains are scored by privilege gap and path length. Only follows escalation/access/trust relationships.",
    parameters: {
      type: "object",
      properties: {
        max_depth: {
          type: "number",
          description: "Maximum chain length in hops (default 10)",
        },
        min_score: {
          type: "number",
          description: "Minimum score to include (default 0, higher = more dangerous)",
        },
        source: {
          type: "string",
          description: "Optional: only chains starting from this node ID",
        },
        target: {
          type: "string",
          description: "Optional: only chains ending at this node ID",
        },
        limit: {
          type: "number",
          description: "Maximum number of chains to return (default 20)",
        },
      },
    },
    execute: async (params: any) => {
      const g = load();

      if (g.nodes.length === 0) {
        return { content: "Security graph is empty. Add nodes with sec_graph_add first." };
      }

      const maxDepth = params.max_depth ?? 10;
      const minScore = params.min_score ?? 0;
      const limit = params.limit ?? 20;

      // If source/target specified, do targeted path finding
      if (params.source && params.target) {
        const paths = findPaths(g, params.source, params.target, maxDepth);
        const nodeMap = new Map(g.nodes.map((n) => [n.id, n]));
        const result = paths.map((p) => {
          const pathEdges: SecEdge[] = [];
          for (let i = 0; i < p.length - 1; i++) {
            const edge = g.edges.find((e) => e.from === p[i] && e.to === p[i + 1]);
            if (edge) pathEdges.push(edge);
          }
          const startNode = nodeMap.get(p[0]);
          const endNode = nodeMap.get(p[p.length - 1]);
          const privGap = startNode && endNode
            ? PRIVILEGE_LEVEL[endNode.type] - PRIVILEGE_LEVEL[startNode.type]
            : 0;
          return {
            path: p.map((id) => {
              const node = nodeMap.get(id);
              return node ? `${node.label} [${node.type}]` : id;
            }),
            edges: pathEdges.map((e) => e.relationship),
            hops: p.length - 1,
            score: Math.max(privGap * 10 - (p.length - 1), 1),
          };
        });
        return {
          content: JSON.stringify({
            mode: "targeted",
            source: params.source,
            target: params.target,
            chains_found: result.length,
            chains: result,
          }, null, 2),
        };
      }

      // Full attack chain analysis
      let { chains } = findAttackChains(g, maxDepth);

      // Filter by source/target if specified
      if (params.source) chains = chains.filter((c) => c.start.id === params.source);
      if (params.target) chains = chains.filter((c) => c.end.id === params.target);

      // Filter by min score
      chains = chains.filter((c) => c.score >= minScore);

      // Limit
      const truncated = chains.length > limit;
      const displayed = chains.slice(0, limit);

      const result = displayed.map((c) => ({
        start: { id: c.start.id, type: c.start.type, label: c.start.label },
        end: { id: c.end.id, type: c.end.type, label: c.end.label },
        hops: c.path.length - 1,
        score: c.score,
        path: c.path.map((id) => {
          const node = g.nodes.find((n) => n.id === id);
          return node ? `${node.label} [${node.type}]` : id;
        }),
        edges: c.edges.map((e) => e.relationship),
      }));

      return {
        content: JSON.stringify({
          total_chains: chains.length,
          showing: result.length,
          truncated,
          max_depth: maxDepth,
          chains: result,
        }, null, 2),
      };
    },
  });

  // ── sec_graph_export ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: "sec_graph_export",
    description:
      "Export the security graph as JSON and generate an interactive HTML visualization with attack chain analysis. Returns file paths.",
    parameters: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["json", "html", "both"],
          description: "Export format (default: both)",
        },
        include_chains: {
          type: "boolean",
          description: "Include attack chain analysis in the export (default: true)",
        },
      },
    },
    execute: async (params: any) => {
      const g = load();
      const format = params.format ?? "both";
      const includeChains = params.include_chains ?? true;
      const files: string[] = [];

      if (format === "json" || format === "both") {
        ensureDataDir();
        const exportData = {
          ...g,
          ...(includeChains ? { attack_chains: findAttackChains(g).chains.slice(0, 50) } : {}),
        };
        const jsonPath = path.join(DATA_DIR, "security-graph-export.json");
        fs.writeFileSync(jsonPath, JSON.stringify(exportData, null, 2));
        files.push(`JSON: ${jsonPath}`);
      }

      if (format === "html" || format === "both") {
        ensureDataDir();
        fs.writeFileSync(HTML_FILE, generateHtml(g));
        files.push(`HTML: ${HTML_FILE}`);
      }

      return {
        content: `Security graph exported:\n${files.join("\n")}\n\nGraph stats: ${g.nodes.length} nodes, ${g.edges.length} edges` +
          (includeChains ? `, ${findAttackChains(g).chains.length} attack chains found` : ""),
      };
    },
  });

  // ── /sec-graph command ───────────────────────────────────────────────────────

  pi.registerCommand("sec-graph", {
    description: "Show security graph summary, node/edge counts, and attack chain overview",
    handler: async (_args: string) => {
      const g = load();
      return graphSummary(g);
    },
  });
}
