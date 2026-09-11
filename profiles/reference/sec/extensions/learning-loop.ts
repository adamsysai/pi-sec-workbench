/**
 * Learning Loop — post-investigation knowledge extraction for pi-sec
 *
 * After a finding is CONFIRMED or a hypothesis is REJECTED, extract knowledge
 * and propagate it into every knowledge subsystem:
 *
 *   CONFIRMED FINDING    → pattern library + collective memory + benchmark
 *   REJECTED HYPOTHESIS  → false-positive memory (future FP checks)
 *
 * The system improves through RAG (retrieval), structured memory (collective
 * memory), the security knowledge graph, the pattern library, and the
 * benchmark — never through fine-tuning.
 *
 * Storage:
 *   ~/.pi/agent/sec-data/patterns/          learned-{finding_id}.json (+ index.json)
 *   ~/.pi/agent/sec-data/false-positives/   {hypothesis_id}.json      (+ index.json)
 *   ~/.pi/agent/sec-data/benchmark/         case-{finding_id}.json
 *   ~/.pi/agent/sec-data/collective-memory.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Paths ───────────────────────────────────────────────────────────────────

const DATA_DIR      = path.resolve(process.env.PI_SEC_DATA_DIR || ".local/reference-data");
const PATTERNS_DIR  = path.join(DATA_DIR, "patterns");
const FP_DIR        = path.join(DATA_DIR, "false-positives");
const BENCH_DIR     = path.join(DATA_DIR, "benchmark");
const GRAPH_FILE    = path.join(DATA_DIR, "security-graph.json");
const MEMORY_FILE   = path.join(DATA_DIR, "collective-memory.json");
const PATTERN_INDEX = path.join(PATTERNS_DIR, "index.json");
const FP_INDEX      = path.join(FP_DIR, "index.json");

// ─── Types ───────────────────────────────────────────────────────────────────

interface LearnedPattern {
  finding_id: string;
  extracted_at: string;
  vulnerability_class: string;
  root_cause: string;
  architecture_pattern?: string;
  observable_signals: string[];
  attack_path: string[];
  validation_method: string;
  remediation: string;
  severity?: string;
  target_context?: Record<string, string>;
  source: "confirmed_finding";
}

interface FalsePositiveEntry {
  hypothesis_id: string;
  recorded_at: string;
  rejection_reason: string;
  looked_like_vuln: string;
  why_it_wasnt: string;
  detection_heuristics: string[];
  vulnerability_class?: string;
  source: "rejected_hypothesis";
}

interface BenchmarkCase {
  case_id: string;
  source_finding: string;
  added_at: string;
  vulnerability_class: string;
  severity?: string;
  target_context?: Record<string, string>;
  observable_signals: string[];
  attack_path: string[];
  validation_method: string;
  remediation: string;
  expected_outcome: "detect" | "do_not_report";
}

interface CollectiveMemoryEntry {
  id: string;
  recorded_at: string;
  kind: "confirmed_finding" | "rejected_hypothesis";
  summary: string;
  details: string;
  tags: string[];
}

interface CollectiveMemory {
  entries: CollectiveMemoryEntry[];
  updated?: string;
}

interface PatternIndex {
  patterns: { finding_id: string; vulnerability_class: string; added_at: string; file: string }[];
  updated?: string;
}

interface FpIndex {
  false_positives: { hypothesis_id: string; vulnerability_class?: string; added_at: string; file: string }[];
  updated?: string;
}

// ─── Persistence helpers ─────────────────────────────────────────────────────

function ensureDirs() {
  for (const d of [DATA_DIR, PATTERNS_DIR, FP_DIR, BENCH_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function saveJson(file: string, data: unknown) {
  ensureDirs();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** Find a finding node in the security graph by ID (exact or suffix match). */
function findGraphFinding(findingId: string): { label?: string; detail?: string; severity?: string; metadata?: Record<string, string> } | undefined {
  const g = loadJson<{ nodes: { id: string; type: string; label: string; detail?: string; severity?: string; metadata?: Record<string, string> }[] }>(GRAPH_FILE, { nodes: [] });
  const findings = g.nodes.filter((n) => n.type === "finding");
  return (
    findings.find((n) => n.id === findingId) ??
    findings.find((n) => n.id.endsWith(`:${findingId}`) || n.id.includes(findingId))
  );
}

