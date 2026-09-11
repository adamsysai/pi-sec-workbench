/**
 * Evaluation — benchmarking and metrics for the security swarm
 *
 * Benchmark cases: ~/.pi/agent/sec-data/benchmark/cases.json
 * Current metrics: ~/.pi/agent/sec-data/eval/metrics.json
 * Versioned metrics: ~/.pi/agent/sec-data/eval/metrics-{version}.json
 *
 * eval_record is the ingest path — agents call it when a finding is
 * confirmed/rejected or a duplicate investigation is detected. Derived
 * metrics (validation_accuracy, benchmark_success_rate) are recomputed
 * on every write.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ════════════════════════════════════════════════════════════════════════════
//  Types
// ════════════════════════════════════════════════════════════════════════════

interface BenchmarkCase {
  case_id: string;
  architecture: string;
  observations: string;
  investigation_context: string;
  actual_vulnerability: string;
  root_cause: string;
  expected_reasoning_path: string;
  false_positive_alternatives: string;
  validation_result: string;
  created_at?: string;
}

interface BenchmarkStore {
  cases: BenchmarkCase[];
  counter: number;
}

type RecordType = "finding" | "hypothesis" | "duplicate";
type RecordResult = "confirmed" | "rejected" | "duplicate";

interface OutcomeRecord {
  timestamp: string;
  type: RecordType;
  result: RecordResult;
  details: unknown;
}

interface Metrics {
  // raw counters
  true_findings: number;
  false_positives: number;
  duplicate_investigations: number;
  // derived
  validation_accuracy: number;
  time_to_discovery: number;
  // cost
  token_cost: number;
  tool_calls: number;
  // hypotheses
  hypotheses_created: number;
  hypotheses_rejected: number;
  // discovery
  attack_chains_discovered: number;
  high_impact_findings: number;
  // benchmark
  benchmark_success_rate: number;
  // bookkeeping (not part of the reported contract)
  _benchmark_runs?: BenchmarkRun[];
  _records?: OutcomeRecord[];
  _updated_at?: string;
}

interface BenchmarkRun {
  case_id: string;
  timestamp: string;
  outcome: "success" | "failure";
  details?: unknown;
}

// ════════════════════════════════════════════════════════════════════════════
//  Persistence
// ════════════════════════════════════════════════════════════════════════════

const DATA_DIR = path.resolve(process.env.PI_SEC_DATA_DIR || ".local/reference-data");
const BENCHMARK_DIR = path.join(DATA_DIR, "benchmark");
const CASES_FILE = path.join(BENCHMARK_DIR, "cases.json");
const EVAL_DIR = path.join(DATA_DIR, "eval");
const METRICS_FILE = path.join(EVAL_DIR, "metrics.json");

function now(): string {
  return new Date().toISOString();
}

function loadCases(): BenchmarkStore {
  try {
    const raw = fs.readFileSync(CASES_FILE, "utf8");
    const s = JSON.parse(raw) as BenchmarkStore;
    if (!Array.isArray(s.cases)) s.cases = [];
    if (typeof s.counter !== "number") s.counter = 0;
    return s;
  } catch {
    return { cases: [], counter: 0 };
  }
}

function saveCases(s: BenchmarkStore): void {
  fs.mkdirSync(BENCHMARK_DIR, { recursive: true });
  fs.writeFileSync(CASES_FILE, JSON.stringify(s, null, 2), "utf8");
}

function defaultMetrics(): Metrics {
  return {
    true_findings: 0,
    false_positives: 0,
    duplicate_investigations: 0,
    validation_accuracy: 0,
    time_to_discovery: 0,
    token_cost: 0,
    tool_calls: 0,
    hypotheses_created: 0,
    hypotheses_rejected: 0,
    attack_chains_discovered: 0,
    high_impact_findings: 0,
    benchmark_success_rate: 0,
    _benchmark_runs: [],
    _records: [],
    _updated_at: now(),
  };
}

function loadMetrics(): Metrics {
  try {
    const raw = fs.readFileSync(METRICS_FILE, "utf8");
    const m = { ...defaultMetrics(), ...(JSON.parse(raw) as Partial<Metrics>) };
    if (!Array.isArray(m._benchmark_runs)) m._benchmark_runs = [];
    if (!Array.isArray(m._records)) m._records = [];
    return m;
  } catch {
    return defaultMetrics();
  }
}

function saveMetrics(m: Metrics): void {
  m._updated_at = now();
  fs.mkdirSync(EVAL_DIR, { recursive: true });
  fs.writeFileSync(METRICS_FILE, JSON.stringify(m, null, 2), "utf8");
}

function loadVersionedMetrics(version: string): Metrics | null {
  const file = path.join(EVAL_DIR, `metrics-${version}.json`);
  try {
    const raw = fs.readFileSync(file, "utf8");
    return { ...defaultMetrics(), ...(JSON.parse(raw) as Partial<Metrics>) };
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Derived metrics
// ════════════════════════════════════════════════════════════════════════════

function recompute(m: Metrics): void {
  // validation_accuracy = true findings / everything the swarm judged (true + false)
  const judged = m.true_findings + m.false_positives;
  m.validation_accuracy = judged > 0 ? m.true_findings / judged : 0;

  // benchmark_success_rate = successful runs / total benchmark runs
  const runs = m._benchmark_runs || [];
  const successes = runs.filter((r) => r.outcome === "success").length;
  m.benchmark_success_rate = runs.length > 0 ? successes / runs.length : 0;
}

function timeToDiscoveryAvg(m: Metrics): number {
  // Average of details.time_to_discovery (minutes) across confirmed findings
  const times: number[] = [];
  for (const r of m._records || []) {
    if (r.type === "finding" && r.result === "confirmed" && r.details) {
      const d = r.details as Record<string, unknown>;
      const t = Number(d.time_to_discovery);
      if (!Number.isNaN(t)) times.push(t);
    }
  }
  return times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
}

// ════════════════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════════════════

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** Public metrics shape — strips bookkeeping fields. */
function publicMetrics(m: Metrics): Record<string, number> {
  return {
    true_findings: m.true_findings,
    false_positives: m.false_positives,
    duplicate_investigations: m.duplicate_investigations,
    validation_accuracy: m.validation_accuracy,
    time_to_discovery: timeToDiscoveryAvg(m),
    token_cost: m.token_cost,
    tool_calls: m.tool_calls,
    hypotheses_created: m.hypotheses_created,
    hypotheses_rejected: m.hypotheses_rejected,
    attack_chains_discovered: m.attack_chains_discovered,
    high_impact_findings: m.high_impact_findings,
    benchmark_success_rate: m.benchmark_success_rate,
  };
}

