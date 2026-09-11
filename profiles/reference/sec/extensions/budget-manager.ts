/**
 * Budget Manager — token/cost/latency accounting for the security swarm
 *
 * Tracks resource usage per agent, per task, per investigation and keeps
 * budget limits so the orchestrator can throttle spend before it happens.
 *
 * State persists at ~/.pi/agent/sec-data/swarm-state.json under "costs",
 * "budget_limits" and "model_rates" (other keys in that file — owned by the
 * observability extension — are preserved untouched).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ════════════════════════════════════════════════════════════════════════════
//  Types
// ════════════════════════════════════════════════════════════════════════════

interface CostEntry {
  id: string;
  investigation_id: string | null;
  agent: string;
  task_id: string;
  tokens_in: number;
  tokens_out: number;
  model: string;
  latency_ms: number;
  cost: number; // USD
  timestamp: string;
}

interface BudgetLimit {
  investigation_id: string;
  max_tokens: number | null;
  max_cost: number | null; // USD
  created_at: string;
}

interface ModelRate {
  in_per_1k: number; // USD per 1K input tokens
  out_per_1k: number; // USD per 1K output tokens
  tier: "cheap" | "strong";
}

/** Only the keys this extension owns. Everything else passes through. */
interface BudgetState {
  costs: CostEntry[];
  budget_limits: Record<string, BudgetLimit>;
  model_rates: Record<string, ModelRate>;
}

interface TaskGraphTask {
  id: string;
  status: string;
  priority: string;
  target: string | null;
  hypothesis: string;
  evidence: { agent: string; note: string }[];
  estimated_cost: number;
  actual_cost: number;
}

// ════════════════════════════════════════════════════════════════════════════
//  Persistence (read-modify-write on the shared swarm-state.json)
// ════════════════════════════════════════════════════════════════════════════

const DATA_DIR = path.resolve(process.env.PI_SEC_DATA_DIR || ".local/reference-data");
const STATE_FILE = path.join(DATA_DIR, "swarm-state.json");
const TASK_GRAPH_FILE = path.join(DATA_DIR, "task-graph.json");

const MAX_COSTS = 5000;

/** Default model rates — USD per 1K tokens. Editable in swarm-state.json. */
const DEFAULT_MODEL_RATES: Record<string, ModelRate> = {
  "glm-5.2": { in_per_1k: 0.002, out_per_1k: 0.008, tier: "cheap" },
  "glm-5.3": { in_per_1k: 0.003, out_per_1k: 0.012, tier: "strong" },
  "kimi-k3": { in_per_1k: 0.002, out_per_1k: 0.008, tier: "cheap" },
};

const UNKNOWN_RATE: ModelRate = { in_per_1k: 0.002, out_per_1k: 0.008, tier: "cheap" };

function load(): BudgetState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
    return normalize(raw);
  } catch {
    return normalize({});
  }
}

function normalize(raw: Record<string, unknown>): BudgetState {
  const costs = Array.isArray(raw.costs) ? (raw.costs as CostEntry[]) : [];
  const limits = (raw.budget_limits || {}) as Record<string, BudgetLimit>;
  const rates = { ...DEFAULT_MODEL_RATES, ...((raw.model_rates || {}) as Record<string, ModelRate>) };
  return { costs, budget_limits: limits, model_rates: rates };
}

function save(state: BudgetState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Merge back into the shared file so other extensions' keys survive.
  let file: Record<string, unknown> = {};
  try {
    file = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    /* fresh file */
  }
  file.costs = state.costs;
  file.budget_limits = state.budget_limits;
  file.model_rates = state.model_rates;
  fs.writeFileSync(STATE_FILE, JSON.stringify(file, null, 2), "utf8");
}

function loadTasks(): TaskGraphTask[] {
  try {
    const g = JSON.parse(fs.readFileSync(TASK_GRAPH_FILE, "utf8")) as { tasks?: TaskGraphTask[] };
    return Array.isArray(g.tasks) ? g.tasks : [];
  } catch {
    return [];
  }
}