/** True if the finding carries enough evidence to be a benchmark case. */
function benchmarkSuitable(p: LearnedPattern): boolean {
  const hasEvidence =
    p.observable_signals.length > 0 &&
    p.validation_method.trim().length > 0 &&
    p.attack_path.length > 0;
  const exploitableClass = !/^(?:info|informational|best.practice|hardening)$/i.test(p.vulnerability_class);
  return hasEvidence && exploitableClass;
}

/** Add a node + link into the security graph so knowledge is graph-reachable. */
function updateGraphKnowledge(id: string, label: string, detail: string, linkTo: string | undefined, relationship: string) {
  const g = loadJson<{ nodes: any[]; edges: any[]; meta?: any }>(GRAPH_FILE, { nodes: [], edges: [], meta: {} });
  const node = {
    id,
    type: "finding",
    label,
    detail,
    created: new Date().toISOString(),
  };
  const idx = g.nodes.findIndex((n) => n.id === id);
  if (idx >= 0) g.nodes[idx] = node;
  else g.nodes.push(node);

  if (linkTo && !g.nodes.some((n) => n.id === linkTo)) {
    g.nodes.push({ id: linkTo, type: "finding", label: linkTo, created: new Date().toISOString() });
  }
  if (linkTo) {
    const dup = g.edges.some((e) => e.from === linkTo && e.to === id && e.relationship === relationship);
    if (!dup) g.edges.push({ from: linkTo, to: id, relationship, detail: label });
  }

  g.meta = { ...g.meta, updated: new Date().toISOString() };
  saveJson(GRAPH_FILE, g);
}

function addCollectiveMemory(entry: CollectiveMemoryEntry) {
  const mem = loadJson<CollectiveMemory>(MEMORY_FILE, { entries: [] });
  // Replace same-id entry if re-learning
  mem.entries = mem.entries.filter((e) => e.id !== entry.id);
  mem.entries.push(entry);
  // Cap active entries — oldest rotate out
  if (mem.entries.length > 500) mem.entries = mem.entries.slice(-500);
  mem.updated = new Date().toISOString();
  saveJson(MEMORY_FILE, mem);
}

// ─── Status ──────────────────────────────────────────────────────────────────

interface LearnStatus {
  patterns_learned: number;
  false_positives_recorded: number;
  benchmark_cases: number;
  knowledge_items_extracted: number;
  collective_memory_entries: number;
  recent_patterns: { finding_id: string; vulnerability_class: string; added_at: string }[];
  recent_false_positives: { hypothesis_id: string; added_at: string }[];
  recent_benchmark: { case_id: string; added_at: string }[];
}

function computeStatus(): LearnStatus {
  ensureDirs();

  const patternFiles = fs.readdirSync(PATTERNS_DIR).filter((f) => f.startsWith("learned-") && f.endsWith(".json"));
  const fpFiles = fs.readdirSync(FP_DIR).filter((f) => f.endsWith(".json") && f !== "index.json");
  const benchFiles = fs.readdirSync(BENCH_DIR).filter((f) => f.startsWith("case-") && f.endsWith(".json"));
  const mem = loadJson<CollectiveMemory>(MEMORY_FILE, { entries: [] });

  const readSafe = <T>(dir: string, f: string): T | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as T;
    } catch {
      return null;
    }
  };

  const recent = <T extends { extracted_at?: string; recorded_at?: string; added_at?: string }>(items: T[]) =>
    [...items].sort((a, b) =>
      (b.extracted_at ?? b.recorded_at ?? b.added_at ?? "").localeCompare(a.extracted_at ?? a.recorded_at ?? a.added_at ?? ""),
    );

  const patterns = recent(patternFiles.map((f) => readSafe<LearnedPattern>(PATTERNS_DIR, f)).filter(Boolean) as LearnedPattern[]);
  const fps = recent(fpFiles.map((f) => readSafe<FalsePositiveEntry>(FP_DIR, f)).filter(Boolean) as FalsePositiveEntry[]);
  const bench = recent(benchFiles.map((f) => readSafe<BenchmarkCase>(BENCH_DIR, f)).filter(Boolean) as BenchmarkCase[]);

  return {
    patterns_learned: patternFiles.length,
    false_positives_recorded: fpFiles.length,
    benchmark_cases: benchFiles.length,
    knowledge_items_extracted: patternFiles.length + fpFiles.length + benchFiles.length,
    collective_memory_entries: mem.entries.length,
    recent_patterns: patterns.slice(0, 10).map((p) => ({
      finding_id: p.finding_id,
      vulnerability_class: p.vulnerability_class,
      added_at: p.extracted_at,
    })),
    recent_false_positives: fps.slice(0, 10).map((fp) => ({
      hypothesis_id: fp.hypothesis_id,
      added_at: fp.recorded_at,
    })),
    recent_benchmark: bench.slice(0, 10).map((b) => ({
      case_id: b.case_id,
      added_at: b.added_at,
    })),
  };
}

