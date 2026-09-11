/**
 * security-rag.ts — Security research retrieval-augmented generation
 *
 * Provides retrieval over the indexed security knowledge corpus.
 * Supports keyword matching + simple TF-IDF scoring.
 * Every result includes provenance: source file, collection, confidence.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SEC_DATA = path.resolve(process.env.PI_SEC_DATA_DIR || ".local/reference-data");
const KNOWLEDGE_INDEXES = path.join(SEC_DATA, "knowledge-indexes");
const PATTERNS_DIR = path.join(SEC_DATA, "patterns");
const FALSE_POSITIVES_DIR = path.join(SEC_DATA, "false-positives");
const BENCHMARK_DIR = path.join(SEC_DATA, "benchmark");

// --- TF-IDF helpers ---
function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2)
    .filter(t => !["the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her", "was", "one", "our", "out", "has", "have", "from", "this", "that", "with", "will", "your", "they", "been", "them", "were", "what", "about", "which", "when", "would", "there", "their", "each", "make", "like", "does", "into", "over", "more", "some", "than", "only", "very", "also"].includes(t));
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }
  return tf;
}

function scoreDocument(queryTokens: string[], docText: string): number {
  const docTokens = tokenize(docText);
  const docTf = termFrequency(docTokens);
  const queryTf = termFrequency(queryTokens);
  let score = 0;
  for (const [term, qFreq] of queryTf) {
    const dFreq = docTf.get(term) || 0;
    if (dFreq > 0) {
      score += qFreq * (1 + Math.log(dFreq));
    }
  }
  return score / Math.max(docTokens.length, 1) * 100;
}

function loadCollection(name: string): any[] {
  const indexPath = path.join(KNOWLEDGE_INDEXES, `${name}.json`);
  if (!fs.existsSync(indexPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    return data.items || [];
  } catch { return []; }
}

function loadAllCollections(): Map<string, any[]> {
  const result = new Map<string, any[]>();
  if (!fs.existsSync(KNOWLEDGE_INDEXES)) return result;
  for (const file of fs.readdirSync(KNOWLEDGE_INDEXES)) {
    if (file.endsWith(".json") && file !== "catalog.json") {
      const name = path.basename(file, ".json");
      result.set(name, loadCollection(name));
    }
  }
  return result;
}

// --- Extension ---
export default function (pi: ExtensionAPI) {
  // 1. sec_rag_query — Query the security knowledge base
  pi.registerTool({
    name: "sec_rag_query",
    description: "Query the security knowledge base using keyword matching + TF-IDF scoring. Returns matching documents with source, confidence, and relevance score.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language query" },
        collection: {
          type: "string",
          description: "Optional collection: api, auth, authorization, business-logic, cloud, mobile, web, smart-contract, reverse-engineering, dataflow, attack-chains, false-positives, validation, architecture",
        },
        limit: { type: "number", description: "Max results (default: 5)" },
      },
      required: ["query"],
    },
    execute: async (params: any) => {
      const query = params.query;
      const limit = params.limit || 5;
      const collection = params.collection;

      const queryTokens = tokenize(query);
      const collections = collection ? new Map([[collection, loadCollection(collection)]]) : loadAllCollections();

      const results: Array<{ source: string; collection: string; score: number; confidence: number; vuln_class?: string; root_cause?: string; impact?: string; remediation?: string; content_preview?: string }> = [];

      for (const [collName, items] of collections) {
        for (const item of items) {
          const docText = `${item.content_preview || ""} ${item.vuln_class || ""} ${item.root_cause || ""} ${item.impact || ""} ${item.remediation || ""}`;
          const score = scoreDocument(queryTokens, docText);
          if (score > 0) {
            results.push({
              source: item.source_file || "unknown",
              collection: collName,
              score: Math.round(score * 100) / 100,
              confidence: Math.min(score / 10, 1),
              vuln_class: item.vuln_class,
              root_cause: item.root_cause,
              impact: item.impact,
              remediation: item.remediation,
              content_preview: item.content_preview,
            });
          }
        }
      }

      results.sort((a, b) => b.score - a.score);
      const top = results.slice(0, limit);

      return {
        content: JSON.stringify({
          query,
          total_matches: results.length,
          returned: top.length,
          results: top,
        }, null, 2),
      };
    },
  });

  // 2. sec_rag_pattern_search — Search the pattern library
  pi.registerTool({
    name: "sec_rag_pattern_search",
    description: "Search the vulnerability pattern library. Patterns represent: architecture → invariant → weakness → signal → validation → impact.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        vuln_class: { type: "string", description: "Filter by vulnerability class (e.g. idor, ssrf, xss)" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
    execute: async (params: any) => {
      const patternsPath = path.join(PATTERNS_DIR, "patterns.json");
      if (!fs.existsSync(patternsPath)) {
        return { content: JSON.stringify({ error: "No patterns found. Run pattern_add or pattern_library init first." }) };
      }
      const patterns = JSON.parse(fs.readFileSync(patternsPath, "utf8"));
      let results = patterns.patterns || [];

      if (params.vuln_class) {
        results = results.filter((p: any) => p.vuln_class === params.vuln_class);
      }

      const queryTokens = tokenize(params.query);
      results = results.map((p: any) => ({
        ...p,
        score: scoreDocument(queryTokens, JSON.stringify(p)),
      })).filter((p: any) => p.score > 0)
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, params.limit || 10);

      return { content: JSON.stringify({ query: params.query, results }, null, 2) };
    },
  });

  // 3. sec_rag_false_positive_check — Check if hypothesis matches known false positives
  pi.registerTool({
    name: "sec_rag_false_positive_check",
    description: "Check if a hypothesis matches known false positives. Returns match count, false positive rate, similar cases, and recommendation.",
    parameters: {
      type: "object",
      properties: {
        hypothesis_title: { type: "string", description: "Hypothesis title" },
        evidence: { type: "string", description: "Evidence description" },
      },
      required: ["hypothesis_title"],
    },
    execute: async (params: any) => {
      if (!fs.existsSync(FALSE_POSITIVES_DIR)) {
        fs.mkdirSync(FALSE_POSITIVES_DIR, { recursive: true });
      }

      const fpFiles = fs.readdirSync(FALSE_POSITIVES_DIR).filter(f => f.endsWith(".json"));
      const queryTokens = tokenize(`${params.hypothesis_title} ${params.evidence || ""}`);
      const matches: any[] = [];

      for (const file of fpFiles) {
        try {
          const fp = JSON.parse(fs.readFileSync(path.join(FALSE_POSITIVES_DIR, file), "utf8"));
          const score = scoreDocument(queryTokens, JSON.stringify(fp));
          if (score > 0) {
            matches.push({ file, score, ...fp });
          }
        } catch {}
      }

      matches.sort((a, b) => b.score - a.score);
      const fpCount = matches.filter((m: any) => m.outcome === "false_positive").length;
      const totalCount = matches.length;
      const fpRate = totalCount > 0 ? fpCount / totalCount : 0;

      let recommendation = "No historical matches. Proceed with normal investigation.";
      if (fpRate > 0.7) {
        recommendation = `WARNING: ${(fpRate * 100).toFixed(0)}% of similar cases were false positives. Apply extra scrutiny.`;
      } else if (fpRate > 0.4) {
        recommendation = `CAUTION: ${(fpRate * 100).toFixed(0)}% false positive rate for similar cases. Investigate carefully.`;
      } else if (totalCount > 0) {
        recommendation = `${fpCount}/${totalCount} similar cases were false positives. Normal confidence applies.`;
      }

      return {
        content: JSON.stringify({
          hypothesis: params.hypothesis_title,
          similar_cases_found: totalCount,
          false_positive_count: fpCount,
          false_positive_rate: Math.round(fpRate * 100) / 100,
          recommendation,
          similar_cases: matches.slice(0, 5),
        }, null, 2),
      };
    },
  });

  // 4. sec_rag_benchmark_lookup — Find similar historical cases
  pi.registerTool({
    name: "sec_rag_benchmark_lookup",
    description: "Find similar historical cases from the benchmark. Benchmark is isolated from live agent memory.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default: 3)" },
      },
      required: ["query"],
    },
    execute: async (params: any) => {
      const casesPath = path.join(BENCHMARK_DIR, "cases.json");
      if (!fs.existsSync(casesPath)) {
        return { content: JSON.stringify({ error: "No benchmark cases found. Use eval_benchmark_add to add cases." }) };
      }
      const data = JSON.parse(fs.readFileSync(casesPath, "utf8"));
      const cases = data.cases || [];

      const queryTokens = tokenize(params.query);
      const matches = cases.map((c: any) => ({
        ...c,
        score: scoreDocument(queryTokens, JSON.stringify(c)),
      })).filter((c: any) => c.score > 0)
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, params.limit || 3);

      return {
        content: JSON.stringify({
          query: params.query,
          total_cases: cases.length,
          matches: matches.length,
          results: matches,
        }, null, 2),
      };
    },
  });

  // 5. /rag command
  pi.registerCommand("rag", {
    description: "Show index status, collection sizes, and query the knowledge base. Usage: /rag [query]",
    handler: async (args: string) => {
      if (!args.trim()) {
        const lines: string[] = ["", "Security RAG Status:", ""];

        if (!fs.existsSync(KNOWLEDGE_INDEXES)) {
          lines.push("  No indexes found. Run: /corpus scan → /corpus sanitize → /corpus normalize → /corpus index");
          return lines.join("\n");
        }

        const indexFiles = fs.readdirSync(KNOWLEDGE_INDEXES).filter(f => f.endsWith(".json") && f !== "catalog.json");
        let totalItems = 0;
        for (const file of indexFiles) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(KNOWLEDGE_INDEXES, file), "utf8"));
            const count = data.count || (data.items || []).length;
            totalItems += count;
            lines.push(`  ${path.basename(file, ".json")}: ${count} items`);
          } catch {}
        }
        lines.push("", `  Total: ${totalItems} indexed items`, "");

        // Pattern library
        const patternsPath = path.join(PATTERNS_DIR, "patterns.json");
        if (fs.existsSync(patternsPath)) {
          const patterns = JSON.parse(fs.readFileSync(patternsPath, "utf8"));
          lines.push(`  Patterns: ${patterns.patterns?.length || 0} vulnerability patterns`);
        }

        // False positives
        if (fs.existsSync(FALSE_POSITIVES_DIR)) {
          const fpCount = fs.readdirSync(FALSE_POSITIVES_DIR).filter(f => f.endsWith(".json")).length;
          lines.push(`  False positives: ${fpCount} recorded`);
        }

        // Benchmark
        const casesPath = path.join(BENCHMARK_DIR, "cases.json");
        if (fs.existsSync(casesPath)) {
          const data = JSON.parse(fs.readFileSync(casesPath, "utf8"));
          lines.push(`  Benchmark cases: ${data.cases?.length || 0}`);
        }

        lines.push("", "  Usage: /rag <query> to search", "");
        return lines.join("\n");
      }

      // Treat args as a query
      return `Use sec_rag_query tool with query: "${args.trim()}"`;
    },
  });
}
