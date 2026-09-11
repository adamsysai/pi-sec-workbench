/**
 * Collective Memory — shared swarm memory for the security swarm
 *
 * Two levels:
 *   - LOCAL MEMORY:    agent-specific temporary knowledge (per-agent)
 *   - COLLECTIVE MEMORY: knowledge shared by the entire swarm
 *
 * Stored at ~/.pi/agent/sec-data/collective-memory.json
 * Categories: assets, architecture, identities, workflows, observations,
 * hypotheses, findings, attack_chains, false_positives, knowledge_items
 *
 * IMPORTANT: Never inject the entire memory into context.
 * Always use targeted retrieval (memory_retrieve / memory_search).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ════════════════════════════════════════════════════════════════════════════
//  Types
// ════════════════════════════════════════════════════════════════════════════

type MemoryLevel = "local" | "collective";

type MemoryCategory =
  | "assets"
  | "architecture"
  | "identities"
  | "workflows"
  | "observations"
  | "hypotheses"
  | "findings"
  | "attack_chains"
  | "false_positives"
  | "knowledge_items";

const CATEGORIES: MemoryCategory[] = [
  "assets",
  "architecture",
  "identities",
  "workflows",
  "observations",
  "hypotheses",
  "findings",
  "attack_chains",
  "false_positives",
  "knowledge_items",
];

interface MemoryItem {
  id: string;
  level: MemoryLevel;
  category: MemoryCategory;
  key: string;
  value: unknown;
  agent: string;
  confidence: number;
  title: string;
  target: string | null;
  created_at: string;
  updated_at: string;
  access_count: number;
  last_accessed_at: string | null;
}

interface MemoryStore {
  items: MemoryItem[];
  counter: number;
}

// ════════════════════════════════════════════════════════════════════════════
//  Persistence
// ════════════════════════════════════════════════════════════════════════════

const DATA_DIR = path.resolve(process.env.PI_SEC_DATA_DIR || ".local/reference-data");
const MEMORY_FILE = path.join(DATA_DIR, "collective-memory.json");

function load(): MemoryStore {
  try {
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    const m = JSON.parse(raw) as MemoryStore;
    if (!Array.isArray(m.items)) m.items = [];
    if (typeof m.counter !== "number") m.counter = 0;
    return m;
  } catch {
    return { items: [], counter: 0 };
  }
}

function save(m: MemoryStore): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(m, null, 2), "utf8");
}

function now(): string {
  return new Date().toISOString();
}

function nextId(m: MemoryStore): string {
  m.counter += 1;
  return `M-${String(m.counter).padStart(4, "0")}`;
}

// ════════════════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════════════════

function normalizeCategory(c: string): MemoryCategory | null {
  const lower = String(c || "").toLowerCase().trim();
  if ((CATEGORIES as string[]).includes(lower)) return lower as MemoryCategory;
  // Common aliases
  const aliases: Record<string, MemoryCategory> = {
    asset: "assets",
    hosts: "assets",
    domains: "assets",
    endpoints: "assets",
    arch: "architecture",
    map: "architecture",
    identity: "identities",
    users: "identities",
    roles: "identities",
    orgs: "identities",
    permissions: "identities",
    workflow: "workflows",
    business_workflows: "workflows",
    observation: "observations",
    hypothesis: "hypotheses",
    finding: "findings",
    chains: "attack_chains",
    attack_chain: "attack_chains",
    fp: "false_positives",
    false_positive: "false_positives",
    rejected: "false_positives",
    knowledge: "knowledge_items",
    knowledge_item: "knowledge_items",
  };
  return aliases[lower] || null;
}

function deriveTitle(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, 120);
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    for (const field of ["title", "name", "host", "domain", "url", "endpoint", "description", "summary", "note"]) {
      if (typeof v[field] === "string" && v[field]) return String(v[field]).slice(0, 120);
    }
  }
  return "";
}

function deriveTarget(value: unknown): string | null {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    for (const field of ["target", "host", "domain", "url", "ip", "endpoint", "scope"]) {
      if (typeof v[field] === "string" && v[field]) return String(v[field]);
    }
  }
  return null;
}

/** Serialize an item's searchable text: title + key + value flattened. */
function itemText(item: MemoryItem): string {
  const parts: string[] = [item.title, item.key, item.category];
  if (item.target) parts.push(item.target);
  try {
    parts.push(JSON.stringify(item.value));
  } catch {
    /* non-serializable value — skip */
  }
  return parts.join(" ").toLowerCase();
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s.\-_/]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Simple relevance scoring: fraction of query tokens present in item text. */
function relevanceScore(query: string, item: MemoryItem): number {
  const text = itemText(item);
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const tok of tokens) {
    if (text.includes(tok)) hits += 1;
  }
  return hits / tokens.length;
}