function statusMarkdown(s: LearnStatus): string {
  const lines = [
    "## Learning Loop status",
    "",
    "The system improves through RAG, structured memory, knowledge graph, pattern library, and benchmark — not fine-tuning.",
    "",
    `**Patterns learned**: ${s.patterns_learned}`,
    `**False positives recorded**: ${s.false_positives_recorded}`,
    `**Benchmark cases added**: ${s.benchmark_cases}`,
    `**Knowledge items extracted**: ${s.knowledge_items_extracted}`,
    `**Collective memory entries**: ${s.collective_memory_entries}`,
  ];

  if (s.recent_patterns.length) {
    lines.push("", "**Recent pattern extractions**:");
    for (const p of s.recent_patterns) {
      lines.push(`  - ${p.finding_id} — ${p.vulnerability_class} (${p.added_at ?? "unknown date"})`);
    }
  }
  if (s.recent_false_positives.length) {
    lines.push("", "**Recent false positives**:");
    for (const fp of s.recent_false_positives) {
      lines.push(`  - ${fp.hypothesis_id} (${fp.added_at ?? "unknown date"})`);
    }
  }
  if (s.recent_benchmark.length) {
    lines.push("", "**Recent benchmark cases**:");
    for (const b of s.recent_benchmark) {
      lines.push(`  - ${b.case_id} (${b.added_at ?? "unknown date"})`);
    }
  }
  if (!s.knowledge_items_extracted) {
    lines.push("", "(nothing learned yet — call learn_from_finding after confirmed findings, learn_from_rejection after rejected hypotheses)");
  }
  return lines.join("\n");
}

/** Compact knowledge digest injected at turn start so learnings steer future work. */
function knowledgeDigest(): string | null {
  const s = computeStatus();
  if (!s.knowledge_items_extracted) return null;

  const mem = loadJson<CollectiveMemory>(MEMORY_FILE, { entries: [] });
  const recentMem = mem.entries.slice(-8);

  const lines = [
    "## Learned knowledge (learning loop)",
    "",
    `${s.patterns_learned} patterns | ${s.false_positives_recorded} false positives | ${s.benchmark_cases} benchmark cases`,
  ];

  if (s.recent_patterns.length) {
    lines.push("", "Known vulnerability patterns (apply pattern matching first):");
    for (const p of s.recent_patterns.slice(0, 5)) {
      lines.push(`  - ${p.vulnerability_class} (${p.finding_id})`);
    }
  }
  if (s.recent_false_positives.length) {
    lines.push("", "Known false positives (run sec_rag_false_positive_check before reporting):");
    for (const fp of s.recent_false_positives.slice(0, 5)) {
      lines.push(`  - ${fp.hypothesis_id}`);
    }
  }
  if (recentMem.length) {
    lines.push("", "Recent collective memory:");
    for (const m of recentMem) {
      lines.push(`  - [${m.kind}] ${m.summary}`);
    }
  }
  return lines.join("\n");
}

