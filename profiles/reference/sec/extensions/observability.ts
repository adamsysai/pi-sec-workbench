/**
 * Swarm Observability — live swarm status, activity tracking, and cost breakdown
 *
 * State persists at ~/.pi/agent/sec-data/swarm-state.json
 *
 * Tools:
 *   swarm_status   — structured JSON snapshot of the entire swarm
 *   swarm_activity — recent activity log with filters
 *   swarm_cost     — cost breakdown by agent and task
 *
 * Command:
 *   /swarm — renders a live status dashboard
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ═══════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════

type AgentStatus = "online" | "working" | "idle" | "blocked" | "failed";
type TaskStatus = "pending" | "running" | "completed" | "blocked";
type HypothesisStatus =
  | "created"
  | "investigating"
  | "criticized"
  | "validating"
  | "confirmed"
  | "rejected";
type FindingConfidence = "high" | "medium" | "rejected";

interface Agent {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  lastSeen: string;       // ISO timestamp
  currentTask?: string;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  model: string;
  estimatedCost: number;  // USD
}

interface Task {
  id: string;
  title: string;
  assignedTo: string;     // agent id
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  tokensIn: number;
  tokensOut: number;
  estimatedCost: number;
  model: string;
}

interface Hypothesis {
  id: string;
  text: string;
  status: HypothesisStatus;
  createdBy: string;      // agent id
  createdAt: string;
  updatedAt: string;
}

interface Finding {
  id: string;
  title: string;
  confidence: FindingConfidence;
  severity: "critical" | "high" | "medium" | "low" | "info";
  discoveredBy: string;  // agent id
  discoveredAt: string;
  detail?: string;
}

interface ActivityEntry {
  id: string;
  timestamp: string;
  agentId: string;
  agentName: string;
  type: "message" | "task_assigned" | "task_completed" | "discovery" | "hypothesis" | "status_change" | "error";
  summary: string;
  detail?: string;
}

interface SwarmState {
  agents: Record<string, Agent>;
  tasks: Record<string, Task>;
  hypotheses: Record<string, Hypothesis>;
  findings: Record<string, Finding>;
  activity: ActivityEntry[];
  createdAt: string;
  updatedAt: string;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Persistence
// ═══════════════════════════════════════════════════════════════════════════

const STATE_DIR = path.resolve(process.env.PI_SEC_DATA_DIR || ".local/reference-data");
const STATE_FILE = path.join(STATE_DIR, "swarm-state.json");
const MAX_ACTIVITY = 500;

function emptyState(): SwarmState {
  const now = new Date().toISOString();
  return {
    agents: {},
    tasks: {},
    hypotheses: {},
    findings: {},
    activity: [],
    createdAt: now,
    updatedAt: now,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCost: 0,
  };
}

function loadState(): SwarmState {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      const s = emptyState();
      saveState(s);
      return s;
    }
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { ...emptyState(), ...parsed };
  } catch {
    const s = emptyState();
    saveState(s);
    return s;
  }
}

function saveState(state: SwarmState): void {
  state.updatedAt = new Date().toISOString();
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function addActivity(state: SwarmState, entry: Omit<ActivityEntry, "id" | "timestamp">): void {
  const fullEntry: ActivityEntry = {
    ...entry,
    id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };
  state.activity.unshift(fullEntry);
  if (state.activity.length > MAX_ACTIVITY) {
    state.activity = state.activity.slice(0, MAX_ACTIVITY);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Pricing (per 1M tokens — approximate, configurable)
// ═══════════════════════════════════════════════════════════════════════════

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15 },
  "claude-3-opus-20240229": { input: 15, output: 75 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "o1": { input: 15, output: 60 },
  "o1-mini": { input: 3, output: 12 },
  "o3-mini": { input: 3, output: 12 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  "default": { input: 3, output: 15 },
};

function computeCost(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[model] ?? PRICING["default"];
  return (tokensIn / 1_000_000) * p.input + (tokensOut / 1_000_000) * p.output;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Aggregation helpers
// ═══════════════════════════════════════════════════════════════════════════

interface StatusSummary {
  agents: Record<AgentStatus, number>;
  tasks: Record<TaskStatus, number>;
  hypotheses: Record<HypothesisStatus, number>;
  findings: Record<FindingConfidence, number>;
  totals: {
    agents: number;
    tasks: number;
    hypotheses: number;
    findings: number;
    activity: number;
    tokensIn: number;
    tokensOut: number;
    cost: number;
  };
}

function summarize(state: SwarmState): StatusSummary {
  const agentCounts = { online: 0, working: 0, idle: 0, blocked: 0, failed: 0 } as Record<AgentStatus, number>;
  const taskCounts = { pending: 0, running: 0, completed: 0, blocked: 0 } as Record<TaskStatus, number>;
  const hypCounts = {
    created: 0, investigating: 0, criticized: 0,
    validating: 0, confirmed: 0, rejected: 0,
  } as Record<HypothesisStatus, number>;
  const findingCounts = { high: 0, medium: 0, rejected: 0 } as Record<FindingConfidence, number>;

  for (const a of Object.values(state.agents)) agentCounts[a.status] = (agentCounts[a.status] ?? 0) + 1;
  for (const t of Object.values(state.tasks)) taskCounts[t.status] = (taskCounts[t.status] ?? 0) + 1;
  for (const h of Object.values(state.hypotheses)) hypCounts[h.status] = (hypCounts[h.status] ?? 0) + 1;
  for (const f of Object.values(state.findings)) findingCounts[f.confidence] = (findingCounts[f.confidence] ?? 0) + 1;

  return {
    agents: agentCounts,
    tasks: taskCounts,
    hypotheses: hypCounts,
    findings: findingCounts,
    totals: {
      agents: Object.keys(state.agents).length,
      tasks: Object.keys(state.tasks).length,
      hypotheses: Object.keys(state.hypotheses).length,
      findings: Object.keys(state.findings).length,
      activity: state.activity.length,
      tokensIn: state.totalTokensIn,
      tokensOut: state.totalTokensOut,
      cost: state.totalCost,
    },
  };
}

function recomputeTotals(state: SwarmState): void {
  let tIn = 0, tOut = 0, tCost = 0;
  for (const a of Object.values(state.agents)) {
    tIn += a.tokensIn;
    tOut += a.tokensOut;
    tCost += a.estimatedCost;
  }
  state.totalTokensIn = tIn;
  state.totalTokensOut = tOut;
  state.totalCost = tCost;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Dashboard rendering
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  reset: "\x1b[0m",  bold: "\x1b[1m",  dim: "\x1b[2m",
  red: "\x1b[31m",  green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
  gray: "\x1b[90m", bgRed: "\x1b[41m", bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m", bgBlue: "\x1b[44m", bgMagenta: "\x1b[45m",
};

const statusColor: Record<AgentStatus, string> = {
  online: C.green, working: C.cyan, idle: C.gray, blocked: C.yellow, failed: C.red,
};
const taskColor: Record<TaskStatus, string> = {
  pending: C.gray, running: C.cyan, completed: C.green, blocked: C.yellow,
};
const hypColor: Record<HypothesisStatus, string> = {
  created: C.blue, investigating: C.cyan, criticized: C.magenta,
  validating: C.yellow, confirmed: C.green, rejected: C.red,
};
const findingColor: Record<FindingConfidence, string> = {
  high: C.green, medium: C.yellow, rejected: C.red,
};

function bar(count: number, total: number, width = 20): string {
  if (total === 0) return C.gray("─".repeat(width));
  const filled = Math.round((count / total) * width);
  return C.green("█".repeat(filled)) + C.gray("░".repeat(width - filled));
}

function pad(str: string, len: number): string {
  if (str.length > len) return str.slice(0, len - 1) + "…";
  return str + " ".repeat(len - str.length);
}

function renderDashboard(state: SwarmState): string {
  const s = summarize(state);
  const lines: string[] = [];

  // Header
  const now = new Date();
  const stamp = now.toTimeString().slice(0, 8);
  lines.push(`${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════════╗${C.reset}`);
  lines.push(`${C.bold}${C.cyan}║${C.reset}  ${C.bold}SWARM OBSERVABILITY${C.reset}${C.gray}${" ".repeat(Math.max(0, 26))}sec-data/swarm-state${C.reset}  ${C.cyan}║${C.reset}`);
  lines.push(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════════════╝${C.reset}`);
  lines.push(`${C.gray}updated: ${stamp}${C.reset}${" ".repeat(20)}${C.gray}since: ${state.createdAt.slice(0, 19).replace("T", " ")}${C.reset}`);
  lines.push("");

  // ── Agents ──
  lines.push(`${C.bold}▸ AGENTS${C.reset} ${C.gray}(${s.totals.agents})${C.reset}`);
  const agentStates: AgentStatus[] = ["online", "working", "idle", "blocked", "failed"];
  for (const st of agentStates) {
    const n = s.agents[st] ?? 0;
    const pct = s.totals.agents > 0 ? ` ${(n / s.totals.agents * 100).toFixed(0)}%` : "";
    lines.push(`  ${statusColor[st]}${pad(st.toUpperCase(), 10)}${C.reset} ${bar(n, s.totals.agents)} ${C.bold}${n}${C.reset}${C.gray}${pct}${C.reset}`);
  }
  // per-agent detail
  const agentList = Object.values(state.agents).sort((a, b) => a.status.localeCompare(b.status));
  if (agentList.length > 0) {
    lines.push(`  ${C.gray}── individual ──${C.reset}`);
    for (const a of agentList) {
      const ago = relTime(a.lastSeen);
      const task = a.currentTask ? `${C.gray}→${C.reset} ${C.dim}${pad(a.currentTask, 28)}${C.reset}` : `${C.dim}${pad("(idle)", 28)}${C.reset}`;
      lines.push(`    ${statusColor[a.status]}●${C.reset} ${C.bold}${pad(a.name, 16)}${C.reset} ${C.gray}${pad(a.role, 12)}${C.reset} ${task} ${C.gray}${ago}${C.reset}`);
    }
  }
  lines.push("");

  // ── Tasks ──
  lines.push(`${C.bold}▸ TASKS${C.reset} ${C.gray}(${s.totals.tasks})${C.reset}`);
  const taskStates: TaskStatus[] = ["pending", "running", "completed", "blocked"];
  for (const st of taskStates) {
    const n = s.tasks[st] ?? 0;
    const pct = s.totals.tasks > 0 ? ` ${(n / s.totals.tasks * 100).toFixed(0)}%` : "";
    lines.push(`  ${taskColor[st]}${pad(st.toUpperCase(), 12)}${C.reset} ${bar(n, s.totals.tasks)} ${C.bold}${n}${C.reset}${C.gray}${pct}${C.reset}`);
  }
  const runningTasks = Object.values(state.tasks).filter(t => t.status === "running");
  if (runningTasks.length > 0) {
    lines.push(`  ${C.gray}── running ──${C.reset}`);
    for (const t of runningTasks) {
      const agent = state.agents[t.assignedTo];
      lines.push(`    ${C.cyan}▶${C.reset} ${C.bold}${pad(t.title, 36)}${C.reset} ${C.gray}${agent ? agent.name : "—"}${C.reset}`);
    }
  }
  lines.push("");

  // ── Hypotheses ──
  lines.push(`${C.bold}▸ HYPOTHESES${C.reset} ${C.gray}(${s.totals.hypotheses})${C.reset}`);
  const hypStates: HypothesisStatus[] = ["created", "investigating", "criticized", "validating", "confirmed", "rejected"];
  for (const st of hypStates) {
    const n = s.hypotheses[st] ?? 0;
    const pct = s.totals.hypotheses > 0 ? ` ${(n / s.totals.hypotheses * 100).toFixed(0)}%` : "";
    lines.push(`  ${hypColor[st]}${pad(st.toUpperCase(), 14)}${C.reset} ${bar(n, s.totals.hypotheses)} ${C.bold}${n}${C.reset}${C.gray}${pct}${C.reset}`);
  }
  lines.push("");

  // ── Findings ──
  lines.push(`${C.bold}▸ FINDINGS${C.reset} ${C.gray}(${s.totals.findings})${C.reset}`);
  const findingStates: FindingConfidence[] = ["high", "medium", "rejected"];
  for (const st of findingStates) {
    const n = s.findings[st] ?? 0;
    const pct = s.totals.findings > 0 ? ` ${(n / s.totals.findings * 100).toFixed(0)}%` : "";
    lines.push(`  ${findingColor[st]}${pad(st.toUpperCase() + " CONF", 14)}${C.reset} ${bar(n, s.totals.findings)} ${C.bold}${n}${C.reset}${C.gray}${pct}${C.reset}`);
  }
  // recent high-confidence findings
  const highFindings = Object.values(state.findings)
    .filter(f => f.confidence === "high")
    .sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt))
    .slice(0, 5);
  if (highFindings.length > 0) {
    lines.push(`  ${C.gray}── recent high-confidence ──${C.reset}`);
    for (const f of highFindings) {
      const sev = f.severity.toUpperCase();
      lines.push(`    ${C.red}${pad(sev, 8)}${C.reset} ${C.bold}${pad(f.title, 40)}${C.reset} ${C.gray}${relTime(f.discoveredAt)}${C.reset}`);
    }
  }
  lines.push("");

  // ── Cost ──
  lines.push(`${C.bold}▸ COST${C.reset}`);
  lines.push(`  ${C.gray}tokens in:${C.reset}  ${C.bold}${formatTokens(s.totals.tokensIn)}${C.reset}`);
  lines.push(`  ${C.gray}tokens out:${C.reset} ${C.bold}${formatTokens(s.totals.tokensOut)}${C.reset}`);
  lines.push(`  ${C.gray}est. cost:${C.reset}   ${C.bold}${C.green}$${s.totals.cost.toFixed(4)}${C.reset}`);
  // model breakdown
  const modelUsage = computeModelUsage(state);
  const modelEntries = Object.entries(modelUsage).sort((a, b) => b[1].cost - a[1].cost);
  if (modelEntries.length > 0) {
    lines.push(`  ${C.gray}── by model ──${C.reset}`);
    for (const [model, usage] of modelEntries) {
      lines.push(`    ${C.magenta}${pad(model, 30)}${C.reset} ${C.gray}in=${formatTokens(usage.tokensIn)} out=${formatTokens(usage.tokensOut)}${C.reset} ${C.green}$${usage.cost.toFixed(4)}${C.reset}`);
    }
  }
  lines.push("");

  // ── Activity (latest 8) ──
  lines.push(`${C.bold}▸ ACTIVITY${C.reset} ${C.gray}(latest 8 of ${s.totals.activity})${C.reset}`);
  for (const act of state.activity.slice(0, 8)) {
    const time = act.timestamp.slice(11, 19);
    const typeColor = act.type === "error" ? C.red
      : act.type === "discovery" ? C.green
      : act.type === "task_completed" ? C.cyan
      : act.type === "hypothesis" ? C.magenta
      : act.type === "status_change" ? C.yellow
      : C.gray;
    lines.push(`  ${C.gray}${time}${C.reset} ${typeColor}${pad(act.type, 16)}${C.reset} ${C.bold}${pad(act.agentName, 14)}${C.reset} ${act.summary}`);
  }
  lines.push("");

  lines.push(`${C.gray}state: ${STATE_FILE}${C.reset}`);

  return lines.join("\n");
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function computeModelUsage(state: SwarmState): Record<string, { tokensIn: number; tokensOut: number; cost: number }> {
  const usage: Record<string, { tokensIn: number; tokensOut: number; cost: number }> = {};
  for (const a of Object.values(state.agents)) {
    if (!usage[a.model]) usage[a.model] = { tokensIn: 0, tokensOut: 0, cost: 0 };
    usage[a.model].tokensIn += a.tokensIn;
    usage[a.model].tokensOut += a.tokensOut;
    usage[a.model].cost += a.estimatedCost;
  }
  return usage;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Extension registration
// ═══════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {

  // ── Session start: init state if needed ────────────────────────────────
  pi.on("session_start", async (_event: any, ctx: any) => {
    const state = loadState();
    if (Object.keys(state.agents).length === 0) {
      addActivity(state, {
        agentId: "system",
        agentName: "system",
        type: "message",
        summary: "Swarm observability initialized — no agents registered yet",
      });
      saveState(state);
    }
    ctx?.ui?.setStatus?.("swarm", "\x1b[36m● swarm\x1b[0m");
  });

  // ── Tool: swarm_status ─────────────────────────────────────────────────
  pi.registerTool({
    name: "swarm_status",
    description:
      "Get current swarm status as structured JSON. Tracks agents (online/working/idle/blocked/failed), " +
      "tasks (pending/running/completed/blocked), hypotheses (created/investigating/criticized/validating/confirmed/rejected), " +
      "findings (high/medium/rejected), cost (tokens + estimated cost + model usage), and latest activity.",
    parameters: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["all", "agents", "tasks", "hypotheses", "findings", "cost"],
          description: "Filter to a specific section, or 'all' for the full snapshot",
          default: "all",
        },
      },
      required: [],
    },
    execute: async (params: any) => {
      const state = loadState();
      const section = (params?.section ?? "all") as string;

      if (section === "agents") {
        return { content: JSON.stringify({ agents: state.agents, summary: summarize(state).agents }, null, 2) };
      }
      if (section === "tasks") {
        return { content: JSON.stringify({ tasks: state.tasks, summary: summarize(state).tasks }, null, 2) };
      }
      if (section === "hypotheses") {
        return { content: JSON.stringify({ hypotheses: state.hypotheses, summary: summarize(state).hypotheses }, null, 2) };
      }
      if (section === "findings") {
        return { content: JSON.stringify({ findings: state.findings, summary: summarize(state).findings }, null, 2) };
      }
      if (section === "cost") {
        return {
          content: JSON.stringify({
            totalTokensIn: state.totalTokensIn,
            totalTokensOut: state.totalTokensOut,
            totalCost: state.totalCost,
            byModel: computeModelUsage(state),
            byAgent: Object.values(state.agents).map(a => ({
              id: a.id, name: a.name, model: a.model,
              tokensIn: a.tokensIn, tokensOut: a.tokensOut, cost: a.estimatedCost,
            })),
          }, null, 2),
        };
      }

      // all
      const summary = summarize(state);
      return {
        content: JSON.stringify({
          summary,
          agents: state.agents,
          tasks: state.tasks,
          hypotheses: state.hypotheses,
          findings: state.findings,
          cost: {
            totalTokensIn: state.totalTokensIn,
            totalTokensOut: state.totalTokensOut,
            totalCost: state.totalCost,
            byModel: computeModelUsage(state),
          },
          activity: state.activity.slice(0, 20),
          updatedAt: state.updatedAt,
        }, null, 2),
      };
    },
  });

  // ── Tool: swarm_activity ───────────────────────────────────────────────
  pi.registerTool({
    name: "swarm_activity",
    description:
      "Get recent activity log. Returns latest activity entries with filters by agent, type, and limit. " +
      "Activity types: message, task_assigned, task_completed, discovery, hypothesis, status_change, error.",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Filter to a specific agent ID" },
        type: {
          type: "string",
          enum: ["message", "task_assigned", "task_completed", "discovery", "hypothesis", "status_change", "error"],
          description: "Filter by activity type",
        },
        limit: { type: "integer", description: "Max entries to return (default 50)", default: 50 },
      },
      required: [],
    },
    execute: async (params: any) => {
      const state = loadState();
      let entries = state.activity;

      if (params?.agentId) {
        entries = entries.filter(e => e.agentId === params.agentId);
      }
      if (params?.type) {
        entries = entries.filter(e => e.type === params.type);
      }

      const limit = params?.limit ?? 50;
      entries = entries.slice(0, limit);

      return {
        content: JSON.stringify({
          count: entries.length,
          total: state.activity.length,
          activity: entries,
        }, null, 2),
      };
    },
  });

  // ── Tool: swarm_cost ───────────────────────────────────────────────────
  pi.registerTool({
    name: "swarm_cost",
    description:
      "Get cost breakdown by agent and task. Includes token counts, estimated USD cost, " +
      "and per-model usage. Supports filtering by agent or time window.",
    parameters: {
      type: "object",
      properties: {
        by: {
          type: "string",
          enum: ["agent", "task", "model", "all"],
          description: "Group results by agent, task, model, or all (default: all)",
          default: "all",
        },
        agentId: { type: "string", description: "Filter to a specific agent" },
      },
      required: [],
    },
    execute: async (params: any) => {
      const state = loadState();
      const by = params?.by ?? "all";
      const agentFilter = params?.agentId;

      let agents = Object.values(state.agents);
      let tasks = Object.values(state.tasks);
      if (agentFilter) {
        agents = agents.filter(a => a.id === agentFilter);
        tasks = tasks.filter(t => t.assignedTo === agentFilter);
      }

      const result: any = {
        totals: {
          tokensIn: state.totalTokensIn,
          tokensOut: state.totalTokensOut,
          cost: state.totalCost,
        },
      };

      if (by === "agent" || by === "all") {
        result.byAgent = agents.map(a => ({
          id: a.id,
          name: a.name,
          role: a.role,
          model: a.model,
          tokensIn: a.tokensIn,
          tokensOut: a.tokensOut,
          cost: a.estimatedCost,
          tasks: tasks.filter(t => t.assignedTo === a.id).length,
        }));
      }
      if (by === "task" || by === "all") {
        result.byTask = tasks.map(t => ({
          id: t.id,
          title: t.title,
          agent: state.agents[t.assignedTo]?.name ?? "—",
          model: t.model,
          tokensIn: t.tokensIn,
          tokensOut: t.tokensOut,
          cost: t.estimatedCost,
          status: t.status,
        }));
      }
      if (by === "model" || by === "all") {
        result.byModel = computeModelUsage(state);
      }

      return { content: JSON.stringify(result, null, 2) };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Command: /swarm
  // ═══════════════════════════════════════════════════════════════════════
  pi.registerCommand("swarm", {
    description:
      "Live swarm status dashboard. Usage: /swarm [agents|tasks|hypotheses|findings|cost|activity|reset]",
    handler: async (args: string, _ctx: any) => {
      const state = loadState();
      const sub = args.trim().split(/\s+/)[0] || "";

      if (sub === "reset") {
        const fresh = emptyState();
        saveState(fresh);
        return `${C.green}✓ Swarm state reset${C.reset}`;
      }

      if (sub === "agents") {
        const s = summarize(state);
        const lines: string[] = [`${C.bold}AGENTS${C.reset} ${C.gray}(${s.totals.agents})${C.reset}`, ""];
        const agentStates: AgentStatus[] = ["online", "working", "idle", "blocked", "failed"];
        for (const st of agentStates) {
          const n = s.agents[st] ?? 0;
          lines.push(`  ${statusColor[st]}${pad(st.toUpperCase(), 10)}${C.reset} ${bar(n, s.totals.agents)} ${C.bold}${n}${C.reset}`);
        }
        lines.push("");
        for (const a of Object.values(state.agents).sort((a, b) => a.status.localeCompare(b.status))) {
          lines.push(`  ${statusColor[a.status]}●${C.reset} ${C.bold}${pad(a.name, 18)}${C.reset} ${C.gray}${pad(a.role, 14)}${C.reset} ${C.gray}${relTime(a.lastSeen)}${C.reset}`);
        }
        return lines.join("\n");
      }

      if (sub === "tasks") {
        const s = summarize(state);
        const lines: string[] = [`${C.bold}TASKS${C.reset} ${C.gray}(${s.totals.tasks})${C.reset}`, ""];
        const taskStates: TaskStatus[] = ["pending", "running", "completed", "blocked"];
        for (const st of taskStates) {
          const n = s.tasks[st] ?? 0;
          lines.push(`  ${taskColor[st]}${pad(st.toUpperCase(), 12)}${C.reset} ${bar(n, s.totals.tasks)} ${C.bold}${n}${C.reset}`);
        }
        lines.push("");
        for (const t of Object.values(state.tasks).sort((a, b) => a.status.localeCompare(b.status))) {
          const agent = state.agents[t.assignedTo]?.name ?? "—";
          lines.push(`  ${taskColor[t.status]}●${C.reset} ${C.bold}${pad(t.title, 40)}${C.reset} ${C.gray}${pad(agent, 14)}${C.reset} ${C.gray}${relTime(t.updatedAt)}${C.reset}`);
        }
        return lines.join("\n");
      }

      if (sub === "hypotheses") {
        const s = summarize(state);
        const lines: string[] = [`${C.bold}HYPOTHESES${C.reset} ${C.gray}(${s.totals.hypotheses})${C.reset}`, ""];
        const hypStates: HypothesisStatus[] = ["created", "investigating", "criticized", "validating", "confirmed", "rejected"];
        for (const st of hypStates) {
          const n = s.hypotheses[st] ?? 0;
          lines.push(`  ${hypColor[st]}${pad(st.toUpperCase(), 14)}${C.reset} ${bar(n, s.totals.hypotheses)} ${C.bold}${n}${C.reset}`);
        }
        lines.push("");
        for (const h of Object.values(state.hypotheses).sort((a, b) => a.status.localeCompare(b.status))) {
          const creator = state.agents[h.createdBy]?.name ?? "—";
          lines.push(`  ${hypColor[h.status]}●${C.reset} ${pad(h.text, 50)} ${C.gray}${pad(creator, 12)}${C.reset} ${C.gray}${relTime(h.updatedAt)}${C.reset}`);
        }
        return lines.join("\n");
      }

      if (sub === "findings") {
        const s = summarize(state);
        const lines: string[] = [`${C.bold}FINDINGS${C.reset} ${C.gray}(${s.totals.findings})${C.reset}`, ""];
        const findingStates: FindingConfidence[] = ["high", "medium", "rejected"];
        for (const st of findingStates) {
          const n = s.findings[st] ?? 0;
          lines.push(`  ${findingColor[st]}${pad(st.toUpperCase() + " CONF", 14)}${C.reset} ${bar(n, s.totals.findings)} ${C.bold}${n}${C.reset}`);
        }
        lines.push("");
        for (const f of Object.values(state.findings).sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt))) {
          const by = state.agents[f.discoveredBy]?.name ?? "—";
          lines.push(`  ${findingColor[f.confidence]}●${C.reset} ${C.red}${pad(f.severity.toUpperCase(), 8)}${C.reset} ${C.bold}${pad(f.title, 40)}${C.reset} ${C.gray}${pad(by, 12)}${C.reset} ${C.gray}${relTime(f.discoveredAt)}${C.reset}`);
        }
        return lines.join("\n");
      }

      if (sub === "cost") {
        const lines: string[] = [`${C.bold}COST BREAKDOWN${C.reset}`, ""];
        lines.push(`  ${C.gray}tokens in:${C.reset}  ${C.bold}${formatTokens(state.totalTokensIn)}${C.reset}`);
        lines.push(`  ${C.gray}tokens out:${C.reset} ${C.bold}${formatTokens(state.totalTokensOut)}${C.reset}`);
        lines.push(`  ${C.gray}est. cost:${C.reset}   ${C.bold}${C.green}$${state.totalCost.toFixed(4)}${C.reset}`);
        lines.push("");
        const modelUsage = computeModelUsage(state);
        const entries = Object.entries(modelUsage).sort((a, b) => b[1].cost - a[1].cost);
        if (entries.length > 0) {
          lines.push(`  ${C.gray}── by model ──${C.reset}`);
          for (const [model, usage] of entries) {
            lines.push(`    ${C.magenta}${pad(model, 30)}${C.reset} ${C.gray}in=${formatTokens(usage.tokensIn)} out=${formatTokens(usage.tokensOut)}${C.reset} ${C.green}$${usage.cost.toFixed(4)}${C.reset}`);
          }
        }
        lines.push("");
        lines.push(`  ${C.gray}── by agent ──${C.reset}`);
        for (const a of Object.values(state.agents).sort((a, b) => b.estimatedCost - a.estimatedCost)) {
          lines.push(`    ${C.bold}${pad(a.name, 16)}${C.reset} ${C.gray}${pad(a.model, 28)}${C.reset} ${C.gray}in=${formatTokens(a.tokensIn)} out=${formatTokens(a.tokensOut)}${C.reset} ${C.green}$${a.estimatedCost.toFixed(4)}${C.reset}`);
        }
        return lines.join("\n");
      }

      if (sub === "activity") {
        const lines: string[] = [`${C.bold}ACTIVITY${C.reset} ${C.gray}(latest 20 of ${state.activity.length})${C.reset}`, ""];
        for (const act of state.activity.slice(0, 20)) {
          const time = act.timestamp.slice(11, 19);
          const typeColor = act.type === "error" ? C.red
            : act.type === "discovery" ? C.green
            : act.type === "task_completed" ? C.cyan
            : act.type === "hypothesis" ? C.magenta
            : act.type === "status_change" ? C.yellow
            : C.gray;
          lines.push(`  ${C.gray}${time}${C.reset} ${typeColor}${pad(act.type, 16)}${C.reset} ${C.bold}${pad(act.agentName, 14)}${C.reset} ${act.summary}`);
        }
        return lines.join("\n");
      }

      // default: full dashboard
      return renderDashboard(state);
    },
  });
}