/** Word-overlap Jaccard similarity between two strings. */
function similarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function publicItem(item: MemoryItem, includeValue = true): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: item.id,
    level: item.level,
    category: item.category,
    key: item.key,
    title: item.title,
    target: item.target,
    agent: item.agent,
    confidence: item.confidence,
    created_at: item.created_at,
    updated_at: item.updated_at,
    access_count: item.access_count,
  };
  if (includeValue) out.value = item.value;
  return out;
}

function markAccessed(items: MemoryItem[]): void {
  const ts = now();
  for (const item of items) {
    item.access_count += 1;
    item.last_accessed_at = ts;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Extension
// ════════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {

  // ── 1. memory_store ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "swarm_memory_store",
    description:
      "Store an item in shared swarm memory. Two levels: 'collective' (default — shared by the " +
      "entire swarm) and 'local' (agent-specific temporary knowledge). Categories: assets, " +
      "architecture, identities, workflows, observations, hypotheses, findings, attack_chains, " +
      "false_positives, knowledge_items. If an item with the same (level, category, key) already " +
      "exists it is updated (merged) instead of duplicated.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: CATEGORIES,
          description: "Memory category (assets, architecture, identities, workflows, observations, hypotheses, findings, attack_chains, false_positives, knowledge_items)",
        },
        key: {
          type: "string",
          description: "Unique key within the category (e.g. 'host:10.0.0.5', 'user:admin', 'chain:auth-bypass')",
        },
        value: {
          type: "object",
          description: "The knowledge payload — any structured object (host details, observation notes, workflow steps, …)",
        },
        agent: {
          type: "string",
          description: "Name of the agent storing this item (e.g. 'recon:subdomain', 'api', 'validator')",
        },
        confidence: {
          type: "number",
          description: "Confidence in this knowledge, 0.0–1.0 (default: 0.5)",
        },
        level: {
          type: "string",
          enum: ["local", "collective"],
          description: "Memory level: 'collective' (shared by the swarm — default) or 'local' (agent-specific temporary knowledge)",
        },
      },
      required: ["category", "key", "value", "agent"],
    },
    execute: async (params: any) => {
      const category = normalizeCategory(params.category);
      if (!category) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `Invalid category '${params.category}'. Valid: ${CATEGORIES.join(", ")}`,
          }, null, 2),
        };
      }

      const level: MemoryLevel = params.level === "local" ? "local" : "collective";
      const agent = String(params.agent || "unknown");
      const key = String(params.key || "").trim();
      if (!key) {
        return { content: JSON.stringify({ ok: false, error: "key is required" }, null, 2) };
      }

      let confidence = typeof params.confidence === "number" ? params.confidence : 0.5;
      if (confidence < 0) confidence = 0;
      if (confidence > 1) confidence = 1;

      // Local memory is scoped per-agent: same key from a different agent = different slot
      const m = load();
      const existing = m.items.find(
        (i) =>
          i.level === level &&
          i.category === category &&
          i.key === key &&
          (level === "collective" || i.agent === agent),
      );

      let item: MemoryItem;
      let action: string;

      if (existing) {
        // Merge / update: keep highest-confidence contributors' agent, refresh value
        existing.value = params.value;
        existing.confidence = confidence;
        existing.updated_at = now();
        existing.agent = agent;
        item = existing;
        action = "updated";
      } else {
        item = {
          id: nextId(m),
          level,
          category,
          key,
          value: params.value,
          agent,
          confidence,
          title: deriveTitle(params.value) || key,
          target: deriveTarget(params.value),
          created_at: now(),
          updated_at: now(),
          access_count: 0,
          last_accessed_at: null,
        };
        m.items.push(item);
        action = "created";
      }

      save(m);

      return {
        content: JSON.stringify({
          ok: true,
          id: item.id,
          action,
          level: item.level,
          category: item.category,
          key: item.key,
          agent: item.agent,
          confidence: item.confidence,
          message: `Item ${item.id} ${action} in ${level} memory (${item.category}/${item.key})`,
        }, null, 2),
      };
    },
  });

  // ── 2. memory_retrieve ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "swarm_memory_retrieve",
    description:
      "Retrieve items from shared memory by category and/or key (targeted retrieval — use this " +
      "instead of loading all memory into context). Optionally filter by level, agent, or a text " +
      "query applied to item content.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: CATEGORIES,
          description: "Filter by category (optional)",
        },
        key: {
          type: "string",
          description: "Exact key match, e.g. 'host:10.0.0.5' (optional)",
        },
        key_prefix: {
          type: "string",
          description: "Prefix match on key, e.g. 'host:' to get all hosts (optional)",
        },
        query: {
          type: "string",
          description: "Optional text search over item content (filters/reorders results)",
        },
        level: {
          type: "string",
          enum: ["local", "collective"],
          description: "Filter by memory level (optional)",
        },
        agent: {
          type: "string",
          description: "For local memory — only this agent's items (optional)",
        },
        limit: {
          type: "number",
          description: "Max results (default 25)",
        },
      },
    },
    execute: async (params: any) => {
      const m = load();
      let items = m.items;

      if (params.category) {
        const cat = normalizeCategory(params.category);
        if (!cat) {
          return {
            content: JSON.stringify({
              ok: false,
              error: `Invalid category '${params.category}'. Valid: ${CATEGORIES.join(", ")}`,
            }, null, 2),
          };
        }
        items = items.filter((i) => i.category === cat);
      }
      if (params.key) items = items.filter((i) => i.key === params.key);
      if (params.key_prefix) items = items.filter((i) => i.key.startsWith(params.key_prefix));
      if (params.level) items = items.filter((i) => i.level === params.level);
      if (params.agent) items = items.filter((i) => i.agent === params.agent);

      if (params.query) {
        const q = String(params.query);
        items = items
          .map((i) => ({ item: i, score: relevanceScore(q, i) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.item);
      }

      const limit = params.limit || 25;
      const results = items.slice(0, limit);
      markAccessed(results);
      save(m);

      return {
        content: JSON.stringify({
          ok: true,
          count: results.length,
          total_matching: items.length,
          truncated: items.length > results.length,
          items: results.map((i) => publicItem(i)),
        }, null, 2),
      };
    },
  });

  // ── 3. memory_search ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "swarm_memory_search",
    description:
      "Full-text search across all swarm memory (both local and collective, all categories). " +
      "Returns items ranked by relevance to the query. Use this to find knowledge without " +
      "knowing the exact category or key.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (tokens matched against title, key, category, target and value)",
        },
        limit: {
          type: "number",
          description: "Max results (default 10)",
        },
        min_confidence: {
          type: "number",
          description: "Only return items with confidence >= this value (optional)",
        },
      },
      required: ["query"],
    },
    execute: async (params: any) => {
      const m = load();
      const query = String(params.query || "").trim();
      if (!query) {
        return { content: JSON.stringify({ ok: false, error: "query is required" }, null, 2) };
      }

      let items = m.items;
      if (typeof params.min_confidence === "number") {
        items = items.filter((i) => i.confidence >= params.min_confidence);
      }

      const limit = params.limit || 10;
      const ranked = items
        .map((i) => ({ item: i, score: relevanceScore(query, i) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      const results = ranked.map((x) => x.item);
      markAccessed(results);
      save(m);

      return {
        content: JSON.stringify({
          ok: true,
          query,
          count: results.length,
          results: ranked.map((x) => ({
            ...publicItem(x.item),
            relevance: Number(x.score.toFixed(3)),
          })),
        }, null, 2),
      };
    },
  });

  // ── 4. memory_check_duplicate ───────────────────────────────────────────────
  pi.registerTool({
    name: "swarm_memory_check_duplicate",
    description:
      "Check if an observation/finding already exists in memory before storing it — prevents the " +
      "swarm from re-investigating known ground. Call this before memory_store for observations " +
      "and findings.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "Item type to check ('observation', 'finding', 'asset', 'hypothesis', …)",
        },
        title: {
          type: "string",
          description: "Title / summary of the item",
        },
        target: {
          type: "string",
          description: "Target the item applies to (host, domain, endpoint, …)",
        },
      },
      required: ["type", "title", "target"],
    },
    execute: async (params: any) => {
      const m = load();
      const type = String(params.type || "").toLowerCase().trim();
      const title = String(params.title || "");
      const target = String(params.target || "");

      // Map the given type to the memory categories worth checking
      const typeToCategories: Record<string, MemoryCategory[]> = {
        observation: ["observations"],
        finding: ["findings", "false_positives"],
        asset: ["assets"],
        hypothesis: ["hypotheses"],
        chain: ["attack_chains"],
        attack_chain: ["attack_chains"],
        workflow: ["workflows"],
        identity: ["identities"],
        architecture: ["architecture"],
        knowledge_item: ["knowledge_items"],
        knowledge: ["knowledge_items"],
      };
      const cats = typeToCategories[type] || (CATEGORIES as MemoryCategory[]);

      const candidates = m.items.filter((i) => cats.includes(i.category));

      const scored = candidates
        .map((i) => {
          // Compare on title primarily, target secondarily
          const titleSim = similarity(title, i.title + " " + i.key);
          const targetSim = target ? similarity(target, (i.target || "") + " " + i.key) : 0;
          const score = titleSim * 0.7 + targetSim * 0.3;
          return { item: i, score };
        })
        .filter((x) => x.score > 0.1)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      const isDuplicate = scored.length > 0 && scored[0].score >= 0.5;
      const similarityScore = scored.length > 0 ? Number(scored[0].score.toFixed(3)) : 0;

      markAccessed(scored.filter((x) => x.score >= 0.5).map((x) => x.item));
      save(m);

      return {
        content: JSON.stringify({
          ok: true,
          is_duplicate: isDuplicate,
          similarity_score: similarityScore,
          similar_items: scored.map((x) => ({
            id: x.item.id,
            category: x.item.category,
            key: x.item.key,
            title: x.item.title,
            target: x.item.target,
            level: x.item.level,
            agent: x.item.agent,
            confidence: x.item.confidence,
            similarity: Number(x.score.toFixed(3)),
          })),
          recommendation: isDuplicate
            ? `Duplicate likely (similarity ${similarityScore}) — update the existing item via memory_store with the same key instead of creating a new one`
            : scored.length > 0
              ? `Similar items exist but below duplicate threshold — safe to store, consider linking to related items`
              : `No similar items — safe to store`,
        }, null, 2),
      };
    },
  });

  // ── 5. memory_prune ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "swarm_memory_prune",
    description:
      "Remove stale entries older than the threshold (by updated_at). Never prunes findings or " +
      "false_positives unless force=true — those are durable knowledge. Use dry_run=true to " +
      "preview what would be removed.",
    parameters: {
      type: "object",
      properties: {
        max_age_days: {
          type: "number",
          description: "Maximum age in days before pruning (default: 30)",
        },
        dry_run: {
          type: "boolean",
          description: "If true, only report what would be pruned without deleting (default: false)",
        },
        force: {
          type: "boolean",
          description: "Also prune findings and false_positives (default: false)",
        },
        category: {
          type: "string",
          enum: CATEGORIES,
          description: "Restrict pruning to a single category (optional)",
        },
      },
      required: ["max_age_days"],
    },
    execute: async (params: any) => {
      const m = load();
      const maxAgeDays = Number(params.max_age_days);
      if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
        return { content: JSON.stringify({ ok: false, error: "max_age_days must be a positive number" }, null, 2) };
      }

      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      const force = params.force === true;

      let cat: MemoryCategory | null = null;
      if (params.category) {
        cat = normalizeCategory(params.category);
        if (!cat) {
          return { content: JSON.stringify({ ok: false, error: `Invalid category '${params.category}'` }, null, 2) };
        }
      }

      // Durable categories survive pruning unless forced
      const durable: MemoryCategory[] = ["findings", "false_positives"];

      const prunable = (i: MemoryItem): boolean => {
        if (cat && i.category !== cat) return false;
        if (!force && durable.includes(i.category)) return false;
        return new Date(i.updated_at).getTime() < cutoff;
      };

      const toPrune = m.items.filter(prunable);
      const kept = m.items.filter((i) => !prunable(i));

      if (params.dry_run) {
        const byCategory: Record<string, number> = {};
        for (const i of toPrune) byCategory[i.category] = (byCategory[i.category] || 0) + 1;
        return {
          content: JSON.stringify({
            ok: true,
            dry_run: true,
            would_prune: toPrune.length,
            would_keep: kept.length,
            by_category: byCategory,
            sample: toPrune.slice(0, 10).map((i) => ({
              id: i.id,
              category: i.category,
              key: i.key,
              level: i.level,
              updated_at: i.updated_at,
            })),
          }, null, 2),
        };
      }

      m.items = kept;
      save(m);

      const byCategory: Record<string, number> = {};
      for (const i of toPrune) byCategory[i.category] = (byCategory[i.category] || 0) + 1;

      return {
        content: JSON.stringify({
          ok: true,
          pruned: toPrune.length,
          remaining: kept.length,
          by_category: byCategory,
          max_age_days: maxAgeDays,
          durable_preserved: force ? "none (forced)" : "findings, false_positives",
        }, null, 2),
      };
    },
  });

  // ── Command: /memory ────────────────────────────────────────────────────────
  pi.registerCommand("memory", {
    description: "Collective memory dashboard — items by category, size, recent additions",
    handler: async (args: string) => {
      const m = load();
      const items = m.items;

      const lines: string[] = [
        "",
        "  ╔══════════════════════════════════════════════════════════════╗",
        "  ║            Swarm Collective Memory                           ║",
        "  ╚══════════════════════════════════════════════════════════════╝",
        "",
      ];

      if (items.length === 0) {
        lines.push("  Memory is empty.");
        lines.push("  Use memory_store to record the first item.");
        lines.push("");
        return lines.join("\n");
      }

      // Counts by category
      const byCategory: Record<string, { total: number; collective: number; local: number }> = {};
      for (const cat of CATEGORIES) byCategory[cat] = { total: 0, collective: 0, local: 0 };
      for (const i of items) {
        const e = byCategory[i.category] || (byCategory[i.category] = { total: 0, collective: 0, local: 0 });
        e.total += 1;
        if (i.level === "collective") e.collective += 1;
        else e.local += 1;
      }

      const totalCollective = items.filter((i) => i.level === "collective").length;
      const totalLocal = items.filter((i) => i.level === "local").length;

      lines.push(`  Total items: ${items.length}  (collective: ${totalCollective}, local: ${totalLocal})`);
      lines.push("");

      // Category table
      lines.push("  By Category");
      lines.push("  " + "─".repeat(52));
      lines.push("  " + "CATEGORY           COLLECTIVE   LOCAL    TOTAL".padEnd(52));
      lines.push("  " + "─".repeat(52));
      for (const cat of CATEGORIES) {
        const e = byCategory[cat];
        if (e.total === 0) continue;
        lines.push(`  ${cat.padEnd(18)} ${String(e.collective).padStart(9)}   ${String(e.local).padStart(5)}   ${String(e.total).padStart(5)}`);
      }
      lines.push("  " + "─".repeat(52));

      // File size
      try {
        const stat = fs.statSync(MEMORY_FILE);
        const kb = stat.size / 1024;
        lines.push(`  Store size: ${kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(2)} MB`}  (${MEMORY_FILE})`);
      } catch {
        lines.push("  Store size: unknown");
      }

      // Agents contributing
      const byAgent: Record<string, number> = {};
      for (const i of items) byAgent[i.agent] = (byAgent[i.agent] || 0) + 1;
      const agents = Object.entries(byAgent).sort((a, b) => b[1] - a[1]);
      if (agents.length > 0) {
        lines.push("");
        lines.push("  Contributing Agents");
        lines.push("  " + "─".repeat(52));
        for (const [agent, count] of agents.slice(0, 12)) {
          lines.push(`  ${truncate(agent, 34).padEnd(36)} ${String(count).padStart(4)} items`);
        }
        if (agents.length > 12) lines.push(`  … and ${agents.length - 12} more agents`);
      }

      // Recent additions
      const recent = [...items]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 10);
      lines.push("");
      lines.push("  Recent Additions");
      lines.push("  " + "─".repeat(76));
      for (const i of recent) {
        const age = Date.now() - new Date(i.created_at).getTime();
        const ageStr = age < 60000 ? `${Math.round(age / 1000)}s ago` : age < 3600000 ? `${Math.round(age / 60000)}m ago` : age < 86400000 ? `${Math.round(age / 3600000)}h ago` : `${Math.round(age / 86400000)}d ago`;
        const lvl = i.level === "local" ? "\x1b[90m[L]\x1b[0m" : "\x1b[36m[C]\x1b[0m";
        lines.push(`  ${lvl} ${i.category.padEnd(17)} ${truncate(i.title || i.key, 38).padEnd(40)} ${ageStr.padStart(8)}`);
      }

      // Most accessed
      const hot = [...items].sort((a, b) => b.access_count - a.access_count).filter((i) => i.access_count > 0).slice(0, 5);
      if (hot.length > 0) {
        lines.push("");
        lines.push("  Most Accessed");
        lines.push("  " + "─".repeat(76));
        for (const i of hot) {
          lines.push(`  ${String(i.access_count).padStart(4)}×  ${i.category.padEnd(17)} ${truncate(i.title || i.key, 48)}`);
        }
      }

      // Subcommands
      const sub = args.trim().toLowerCase();
      if (sub === "stats" || sub === "full") {
        lines.push("");
        lines.push("  Confidence Distribution");
        lines.push("  " + "─".repeat(52));
        const buckets = [0, 0, 0, 0, 0]; // 0-0.2, 0.2-0.4, ... 0.8-1.0
        for (const i of items) {
          const idx = Math.min(4, Math.floor(i.confidence * 5));
          buckets[idx] += 1;
        }
        const maxB = Math.max(...buckets, 1);
        const labels = ["0.0–0.2", "0.2–0.4", "0.4–0.6", "0.6–0.8", "0.8–1.0"];
        for (let b = 0; b < 5; b++) {
          const bar = "█".repeat(Math.round((buckets[b] / maxB) * 30));
          lines.push(`  ${labels[b]}  ${String(buckets[b]).padStart(4)}  ${bar}`);
        }
      }

      if (sub === "prune") {
        lines.push("");
        lines.push("  Prune Preview (30 days, dry run)");
        lines.push("  " + "─".repeat(52));
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const stale = items.filter(
          (i) =>
            i.category !== "findings" &&
            i.category !== "false_positives" &&
            new Date(i.updated_at).getTime() < cutoff,
        );
        if (stale.length === 0) {
          lines.push("  Nothing to prune.");
        } else {
          lines.push(`  ${stale.length} item(s) would be pruned. Run memory_prune with max_age_days=30.`);
        }
      }

      lines.push("");
      lines.push("  Retrieval: use memory_retrieve / memory_search — never load full memory.");
      lines.push("");
      return lines.join("\n");
    },
  });
}