// ─── Extension registration ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // Inject learned knowledge as context at the start of each agent turn
  pi.on("before_agent_start", async (event: any) => {
    const digest = knowledgeDigest();
    if (!digest) return;
    return { systemPrompt: (event.systemPrompt ?? "") + "\n\n" + digest };
  });

  // ── learn_from_finding ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "learn_from_finding",
    description:
      "Extract knowledge from a CONFIRMED finding and update all knowledge subsystems. Call after a finding is validated. Extracts vulnerability class, root cause, architecture pattern, observable signals, attack path, validation method, and remediation. Updates the pattern library, collective memory, security graph, and benchmark (when suitable). Stores at ~/.pi/agent/sec-data/patterns/learned-{finding_id}.json.",
    parameters: {
      type: "object",
      properties: {
        finding_id: {
          type: "string",
          description: "ID of the confirmed finding (must match the security graph / casefile finding ID)",
        },
        vulnerability_class: {
          type: "string",
          description: "Vulnerability class (e.g. 'SQL injection — second order', 'SSRF — metadata endpoint', 'IDOR — horizontal privilege escalation')",
        },
        root_cause: {
          type: "string",
          description: "Root cause: the code defect or design flaw that makes the vulnerability possible",
        },
        architecture_pattern: {
          type: "string",
          description: "Architecture pattern in which the flaw occurs (e.g. 'API gateway → microservice without input validation', 'monolith with direct DB access')",
        },
        observable_signals: {
          type: "array",
          items: { type: "string" },
          description: "Observable signals that indicated the issue (e.g. 'reflected error syntax', 'timing differential >500ms', 'verbose stack trace in response')",
        },
        attack_path: {
          type: "array",
          items: { type: "string" },
          description: "Attack path steps from entry point to impact (e.g. ['unauthenticated POST /api/v1/import', 'parser fetches attacker URL', 'cloud metadata credentials leaked'])",
        },
        validation_method: {
          type: "string",
          description: "How the finding was validated without doubt (e.g. 'exfiltrated benign canary token to attacker-controlled listener')",
        },
        remediation: {
          type: "string",
          description: "Remediation that removes the root cause (not just the symptom)",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low", "info"],
          description: "Severity of the confirmed finding",
        },
        target_context: {
          type: "object",
          description: "Target context metadata (e.g. { technology: 'Django 4.2', component: 'payments-api' })",
          additionalProperties: { type: "string" },
        },
      },
      required: ["finding_id", "vulnerability_class", "root_cause", "observable_signals", "attack_path", "validation_method", "remediation"],
    },
    execute: async (params: any) => {
      const now = new Date().toISOString();

      // Enrich from security graph when the finding node exists there
      const graphNode = findGraphFinding(params.finding_id);
      const severity = params.severity ?? graphNode?.severity;
      const targetContext: Record<string, string> = {
        ...(graphNode?.metadata ?? {}),
        ...(params.target_context ?? {}),
      };

      const pattern: LearnedPattern = {
        finding_id: params.finding_id,
        extracted_at: now,
        vulnerability_class: params.vulnerability_class,
        root_cause: params.root_cause,
        architecture_pattern: params.architecture_pattern,
        observable_signals: params.observable_signals ?? [],
        attack_path: params.attack_path ?? [],
        validation_method: params.validation_method,
        remediation: params.remediation,
        severity,
        target_context: Object.keys(targetContext).length ? target_context : undefined,
        source: "confirmed_finding",
      };

      ensureDirs();
      const safeId = params.finding_id.replace(/[^a-zA-Z0-9_-]/g, "_");
      const patternPath = path.join(PATTERNS_DIR, `learned-${safeId}.json`);
      saveJson(patternPath, pattern);

      // ── Pattern library index (pattern_add equivalent) ──
      const pIdx = loadJson<PatternIndex>(PATTERN_INDEX, { patterns: [] });
      pIdx.patterns = pIdx.patterns.filter((p) => p.finding_id !== params.finding_id);
      pIdx.patterns.push({
        finding_id: params.finding_id,
        vulnerability_class: pattern.vulnerability_class,
        added_at: now,
        file: patternPath,
      });
      pIdx.updated = now;
      saveJson(PATTERN_INDEX, pIdx);

      // ── Collective memory ──
      addCollectiveMemory({
        id: `finding:${params.finding_id}`,
        recorded_at: now,
        kind: "confirmed_finding",
        summary: `${pattern.vulnerability_class} confirmed (${severity ?? "severity unset"}) — ${params.finding_id}`,
        details:
          `Root cause: ${pattern.root_cause}. ` +
          `Signals: ${pattern.observable_signals.join("; ")}. ` +
          `Attack path: ${pattern.attack_path.join(" → ")}. ` +
          `Validation: ${pattern.validation_method}. ` +
          `Remediation: ${pattern.remediation}.`,
        tags: ["confirmed-finding", pattern.vulnerability_class.toLowerCase(), ...(severity ? [severity] : [])],
      });

      // ── Security graph: knowledge node linked back to the finding ──
      const graphFindingId = graphNode ? (graphNode as any).id ?? params.finding_id : `finding:${params.finding_id}`;
      updateGraphKnowledge(
        `pattern:${safeId}`,
        `Pattern: ${pattern.vulnerability_class}`,
        `Learned from ${params.finding_id}. Root cause: ${pattern.root_cause}`,
        graphFindingId,
        "ENABLES",
      );

      // ── Benchmark case (only when suitable: real evidence + exploitable class) ──
      let benchmarkAdded = false;
      if (benchmarkSuitable(pattern)) {
        const benchCase: BenchmarkCase = {
          case_id: `case-${safeId}`,
          source_finding: params.finding_id,
          added_at: now,
          vulnerability_class: pattern.vulnerability_class,
          severity,
          target_context: pattern.target_context,
          observable_signals: pattern.observable_signals,
          attack_path: pattern.attack_path,
          validation_method: pattern.validation_method,
          remediation: pattern.remediation,
          expected_outcome: "detect",
        };
        saveJson(path.join(BENCH_DIR, `case-${safeId}.json`), benchCase);
        benchmarkAdded = true;
      }

      const status = computeStatus();
      return {
        content:
          `✓ Knowledge extracted from confirmed finding **${params.finding_id}**\n\n` +
          `**Vulnerability class**: ${pattern.vulnerability_class}\n` +
          `**Root cause**: ${pattern.root_cause}\n` +
          `**Architecture pattern**: ${pattern.architecture_pattern ?? "n/a"}\n` +
          `**Observable signals**: ${pattern.observable_signals.join(", ")}\n` +
          `**Attack path**: ${pattern.attack_path.join(" → ")}\n` +
          `**Validation**: ${pattern.validation_method}\n` +
          `**Remediation**: ${pattern.remediation}\n\n` +
          `**Updates**:\n` +
          `- Pattern library: ${patternPath}\n` +
          `- Collective memory: entry 'finding:${params.finding_id}' added\n` +
          `- Security graph: pattern:${safeId} linked via ENABLES\n` +
          `- Benchmark: ${benchmarkAdded ? `case-${safeId} added` : "skipped (insufficient evidence or non-exploitable class)"}\n\n` +
          `Totals: ${status.patterns_learned} patterns, ${status.false_positives_recorded} false positives, ${status.benchmark_cases} benchmark cases.`,
      };
    },
  });

  // ── learn_from_rejection ────────────────────────────────────────────────────

  pi.registerTool({
    name: "learn_from_rejection",
    description:
      "Extract knowledge from a REJECTED hypothesis and record it as a false positive. Call after a hypothesis is disproven so the same dead end is not investigated twice. Extracts what made it look like a vulnerability, why it wasn't, and how to detect similar false positives. Updates false-positive memory (queried by sec_rag_false_positive_check) and collective memory. Stores at ~/.pi/agent/sec-data/false-positives/.",
    parameters: {
      type: "object",
      properties: {
        hypothesis_id: {
          type: "string",
          description: "ID of the rejected hypothesis",
        },
        rejection_reason: {
          type: "string",
          description: "Why the hypothesis was rejected (e.g. 'input sanitized server-side by parameterized query', 'endpoint requires internal-only mTLS')",
        },
        looked_like_vuln: {
          type: "string",
          description: "What made it look like a vulnerability (e.g. 'error message echoed SQL syntax fragment', 'admin panel reachable without auth redirect')",
        },
        why_it_wasnt: {
          type: "string",
          description: "Why it was not actually exploitable — the definitive evidence",
        },
        detection_heuristics: {
          type: "array",
          items: { type: "string" },
          description: "How to detect similar false positives early (e.g. 'check for parameterized queries before reporting error-based SQLi', 'verify auth middleware order — panel redirects after 200 response')",
        },
        vulnerability_class: {
          type: "string",
          description: "Vulnerability class the hypothesis belonged to (e.g. 'SQL injection', 'broken access control')",
        },
      },
      required: ["hypothesis_id", "rejection_reason", "looked_like_vuln", "why_it_wasnt", "detection_heuristics"],
    },
    execute: async (params: any) => {
      const now = new Date().toISOString();
      const safeId = params.hypothesis_id.replace(/[^a-zA-Z0-9_-]/g, "_");

      const entry: FalsePositiveEntry = {
        hypothesis_id: params.hypothesis_id,
        recorded_at: now,
        rejection_reason: params.rejection_reason,
        looked_like_vuln: params.looked_like_vuln,
        why_it_wasnt: params.why_it_wasnt,
        detection_heuristics: params.detection_heuristics ?? [],
        vulnerability_class: params.vulnerability_class,
        source: "rejected_hypothesis",
      };

      ensureDirs();
      const fpPath = path.join(FP_DIR, `${safeId}.json`);
      saveJson(fpPath, entry);

      // ── False-positive index (consumed by sec_rag_false_positive_check) ──
      const fpIdx = loadJson<FpIndex>(FP_INDEX, { false_positives: [] });
      fpIdx.false_positives = fpIdx.false_positives.filter((fp) => fp.hypothesis_id !== params.hypothesis_id);
      fpIdx.false_positives.push({
        hypothesis_id: params.hypothesis_id,
        vulnerability_class: params.vulnerability_class,
        added_at: now,
        file: fpPath,
      });
      fpIdx.updated = now;
      saveJson(FP_INDEX, fpIdx);

      // ── Collective memory — dead ends must not be re-investigated ──
      addCollectiveMemory({
        id: `rejected:${params.hypothesis_id}`,
        recorded_at: now,
        kind: "rejected_hypothesis",
        summary: `${params.vulnerability_class ?? "hypothesis"} rejected — ${params.hypothesis_id}: ${params.rejection_reason}`,
        details:
          `Looked like: ${params.looked_like_vuln}. ` +
          `Why it wasn't: ${params.why_it_wasnt}. ` +
          `Early detection: ${params.detection_heuristics.join("; ")}.`,
        tags: ["rejected-hypothesis", "false-positive", ...(params.vulnerability_class ? [params.vulnerability_class.toLowerCase()] : [])],
      });

      // ── Security graph: mark the hypothesis node as rejected ──
      updateGraphKnowledge(
        `rejected:${safeId}`,
        `Rejected: ${params.vulnerability_class ?? params.hypothesis_id}`,
        `${params.looked_like_vuln} — but not exploitable: ${params.why_it_wasnt}`,
        `hypothesis:${params.hypothesis_id}`,
        "COMBINES_WITH",
      );

      const status = computeStatus();
      return {
        content:
          `✓ False positive recorded for rejected hypothesis **${params.hypothesis_id}**\n\n` +
          `**Rejection reason**: ${params.rejection_reason}\n` +
          `**Looked like a vuln because**: ${params.looked_like_vuln}\n` +
          `**Why it wasn't**: ${params.why_it_wasnt}\n` +
          `**Early detection heuristics**:\n${params.detection_heuristics.map((h: string) => `  - ${h}`).join("\n")}\n\n` +
          `**Updates**:\n` +
          `- False-positive memory: ${fpPath} (indexed for sec_rag_false_positive_check)\n` +
          `- Collective memory: entry 'rejected:${params.hypothesis_id}' added\n` +
          `- Security graph: rejected:${safeId} recorded\n\n` +
          `Totals: ${status.false_positives_recorded} false positives, ${status.patterns_learned} patterns, ${status.benchmark_cases} benchmark cases.`,
      };
    },
  });

  // ── learn_status ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "learn_status",
    description:
      "Show what the learning loop has learned: patterns learned, false positives recorded, benchmark cases added, knowledge items extracted, and recent extractions.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (_params: any) => {
      return { content: statusMarkdown(computeStatus()) };
    },
  });

  // ── /learn command ──────────────────────────────────────────────────────────

  pi.registerCommand("learn", {
    description: "Show learning status and recent knowledge extractions (patterns, false positives, benchmark cases)",
    handler: async (_args: string) => {
      return statusMarkdown(computeStatus());
    },
  });
}