const CASE_FIELDS: Array<keyof Omit<BenchmarkCase, "created_at">> = [
  "case_id",
  "architecture",
  "observations",
  "investigation_context",
  "actual_vulnerability",
  "root_cause",
  "expected_reasoning_path",
  "false_positive_alternatives",
  "validation_result",
];

// ════════════════════════════════════════════════════════════════════════════
//  Extension
// ════════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {

  // ── 1. eval_metrics ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "eval_metrics",
    description:
      "Get current swarm evaluation metrics: true findings, false positives, duplicates, " +
      "validation accuracy, time to discovery, token cost, tool calls, hypothesis stats, " +
      "attack chains, high-impact findings, and benchmark success rate.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      const m = loadMetrics();
      const pub = publicMetrics(m);
      const runs = m._benchmark_runs || [];
      return {
        content: JSON.stringify({
          ok: true,
          metrics: pub,
          updated_at: m._updated_at,
          benchmark_runs: runs.length,
          total_records: (m._records || []).length,
        }, null, 2),
      };
    },
  });

  // ── 2. eval_benchmark_run ───────────────────────────────────────────────────
  pi.registerTool({
    name: "eval_benchmark_run",
    description:
      "Load a benchmark case for the swarm to run against. Returns the case details " +
      "(architecture, observations, investigation context) plus the expected outcome " +
      "(actual vulnerability, root cause, expected reasoning path, false-positive " +
      "alternatives, validation result). After the swarm completes its investigation, " +
      "call eval_record with type=finding and result derived from the comparison.",
    parameters: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "ID of the benchmark case to load",
        },
        outcome: {
          type: "string",
          enum: ["success", "failure"],
          description:
            "Optional — record the outcome of a completed run against this case. " +
            "If omitted, the case is only loaded (ready to run).",
        },
      },
      required: ["case_id"],
    },
    execute: async (params: any) => {
      const s = loadCases();
      const c = s.cases.find((x) => x.case_id === params.case_id);
      if (!c) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `Benchmark case '${params.case_id}' not found`,
            available_cases: s.cases.map((x) => x.case_id),
          }, null, 2),
        };
      }

      let recorded = false;
      if (params.outcome) {
        const m = loadMetrics();
        m._benchmark_runs!.push({
          case_id: c.case_id,
          timestamp: now(),
          outcome: params.outcome as "success" | "failure",
        });
        recompute(m);
        saveMetrics(m);
        recorded = true;
      }

      return {
        content: JSON.stringify({
          ok: true,
          case: c,
          expected_outcome: {
            actual_vulnerability: c.actual_vulnerability,
            root_cause: c.root_cause,
            expected_reasoning_path: c.expected_reasoning_path,
            false_positive_alternatives: c.false_positive_alternatives,
            validation_result: c.validation_result,
          },
          outcome_recorded: recorded,
          ready_to_run: true,
          message: recorded
            ? `Case ${c.case_id} loaded and outcome '${params.outcome}' recorded.`
            : `Case ${c.case_id} loaded — ready to run.`,
        }, null, 2),
      };
    },
  });

  // ── 3. eval_benchmark_add ───────────────────────────────────────────────────
  pi.registerTool({
    name: "eval_benchmark_add",
    description:
      "Add a new benchmark case. Cases pair observable symptoms + architecture with a " +
      "known actual vulnerability, root cause, expected reasoning path, false-positive " +
      "alternatives, and validation result — used to grade swarm investigations.",
    parameters: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "Unique case identifier (e.g. 'jwt-none-alg', 'sqli-login-001')",
        },
        architecture: {
          type: "string",
          description: "Architecture of the target system (components, trust boundaries, tech stack)",
        },
        observations: {
          type: "string",
          description: "Observable symptoms / recon data the swarm starts from",
        },
        investigation_context: {
          type: "string",
          description: "Context for the investigation (scope, engagement, prior knowledge)",
        },
        actual_vulnerability: {
          type: "string",
          description: "The ground-truth vulnerability present in this case",
        },
        root_cause: {
          type: "string",
          description: "Root cause of the actual vulnerability",
        },
        expected_reasoning_path: {
          type: "string",
          description: "The reasoning steps the swarm is expected to follow to find it",
        },
        false_positive_alternatives: {
          type: "string",
          description: "Plausible-but-wrong hypotheses the swarm should reject",
        },
        validation_result: {
          type: "string",
          description: "Expected validation result confirming the vulnerability",
        },
      },
      required: CASE_FIELDS as string[],
    },
    execute: async (params: any) => {
      // Validate all fields present and non-empty
      const missing = CASE_FIELDS.filter(
        (f) => !params[f] || String(params[f]).trim() === ""
      );
      if (missing.length > 0) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `Missing or empty required field(s): ${missing.join(", ")}`,
          }, null, 2),
        };
      }

      const s = loadCases();
      if (s.cases.some((x) => x.case_id === params.case_id)) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `Benchmark case '${params.case_id}' already exists`,
          }, null, 2),
        };
      }

      const c: BenchmarkCase = {
        case_id: params.case_id,
        architecture: params.architecture,
        observations: params.observations,
        investigation_context: params.investigation_context,
        actual_vulnerability: params.actual_vulnerability,
        root_cause: params.root_cause,
        expected_reasoning_path: params.expected_reasoning_path,
        false_positive_alternatives: params.false_positive_alternatives,
        validation_result: params.validation_result,
        created_at: now(),
      };

      s.cases.push(c);
      s.counter += 1;
      saveCases(s);

      return {
        content: JSON.stringify({
          ok: true,
          case_id: c.case_id,
          total_cases: s.cases.length,
          message: `Benchmark case '${c.case_id}' added (${s.cases.length} total)`,
        }, null, 2),
      };
    },
  });

  // ── 4. eval_benchmark_list ──────────────────────────────────────────────────
  pi.registerTool({
    name: "eval_benchmark_list",
    description:
      "List all benchmark cases with a summary of each. Use eval_benchmark_run with a " +
      "case_id to get full details.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      const s = loadCases();
      if (s.cases.length === 0) {
        return {
          content: JSON.stringify({
            ok: true,
            count: 0,
            cases: [],
            message: "No benchmark cases yet — add one with eval_benchmark_add",
          }, null, 2),
        };
      }

      const cases = s.cases.map((c) => ({
        case_id: c.case_id,
        architecture: truncate(c.architecture, 80),
        actual_vulnerability: truncate(c.actual_vulnerability, 80),
        created_at: c.created_at || null,
      }));

      return {
        content: JSON.stringify({
          ok: true,
          count: cases.length,
          cases,
        }, null, 2),
      };
    },
  });

  // ── 5. eval_compare ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "eval_compare",
    description:
      "Compare evaluation metrics across two versions. Loads " +
      "~/.pi/agent/sec-data/eval/metrics-{version}.json for each version and returns " +
      "the delta per metric with improvement/regression classification.",
    parameters: {
      type: "object",
      properties: {
        version_a: {
          type: "string",
          description: "First version label (baseline) — e.g. 'v1'",
        },
        version_b: {
          type: "string",
          description: "Second version label (comparison) — e.g. 'v2'",
        },
      },
      required: ["version_a", "version_b"],
    },
    execute: async (params: any) => {
      const a = loadVersionedMetrics(params.version_a);
      const b = loadVersionedMetrics(params.version_b);

      if (!a) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `No metrics file for version '${params.version_a}' (${path.join(EVAL_DIR, `metrics-${params.version_a}.json`)})`,
          }, null, 2),
        };
      }
      if (!b) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `No metrics file for version '${params.version_b}' (${path.join(EVAL_DIR, `metrics-${params.version_b}.json`)})`,
          }, null, 2),
        };
      }

      const pa = publicMetrics(a);
      const pb = publicMetrics(b);

      // Lower is better for these
      const lowerIsBetter = new Set([
        "false_positives",
        "duplicate_investigations",
        "time_to_discovery",
        "token_cost",
        "tool_calls",
        "hypotheses_rejected",
      ]);

      const comparison: Array<Record<string, unknown>> = [];
      let improved = 0;
      let regressed = 0;

      for (const key of Object.keys(pa)) {
        const va = pa[key];
        const vb = pb[key];
        const delta = vb - va;
        const pctChange = va !== 0 ? (delta / Math.abs(va)) * 100 : null;

        let verdict: "improvement" | "regression" | "neutral" = "neutral";
        if (delta !== 0) {
          if (lowerIsBetter.has(key)) {
            verdict = delta < 0 ? "improvement" : "regression";
          } else {
            verdict = delta > 0 ? "improvement" : "regression";
          }
        }
        if (verdict === "improvement") improved++;
        if (verdict === "regression") regressed++;

        comparison.push({
          metric: key,
          version_a: va,
          version_b: vb,
          delta: Number(delta.toFixed(4)),
          pct_change: pctChange !== null ? Number(pctChange.toFixed(1)) : null,
          verdict,
        });
      }

      return {
        content: JSON.stringify({
          ok: true,
          version_a: params.version_a,
          version_b: params.version_b,
          comparison,
          summary: {
            improved: improved,
            regressed: regressed,
            neutral: comparison.length - improved - regressed,
            overall:
              improved > regressed ? "improvement" : regressed > improved ? "regression" : "neutral",
          },
        }, null, 2),
      };
    },
  });

  // ── 6. eval_record ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "eval_record",
    description:
      "Record a finding, hypothesis, or duplicate outcome for evaluation. " +
      "Ingest path for swarm metrics — call after validation confirms/rejects a finding, " +
      "when a hypothesis is created/rejected, or when a duplicate investigation is detected. " +
      "details may include: target, severity, time_to_discovery (minutes), tokens, tool_calls, " +
      "attack_chain (bool), high_impact (bool), agent, reasoning.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["finding", "hypothesis", "duplicate"],
          description: "What is being recorded",
        },
        result: {
          type: "string",
          enum: ["confirmed", "rejected", "duplicate"],
          description: "Outcome — e.g. a finding is confirmed, a hypothesis is rejected, a duplicate is flagged",
        },
        details: {
          type: "object",
          description:
            "Structured details (target, severity, time_to_discovery, tokens, tool_calls, " +
            "attack_chain, high_impact, agent, reasoning)",
        },
      },
      required: ["type", "result"],
    },
    execute: async (params: any) => {
      const type = params.type as RecordType;
      const result = params.result as RecordResult;
      const details = params.details || {};
      const d = details as Record<string, unknown>;

      const m = loadMetrics();

      // ── raw counters ──
      if (type === "finding") {
        if (result === "confirmed") {
          m.true_findings += 1;
          if (d.attack_chain === true) m.attack_chains_discovered += 1;
          if (d.high_impact === true) m.high_impact_findings += 1;
        } else if (result === "rejected") {
          m.false_positives += 1;
        }
      } else if (type === "hypothesis") {
        if (result === "confirmed" || result === "rejected") {
          m.hypotheses_created += 1;
          if (result === "rejected") m.hypotheses_rejected += 1;
        }
      } else if (type === "duplicate") {
        m.duplicate_investigations += 1;
      }

      // ── cost accounting (accepted on any record type) ──
      if (typeof d.tokens === "number") m.token_cost += d.tokens;
      if (typeof d.tool_calls === "number") m.tool_calls += d.tool_calls;
      if (typeof d.token_cost === "number") m.token_cost += d.token_cost;

      // ── bookkeeping ──
      m._records!.push({ timestamp: now(), type, result, details });

      recompute(m);
      saveMetrics(m);

      const pub = publicMetrics(m);
      return {
        content: JSON.stringify({
          ok: true,
          recorded: { type, result },
          metrics: pub,
          message: `Recorded ${type}/${result}. true_findings=${m.true_findings} false_positives=${m.false_positives} accuracy=${pct(m.validation_accuracy)}`,
        }, null, 2),
      };
    },
  });

  // ── Command: /eval ──────────────────────────────────────────────────────────
  pi.registerCommand("eval", {
    description: "Evaluation dashboard — current swarm metrics and benchmark results",
    handler: async (_args: string) => {
      const m = loadMetrics();
      const s = loadCases();
      const pub = publicMetrics(m);
      const runs = m._benchmark_runs || [];
      const successes = runs.filter((r) => r.outcome === "success").length;

      const lines: string[] = [
        "",
        "  ╔══════════════════════════════════════════════════════════════╗",
        "  ║            Security Swarm — Evaluation                        ║",
        "  ╚══════════════════════════════════════════════════════════════╝",
        "",
        "  Discovery",
        `    True findings:            \x1b[1;32m${pub.true_findings}\x1b[0m`,
        `    False positives:          \x1b[31m${pub.false_positives}\x1b[0m`,
        `    Duplicate investigations: \x1b[33m${pub.duplicate_investigations}\x1b[0m`,
        `    Attack chains discovered: \x1b[1;36m${pub.attack_chains_discovered}\x1b[0m`,
        `    High-impact findings:     \x1b[1;35m${pub.high_impact_findings}\x1b[0m`,
        "",
        "  Reasoning",
        `    Validation accuracy:      ${pct(pub.validation_accuracy)}`,
        `    Hypotheses created:       ${pub.hypotheses_created}`,
        `    Hypotheses rejected:      ${pub.hypotheses_rejected}`,
        `    Avg time to discovery:    ${pub.time_to_discovery.toFixed(1)} min`,
        "",
        "  Cost",
        `    Token cost:               ${pub.token_cost.toLocaleString()}`,
        `    Tool calls:               ${pub.tool_calls.toLocaleString()}`,
        "",
        "  Benchmark",
        `    Cases available:          ${s.cases.length}`,
        `    Runs executed:            ${runs.length}`,
        `    Success rate:             ${pct(pub.benchmark_success_rate)} (${successes}/${runs.length})`,
      ];

      // Recent benchmark runs
      if (runs.length > 0) {
        lines.push("");
        lines.push("  Recent Benchmark Runs");
        lines.push("  " + "─".repeat(60));
        const recent = runs.slice(-8).reverse();
        for (const r of recent) {
          const when = r.timestamp.slice(0, 16).replace("T", " ");
          const badge = r.outcome === "success" ? "\x1b[1;32mPASS\x1b[0m" : "\x1b[1;31mFAIL\x1b[0m";
          lines.push(`  ${badge}  ${r.case_id.padEnd(28)} ${when}`);
        }
        if (runs.length > 8) {
          lines.push(`  … and ${runs.length - 8} earlier runs`);
        }
      }

      // Benchmark cases
      if (s.cases.length > 0) {
        lines.push("");
        lines.push("  Benchmark Cases");
        lines.push("  " + "─".repeat(60));
        for (const c of s.cases) {
          lines.push(`  ${c.case_id.padEnd(28)} ${truncate(c.actual_vulnerability, 44)}`);
        }
      } else {
        lines.push("");
        lines.push("  No benchmark cases — add one with eval_benchmark_add");
      }

      if (m._updated_at) {
        lines.push("");
        lines.push(`  Last update: ${m._updated_at.replace("T", " ").slice(0, 19)}`);
      }

      lines.push("");
      return lines.join("\n");
    },
  });
}