function rateFor(state: BudgetState, model: string): ModelRate {
  return state.model_rates[model] ?? UNKNOWN_RATE;
}

function calcCost(state: BudgetState, model: string, tokensIn: number, tokensOut: number): number {
  const r = rateFor(state, model);
  return (tokensIn / 1000) * r.in_per_1k + (tokensOut / 1000) * r.out_per_1k;
}

function now(): string {
  return new Date().toISOString();
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

// ════════════════════════════════════════════════════════════════════════════
//  Aggregation
// ════════════════════════════════════════════════════════════════════════════

interface Aggregates {
  total_tokens_in: number;
  total_tokens_out: number;
  total_tokens: number;
  total_cost: number;
  total_latency_ms: number;
  entry_count: number;
  avg_latency_ms: number;
  cost_by_agent: Record<string, { cost: number; tokens: number; calls: number }>;
  cost_by_task: Record<string, { cost: number; tokens: number; calls: number }>;
  cost_by_model: Record<string, { cost: number; tokens: number; calls: number }>;
  cost_by_investigation: Record<string, { cost: number; tokens: number; calls: number }>;
}

function aggregate(costs: CostEntry[]): Aggregates {
  const agg: Aggregates = {
    total_tokens_in: 0,
    total_tokens_out: 0,
    total_tokens: 0,
    total_cost: 0,
    total_latency_ms: 0,
    entry_count: costs.length,
    avg_latency_ms: 0,
    cost_by_agent: {},
    cost_by_task: {},
    cost_by_model: {},
    cost_by_investigation: {},
  };
  for (const c of costs) {
    const tokens = c.tokens_in + c.tokens_out;
    agg.total_tokens_in += c.tokens_in;
    agg.total_tokens_out += c.tokens_out;
    agg.total_tokens += tokens;
    agg.total_cost += c.cost;
    agg.total_latency_ms += c.latency_ms;

    const inv = c.investigation_id || "(none)";
    for (const [dim, key] of [
      [agg.cost_by_agent, c.agent],
      [agg.cost_by_task, c.task_id],
      [agg.cost_by_model, c.model],
      [agg.cost_by_investigation, inv],
    ] as const) {
      const b = (dim[key] ??= { cost: 0, tokens: 0, calls: 0 });
      b.cost += c.cost;
      b.tokens += tokens;
      b.calls += 1;
    }
  }
  agg.avg_latency_ms = agg.entry_count > 0 ? agg.total_latency_ms / agg.entry_count : 0;
  return agg;
}

function limitStatus(state: BudgetState, investigationId: string) {
  const limit = state.budget_limits[investigationId];
  if (!limit) return null;
  const scoped = state.costs.filter((c) => c.investigation_id === investigationId);
  const usedTokens = scoped.reduce((s, c) => s + c.tokens_in + c.tokens_out, 0);
  const usedCost = scoped.reduce((s, c) => s + c.cost, 0);
  return {
    investigation_id: investigationId,
    used_tokens: usedTokens,
    used_cost: usedCost,
    max_tokens: limit.max_tokens,
    max_cost: limit.max_cost,
    tokens_remaining: limit.max_tokens != null ? Math.max(0, limit.max_tokens - usedTokens) : null,
    cost_remaining: limit.max_cost != null ? Math.max(0, limit.max_cost - usedCost) : null,
    tokens_exceeded: limit.max_tokens != null && usedTokens > limit.max_tokens,
    cost_exceeded: limit.max_cost != null && usedCost > limit.max_cost,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  Prioritization — Expected Impact × Evidence × Confidence × Novelty
//                        × Exploitability ÷ Cost
// ════════════════════════════════════════════════════════════════════════════

const PRIORITY_IMPACT: Record<string, number> = {
  CRITICAL: 1.0,
  HIGH: 0.75,
  MEDIUM: 0.5,
  LOW: 0.25,
};

const EXPLOIT_KEYWORDS = [
  "exploit", "rce", "injection", "sqli", "xss", "ssrf", "auth", "bypass",
  "privilege", "escalation", "unauthorized", "deserialization", "traversal",
  "overflow", "key", "secret", "token", "credential",
];

function deriveFactors(tasks: TaskGraphTask[], task: TaskGraphTask) {
  // Expected impact — from swarm priority.
  const expected_impact = PRIORITY_IMPACT[task.priority] ?? 0.5;

  // Evidence — how much corroboration the hypothesis already has.
  const evidence = Math.min(1, task.evidence.length / 5);

  // Confidence — evidence density plus completion state of deps handled
  // elsewhere; base 0.4 grows with each evidence entry.
  const confidence = Math.min(1, 0.4 + 0.12 * task.evidence.length);

  // Novelty — targets nobody else is looking at score higher.
  const sameTarget = tasks.filter(
    (t) => t.id !== task.id && t.target && t.target === task.target,
  ).length;
  const novelty = 1 / (1 + 0.3 * sameTarget);

  // Exploitability — hypothesis language hinting at exploitable classes.
  const h = task.hypothesis.toLowerCase();
  const hits = EXPLOIT_KEYWORDS.filter((k) => h.includes(k)).length;
  const exploitability = Math.min(1, 0.4 + 0.2 * hits);

  // Cost — estimated (abstract units) plus actual tracked spend, floor 1.
  const cost = Math.max(1, (task.estimated_cost || 0) + (task.actual_cost || 0));

  return { expected_impact, evidence, confidence, novelty, exploitability, cost };
}

function score(f: {
  expected_impact: number;
  evidence: number;
  confidence: number;
  novelty: number;
  exploitability: number;
  cost: number;
}): number {
  return (
    (f.expected_impact * f.evidence * f.confidence * f.novelty * f.exploitability) /
    Math.max(1e-9, f.cost)
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  Model routing
// ════════════════════════════════════════════════════════════════════════════

const CHEAP_TASK_TYPES = [
  "extraction",
  "classification",
  "normalization",
  "summarization",
  "deduplication",
  "formatting",
  "triage",
];

const STRONG_TASK_TYPES = [
  "architecture",
  "business_logic",
  "attack_chain",
  "attack-chain",
  "attackchain",
  "critic",
  "synthesis",
  "reasoning",
  "correlation",
  "exploit_development",
];

function routeModel(state: BudgetState, taskType: string) {
  const t = taskType.toLowerCase().replace(/[\s-]+/g, "_");

  const cheap = Object.entries(state.model_rates).filter(([, r]) => r.tier === "cheap");
  const strong = Object.entries(state.model_rates).filter(([, r]) => r.tier === "strong");

  if (CHEAP_TASK_TYPES.includes(t)) {
    const recommended_model =
      cheap.sort((a, b) => a[1].in_per_1k - b[1].in_per_1k)[0]?.[0] ?? "glm-5.2";
    return {
      task_type: taskType,
      recommended_model,
      tier: "cheap",
      reasoning:
        `"${taskType}" is mechanical pattern work — output correctness depends on coverage, not ` +
        `depth of reasoning. A cheap model at this tier loses nothing on quality and cuts input ` +
        `cost ${strong.length > 0 ? "2-4x" : "significantly"} versus a strong model.`,
    };
  }

  if (STRONG_TASK_TYPES.includes(t) || t.includes("chain") || t.includes("logic") || t.includes("architecture")) {
    const recommended_model =
      strong.sort((a, b) => b[1].out_per_1k - a[1].out_per_1k)[0]?.[0] ?? "glm-5.3";
    return {
      task_type: taskType,
      recommended_model,
      tier: "strong",
      reasoning:
        `"${taskType}" needs multi-step reasoning, long-horizon context retention, and judgment ` +
        `about what actually matters. Cheap models flatten attack chains and miss the non-obvious ` +
        `correlations — this is where quality spend pays for itself.`,
    };
  }

  // Unknown task type — default to strong, cheap routing is an explicit opt-in.
  const recommended_model =
    strong.sort((a, b) => b[1].out_per_1k - a[1].out_per_1k)[0]?.[0] ?? "glm-5.3";
  return {
    task_type: taskType,
    recommended_model,
    tier: "strong",
    reasoning:
      `"${taskType}" is not in the known cheap tier list — routing to a strong model by default. ` +
      `If this is mechanical extraction/classification work, call with a known cheap task type ` +
      `(${CHEAP_TASK_TYPES.slice(0, 4).join(", ")}, …) to save cost.`,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  Extension
// ════════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {

  // ── 1. budget_track ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "budget_track",
    description:
      "Record a cost entry for an agent's work. Calculates USD cost from the model rate table " +
      "and appends to swarm-state.json under 'costs'. If the task belongs to an investigation " +
      "with a budget limit, the response flags remaining budget and over-limit warnings.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent name (e.g. 'recon:subdomain', 'critic')" },
        task_id: { type: "string", description: "Task ID from the task graph (e.g. 'T-042')" },
        tokens_in: { type: "number", description: "Input tokens consumed" },
        tokens_out: { type: "number", description: "Output tokens consumed" },
        model: { type: "string", description: "Model used (e.g. 'glm-5.2', 'glm-5.3', 'kimi-k3')" },
        latency_ms: { type: "number", description: "End-to-end latency in milliseconds" },
        investigation_id: {
          type: "string",
          description: "Optional investigation ID this spend belongs to (for per-investigation budgets)",
        },
      },
      required: ["agent", "task_id", "tokens_in", "tokens_out", "model", "latency_ms"],
    },
    execute: async (params: any) => {
      const state = load();

      const entry: CostEntry = {
        id: `cost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        investigation_id: params.investigation_id || null,
        agent: String(params.agent),
        task_id: String(params.task_id),
        tokens_in: Math.max(0, Number(params.tokens_in) || 0),
        tokens_out: Math.max(0, Number(params.tokens_out) || 0),
        model: String(params.model),
        latency_ms: Math.max(0, Number(params.latency_ms) || 0),
        cost: calcCost(state, String(params.model), Number(params.tokens_in) || 0, Number(params.tokens_out) || 0),
        timestamp: now(),
      };

      state.costs.push(entry);
      if (state.costs.length > MAX_COSTS) {
        state.costs = state.costs.slice(-MAX_COSTS);
      }
      save(state);

      const result: Record<string, unknown> = {
        ok: true,
        entry,
        message:
          `Tracked ${entry.tokens_in} in / ${entry.tokens_out} out on ${entry.model} for ` +
          `${entry.agent} (${entry.task_id}) — ${usd(entry.cost)}, ${entry.latency_ms}ms`,
      };

      if (entry.investigation_id && state.budget_limits[entry.investigation_id]) {
        const ls = limitStatus(state, entry.investigation_id);
        result.budget = ls;
        if (ls && (ls.tokens_exceeded || ls.cost_exceeded)) {
          result.warning =
            `⚠ Investigation ${entry.investigation_id} is OVER BUDGET — ` +
            `${ls.used_tokens} tokens used / ${ls.max_tokens} allowed, ` +
            `${usd(ls.used_cost)} spent / ${ls.max_cost != null ? usd(ls.max_cost) : "∞"} allowed. ` +
            `Halt further spend or raise the limit with budget_set_limit.`;
        }
      }

      return { content: JSON.stringify(result, null, 2) };
    },
  });

  // ── 2. budget_status ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "budget_status",
    description:
      "Get current budget status: total tokens, total cost, cost by agent / task / model, " +
      "latency stats, and remaining budget per investigation. Pass investigation_id to scope " +
      "the aggregation to a single investigation.",
    parameters: {
      type: "object",
      properties: {
        investigation_id: {
          type: "string",
          description: "Optional — restrict aggregation to one investigation",
        },
      },
    },
    execute: async (params: any) => {
      const state = load();

      const costs = params.investigation_id
        ? state.costs.filter((c) => c.investigation_id === params.investigation_id)
        : state.costs;

      const agg = aggregate(costs);

      const limits = params.investigation_id
        ? [limitStatus(state, params.investigation_id)].filter(Boolean)
        : Object.keys(state.budget_limits).map((id) => limitStatus(state, id)).filter(Boolean);

      return {
        content: JSON.stringify(
          {
            ok: true,
            scope: params.investigation_id || "all",
            total_tokens_in: agg.total_tokens_in,
            total_tokens_out: agg.total_tokens_out,
            total_tokens: agg.total_tokens,
            total_cost: Number(agg.total_cost.toFixed(6)),
            entries: agg.entry_count,
            latency: {
              total_ms: agg.total_latency_ms,
              avg_ms: Math.round(agg.avg_latency_ms),
            },
            cost_by_agent: agg.cost_by_agent,
            cost_by_task: agg.cost_by_task,
            cost_by_model: agg.cost_by_model,
            cost_by_investigation: agg.cost_by_investigation,
            budgets: limits,
          },
          null,
          2,
        ),
      };
    },
  });

  // ── 3. budget_set_limit ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "budget_set_limit",
    description:
      "Set or update a budget limit for an investigation. Limits are checked on every " +
      "budget_track call — over-limit spend triggers a warning in the response. " +
      "Pass null/omit a max to leave that dimension unbounded.",
    parameters: {
      type: "object",
      properties: {
        investigation_id: { type: "string", description: "Investigation ID to limit" },
        max_tokens: {
          type: "number",
          description: "Maximum total tokens for this investigation (null = unbounded)",
        },
        max_cost: {
          type: "number",
          description: "Maximum total USD cost for this investigation (null = unbounded)",
        },
      },
      required: ["investigation_id"],
    },
    execute: async (params: any) => {
      const state = load();
      const id = String(params.investigation_id);

      state.budget_limits[id] = {
        investigation_id: id,
        max_tokens: params.max_tokens != null ? Number(params.max_tokens) : null,
        max_cost: params.max_cost != null ? Number(params.max_cost) : null,
        created_at: now(),
      };
      save(state);

      const ls = limitStatus(state, id);
      return {
        content: JSON.stringify(
          {
            ok: true,
            message:
              `Budget limit set for ${id}: ` +
              `${state.budget_limits[id].max_tokens ?? "∞"} tokens, ` +
              `${state.budget_limits[id].max_cost != null ? usd(state.budget_limits[id].max_cost!) : "∞"} cost`,
            budget: ls,
          },
          null,
          2,
        ),
      };
    },
  });

  // ── 4. budget_prioritize ────────────────────────────────────────────────────
  pi.registerTool({
    name: "budget_prioritize",
    description:
      "Get a prioritized list of active tasks ranked by " +
      "Expected Impact × Evidence × Confidence × Novelty × Exploitability ÷ Cost. " +
      "Factors are derived from the task graph (priority, evidence count, target overlap, " +
      "hypothesis keywords, estimated+actual cost). With no parameters, ranks all " +
      "PENDING/CLAIMED/RUNNING tasks. With explicit factor parameters, scores that single " +
      "task with your own numbers.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Optional — score this specific task with explicit factors" },
        expected_impact: { type: "number", description: "Expected impact factor 0-1 (with task_id)" },
        evidence: { type: "number", description: "Evidence factor 0-1 (with task_id)" },
        confidence: { type: "number", description: "Confidence factor 0-1 (with task_id)" },
        novelty: { type: "number", description: "Novelty factor 0-1 (with task_id)" },
        exploitability: { type: "number", description: "Exploitability factor 0-1 (with task_id)" },
        cost: { type: "number", description: "Cost divisor, abstract units (with task_id)" },
        limit: { type: "number", description: "Optional — max number of ranked tasks to return (default 20)" },
      },
    },
    execute: async (params: any) => {
      const tasks = loadTasks();

      // Explicit single-task scoring
      if (params.task_id && params.expected_impact != null) {
        const f = {
          expected_impact: Number(params.expected_impact),
          evidence: params.evidence != null ? Number(params.evidence) : 0.5,
          confidence: params.confidence != null ? Number(params.confidence) : 0.5,
          novelty: params.novelty != null ? Number(params.novelty) : 0.5,
          exploitability: params.exploitability != null ? Number(params.exploitability) : 0.5,
          cost: params.cost != null ? Number(params.cost) : 1,
        };
        return {
          content: JSON.stringify(
            {
              ok: true,
              task_id: params.task_id,
              factors: f,
              priority_score: Number(score(f).toFixed(6)),
              formula: "expected_impact × evidence × confidence × novelty × exploitability ÷ cost",
            },
            null,
            2,
          ),
        };
      }

      const active = tasks.filter(
        (t) => t.status === "PENDING" || t.status === "CLAIMED" || t.status === "RUNNING",
      );

      if (active.length === 0) {
        return {
          content: JSON.stringify(
            {
              ok: true,
              ranked_tasks: [],
              message: "No active (PENDING/CLAIMED/RUNNING) tasks in the task graph.",
            },
            null,
            2,
          ),
        };
      }

      const ranked = active
        .map((t) => {
          const factors = deriveFactors(tasks, t);
          return {
            task_id: t.id,
            hypothesis: t.hypothesis,
            status: t.status,
            priority: t.priority,
            target: t.target,
            factors,
            priority_score: Number(score(factors).toFixed(6)),
          };
        })
        .sort((a, b) => b.priority_score - a.priority_score)
        .slice(0, Math.max(1, Number(params.limit) || 20));

      return {
        content: JSON.stringify(
          {
            ok: true,
            formula: "expected_impact × evidence × confidence × novelty × exploitability ÷ cost",
            ranked_tasks: ranked,
          },
          null,
          2,
        ),
      };
    },
  });

  // ── 5. budget_model_route ───────────────────────────────────────────────────
  pi.registerTool({
    name: "budget_model_route",
    description:
      "Get a model recommendation for a task type. Cheap models (glm-5.2, kimi-k3) for " +
      "extraction, classification, normalization, summarization. Strong models (glm-5.3) for " +
      "architecture, business logic, attack chains, critic, synthesis. " +
      "With no task_type, returns the full routing table.",
    parameters: {
      type: "object",
      properties: {
        task_type: {
          type: "string",
          description:
            "Task type to route (extraction, classification, normalization, summarization, " +
            "architecture, business_logic, attack_chain, critic, synthesis, …)",
        },
      },
    },
    execute: async (params: any) => {
      const state = load();

      if (params.task_type) {
        const rec = routeModel(state, String(params.task_type));
        return { content: JSON.stringify({ ok: true, ...rec }, null, 2) };
      }

      const table = [...CHEAP_TASK_TYPES, ...STRONG_TASK_TYPES].map((t) => routeModel(state, t));
      return {
        content: JSON.stringify(
          {
            ok: true,
            model_rates: state.model_rates,
            routing_table: table,
          },
          null,
          2,
        ),
      };
    },
  });

  // ── Command: /budget ────────────────────────────────────────────────────────
  pi.registerCommand("budget", {
    description: "Cost dashboard — tokens, spend by agent/model/task, investigation budgets",
    handler: async (_args: string) => {
      const state = load();

      if (state.costs.length === 0) {
        return [
          "",
          "  ╔══════════════════════════════════════════╗",
          "  ║       Budget — no entries yet             ║",
          "  ╚══════════════════════════════════════════╝",
          "",
          "  No cost entries recorded.",
          "  Use budget_track after agent work to record spend.",
          "",
        ].join("\n");
      }

      const agg = aggregate(state.costs);
      const lines: string[] = [
        "",
        "  ╔══════════════════════════════════════════════════════════════╗",
        "  ║              Security Swarm — Budget                         ║",
        "  ╚══════════════════════════════════════════════════════════════╝",
        "",
        "  Totals",
        `    Entries:       ${agg.entry_count}`,
        `    Tokens in:     ${agg.total_tokens_in.toLocaleString()}`,
        `    Tokens out:    ${agg.total_tokens_out.toLocaleString()}`,
        `    Total tokens:  ${agg.total_tokens.toLocaleString()}`,
        `    \x1b[1;33mTotal cost:    ${usd(agg.total_cost)}\x1b[0m`,
        `    Avg latency:   ${Math.round(agg.avg_latency_ms)}ms`,
      ];

      // Cost by agent
      const byAgent = Object.entries(agg.cost_by_agent).sort((a, b) => b[1].cost - a[1].cost);
      if (byAgent.length > 0) {
        lines.push("", "  Cost by Agent", "  " + "─".repeat(60));
        for (const [agent, s] of byAgent.slice(0, 15)) {
          const share = agg.total_cost > 0 ? ((s.cost / agg.total_cost) * 100).toFixed(1) : "0.0";
          lines.push(
            `    ${agent.padEnd(28)} ${usd(s.cost).padStart(10)}  ${share.padStart(5)}%  ${s.calls} calls`,
          );
        }
      }

      // Cost by model
      const byModel = Object.entries(agg.cost_by_model).sort((a, b) => b[1].cost - a[1].cost);
      if (byModel.length > 0) {
        lines.push("", "  Cost by Model", "  " + "─".repeat(60));
        for (const [model, s] of byModel) {
          lines.push(
            `    ${model.padEnd(28)} ${usd(s.cost).padStart(10)}  ${s.calls} calls  ${s.tokens.toLocaleString()} tok`,
          );
        }
      }

      // Top tasks by cost
      const byTask = Object.entries(agg.cost_by_task).sort((a, b) => b[1].cost - a[1].cost);
      if (byTask.length > 0) {
        lines.push("", "  Top Tasks by Cost", "  " + "─".repeat(60));
        for (const [taskId, s] of byTask.slice(0, 10)) {
          lines.push(`    ${taskId.padEnd(12)} ${usd(s.cost).padStart(10)}  ${s.calls} calls`);
        }
      }

      // Investigation budgets
      const limitIds = Object.keys(state.budget_limits);
      if (limitIds.length > 0) {
        lines.push("", "  Investigation Budgets", "  " + "─".repeat(60));
        for (const id of limitIds) {
          const ls = limitStatus(state, id);
          if (!ls) continue;
          const tokStr =
            ls.max_tokens != null ? `${ls.used_tokens.toLocaleString()}/${ls.max_tokens.toLocaleString()}` : "∞";
          const costStr = ls.max_cost != null ? `${usd(ls.used_cost)}/${usd(ls.max_cost)}` : `${usd(ls.used_cost)}/∞`;
          const flag = ls.tokens_exceeded || ls.cost_exceeded ? " \x1b[1;31mOVER\x1b[0m" : "";
          lines.push(`    ${id.padEnd(24)} tokens ${tokStr}  cost ${costStr}${flag}`);
        }
      }

      // Recent entries
      lines.push("", "  Recent Entries", "  " + "─".repeat(60));
      for (const c of state.costs.slice(-8).reverse()) {
        lines.push(
          `    ${c.timestamp.slice(11, 19)}  ${c.agent.padEnd(20)} ${c.model.padEnd(9)} ` +
            `${usd(c.cost).padStart(9)}  ${c.latency_ms}ms  ${c.task_id}`,
        );
      }

      lines.push("");
      return lines.join("\n");
    },
  });
}
