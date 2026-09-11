/**
 * corpus-ingestor.ts — Security research corpus ingestion pipeline
 *
 * Scans, sanitizes, normalizes, and indexes the local security research corpus.
 * Detects and isolates sensitive data (credentials, API keys, private keys, tokens).
 * Builds specialized knowledge indexes for RAG retrieval.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SEC_DATA = path.resolve(process.env.PI_SEC_DATA_DIR || ".local/reference-data");
const KNOWLEDGE_INDEXES = path.join(SEC_DATA, "knowledge-indexes");
const CORPUS_SANITIZED = path.join(SEC_DATA, "corpus-sanitized");
const SENSITIVE_DIR = path.join(SEC_DATA, "sensitive");

// Ensure directories exist
function ensureDirs() {
  for (const d of [SEC_DATA, KNOWLEDGE_INDEXES, CORPUS_SANITIZED, SENSITIVE_DIR, path.join(KNOWLEDGE_INDEXES, "normalized")]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// --- Sensitive data patterns ---
const SENSITIVE_PATTERNS: Array<{ name: string; regex: RegExp; severity: string }> = [
  { name: "AWS Access Key", regex: /AKIA[0-9A-Z]{16}/g, severity: "critical" },
  { name: "AWS Secret Key", regex: /aws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi, severity: "critical" },
  { name: "Stripe Live Key", regex: /sk_live_[A-Za-z0-9]{24,}/g, severity: "critical" },
  { name: "Stripe Test Key", regex: /sk_test_[A-Za-z0-9]{24,}/g, severity: "high" },
  { name: "Private Key Block", regex: /-----BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE KEY-----[\s\S]*?-----END\s+(RSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE KEY-----/g, severity: "critical" },
  { name: "JWT Token", regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, severity: "high" },
  { name: "Generic API Key", regex: /(?:api[_-]?key|apikey)\s*[=:]\s*["']?[A-Za-z0-9]{32,}["']?/gi, severity: "high" },
  { name: "Google API Key", regex: /AIza[0-9A-Za-z_-]{35}/g, severity: "high" },
  { name: "MongoDB Connection", regex: /mongodb(\+srv)?:\/\/[^\s"'<>]+/gi, severity: "critical" },
  { name: "PostgreSQL Connection", regex: /postgres(?:ql)?:\/\/[^\s"'<>]+/gi, severity: "critical" },
  { name: "Password Assignment", regex: /(?:password|passwd|pwd)\s*[=:]\s*["'][^"'\s]{6,}["']/gi, severity: "medium" },
  { name: "Bearer Token", regex: /Bearer\s+[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, severity: "high" },
  { name: "Session Cookie", regex: /(?:session|sess|sid|jsessionid|phpsessid)\s*[=:]\s*["']?[A-Za-z0-9+/=]{16,}["']?/gi, severity: "medium" },
  { name: "Private Key Hex", regex: /0x[a-fA-F0-9]{64}/g, severity: "critical" },
  { name: "Mnemonic Seed", regex: /\b(?:abandon|ability|able|about|above|absent|absorb|abstract|absurd|abuse|access|accident)[a-z\s]{200,}/g, severity: "critical" },
];

// --- File type relevance ---
const RELEVANT_EXTENSIONS = [".md", ".txt", ".json", ".js", ".ts", ".py", ".sol", ".sh", ".yml", ".yaml", ".xml", ".html", ".log", ".jsonl", ".har"];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file

// --- Knowledge collections ---
const COLLECTIONS: Record<string, string[]> = {
  "api": ["api", "endpoint", "rest", "graphql", "openapi", "swagger", "route"],
  "auth": ["auth", "login", "session", "oauth", "oidc", "jwt", "token", "password", "mfa"],
  "authorization": ["authorization", "authorisation", "rbac", "role", "permission", "tenant", "idor", "bola", "privilege"],
  "business-logic": ["business", "logic", "workflow", "invariant", "race", "state", "transaction"],
  "cloud": ["aws", "azure", "gcp", "s3", "bucket", "iam", "cloud", "lambda", "serverless"],
  "mobile": ["apk", "android", "ios", "mobile", "react-native", "flutter", "swift", "kotlin"],
  "web": ["xss", "csrf", "cors", "csp", "dom", "frontend", "browser", "cookie"],
  "smart-contract": ["solidity", "evm", "defi", "reentrancy", "oracle", "flash", "contract", "abi"],
  "reverse-engineering": ["decompile", "disassembl", "binary", "firmware", "reverse", "ghidra", "jadx"],
  "dataflow": ["dataflow", "data flow", "trust boundary", "sensitive", "pii", "transformation"],
  "attack-chains": ["chain", "exploit", "pivot", "lateral", "escalat", "combined"],
  "false-positives": ["false positive", "false alarm", "duplicate", "benign", "expected behavior"],
  "validation": ["validation", "poc", "proof of concept", "reproduce", "confirm", "verify"],
  "architecture": ["architecture", "microservice", "infrastructure", "topology", "diagram"],
};

// --- Helpers ---
function walkDir(dir: string, maxDepth: number = 5, depth: number = 0): string[] {
  if (depth > maxDepth) return [];
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath, maxDepth, depth + 1));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (RELEVANT_EXTENSIONS.includes(ext)) {
          const stat = fs.statSync(fullPath);
          if (stat.size <= MAX_FILE_SIZE) {
            results.push(fullPath);
          }
        }
      }
    }
  } catch {
    // permission errors etc
  }
  return results;
}

function classifyCollection(filePath: string, content: string): string[] {
  const lowerPath = filePath.toLowerCase();
  const lowerContent = content.toLowerCase().substring(0, 5000);
  const matched: string[] = [];
  for (const [collection, keywords] of Object.entries(COLLECTIONS)) {
    for (const kw of keywords) {
      if (lowerPath.includes(kw) || lowerContent.includes(kw)) {
        matched.push(collection);
        break;
      }
    }
  }
  return matched.length > 0 ? matched : ["general"];
}

function sanitizeContent(content: string): { sanitized: string; findings: Array<{ name: string; severity: string; count: number }> } {
  let sanitized = content;
  const findings: Array<{ name: string; severity: string; count: number }> = [];
  for (const { name, regex, severity } of SENSITIVE_PATTERNS) {
    const matches = content.match(regex);
    if (matches && matches.length > 0) {
      findings.push({ name, severity, count: matches.length });
      sanitized = sanitized.replace(regex, `[REDACTED:${name}]`);
    }
  }
  return { sanitized, findings };
}

function normalizeFile(filePath: string, content: string): { vuln_class?: string; root_cause?: string; prerequisites?: string[]; impact?: string; remediation?: string; false_positive_indicators?: string[] } {
  const lower = content.toLowerCase();
  const result: any = {};

  // Extract vulnerability class
  const vulnClasses = ["idor", "bola", "ssrf", "xss", "sqli", "sql injection", "csrf", "rce", "lfi", "rfi", "reentrancy", "authentication bypass", "authorization bypass", "privilege escalation", "mass assignment", "race condition", "open redirect", "information disclosure", "insecure deserialization"];
  for (const vc of vulnClasses) {
    if (lower.includes(vc)) { result.vuln_class = vc; break; }
  }

  // Extract root cause
  const rootCausePatterns = [/root cause[:\s]+([^\n.]+)/i, /caused by[:\s]+([^\n.]+)/i, /the (?:vulnerability|issue|bug) (?:is|was|occurs) (?:due to|because|when)[:\s]+([^\n.]+)/i];
  for (const pattern of rootCausePatterns) {
    const match = content.match(pattern);
    if (match) { result.root_cause = match[1].trim(); break; }
  }

  // Extract prerequisites
  const prereqMatch = content.match(/(?:prerequisite|requires?|precondition)[:\s]+([^\n.]+)/i);
  if (prereqMatch) result.prerequisites = [prereqMatch[1].trim()];

  // Extract impact
  const impactMatch = content.match(/(?:impact|severity|consequence)[:\s]+([^\n.]+)/i);
  if (impactMatch) result.impact = impactMatch[1].trim();

  // Extract remediation
  const remediationMatch = content.match(/(?:remediation|fix|mitigation|solution)[:\s]+([^\n.]+)/i);
  if (remediationMatch) result.remediation = remediationMatch[1].trim();

  // False positive indicators
  if (lower.includes("false positive") || lower.includes("benign") || lower.includes("expected behavior")) {
    result.false_positive_indicators = ["mentioned in document"];
  }

  return result;
}

function loadCatalog(): any {
  const catPath = path.join(KNOWLEDGE_INDEXES, "catalog.json");
  if (fs.existsSync(catPath)) {
    try { return JSON.parse(fs.readFileSync(catPath, "utf8")); } catch { return { files: [], stats: {} }; }
  }
  return { files: [], stats: {} };
}

function saveCatalog(cat: any) {
  fs.writeFileSync(path.join(KNOWLEDGE_INDEXES, "catalog.json"), JSON.stringify(cat, null, 2), "utf8");
}

// --- Extension ---
export default function (pi: ExtensionAPI) {
  ensureDirs();

  // 1. corpus_scan — scan a directory and catalog files
  pi.registerTool({
    name: "corpus_scan",
    description: "Scan a directory and catalog all security-relevant files. Returns file count by type, total size, directory structure.",
    parameters: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory to scan (default: ~/Documents/knowledge)" },
        max_depth: { type: "number", description: "Max directory depth (default: 5)" },
      },
      required: [],
    },
    execute: async (params: any) => {
      const dir = params.directory?.replace(/^~/, os.homedir()) || path.join(os.homedir(), "Documents", "knowledge");
      const maxDepth = params.max_depth || 5;

      if (!fs.existsSync(dir)) {
        return { content: JSON.stringify({ error: `Directory not found: ${dir}` }) };
      }

      const files = walkDir(dir, maxDepth);
      const byExt: Record<string, number> = {};
      const byDir: Record<string, number> = {};
      let totalSize = 0;

      for (const f of files) {
        const ext = path.extname(f).toLowerCase() || "(no ext)";
        byExt[ext] = (byExt[ext] || 0) + 1;
        const parentDir = path.dirname(f).replace(dir + "/", "").split("/")[0] || ".";
        byDir[parentDir] = (byDir[parentDir] || 0) + 1;
        try { totalSize += fs.statSync(f).size; } catch {}
      }

      const catalog = loadCatalog();
      catalog.last_scan = { directory: dir, timestamp: Date.now(), file_count: files.length, total_size: totalSize, by_extension: byExt, by_directory: byDir };
      saveCatalog(catalog);

      return {
        content: JSON.stringify({
          directory: dir,
          total_files: files.length,
          total_size_mb: Math.round(totalSize / 1024 / 1024),
          by_extension: byExt,
          by_directory: byDir,
          catalog_path: path.join(KNOWLEDGE_INDEXES, "catalog.json"),
        }, null, 2),
      };
    },
  });

  // 2. corpus_sanitize — detect and isolate sensitive data
  pi.registerTool({
    name: "corpus_sanitize",
    description: "Scan corpus for sensitive data (API keys, private keys, JWT tokens, credentials). Quarantines sensitive files and creates sanitized copies.",
    parameters: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory to sanitize (default: ~/Documents/knowledge)" },
        max_files: { type: "number", description: "Max files to process (default: 500)" },
        dry_run: { type: "boolean", description: "If true, only report findings without quarantining (default: false)" },
      },
      required: [],
    },
    execute: async (params: any) => {
      const dir = params.directory?.replace(/^~/, os.homedir()) || path.join(os.homedir(), "Documents", "knowledge");
      const maxFiles = params.max_files || 500;
      const dryRun = params.dry_run || false;

      const files = walkDir(dir, 5).slice(0, maxFiles);
      let scannedCount = 0;
      let sensitiveCount = 0;
      let totalFindings = 0;
      const allFindings: Array<{ file: string; patterns: any[] }> = [];

      for (const file of files) {
        try {
          const content = fs.readFileSync(file, "utf8");
          scannedCount++;
          const { sanitized, findings } = sanitizeContent(content);

          if (findings.length > 0) {
            sensitiveCount++;
            totalFindings += findings.reduce((sum, f) => sum + f.count, 0);
            allFindings.push({ file: file.replace(dir + "/", ""), patterns: findings });

            if (!dryRun) {
              // Quarantine the original
              const relPath = path.relative(dir, file);
              const quarantinePath = path.join(SENSITIVE_DIR, relPath);
              fs.mkdirSync(path.dirname(quarantinePath), { recursive: true });
              fs.copyFileSync(file, quarantinePath);

              // Write sanitized copy
              const sanitizedPath = path.join(CORPUS_SANITIZED, relPath);
              fs.mkdirSync(path.dirname(sanitizedPath), { recursive: true });
              fs.writeFileSync(sanitizedPath, sanitized, "utf8");
            }
          } else if (!dryRun) {
            // Copy clean file to sanitized dir
            const relPath = path.relative(dir, file);
            const sanitizedPath = path.join(CORPUS_SANITIZED, relPath);
            fs.mkdirSync(path.dirname(sanitizedPath), { recursive: true });
            fs.copyFileSync(file, sanitizedPath);
          }
        } catch {}
      }

      const report = {
        directory: dir,
        files_scanned: scannedCount,
        files_with_sensitive_data: sensitiveCount,
        total_sensitive_findings: totalFindings,
        dry_run: dryRun,
        findings: allFindings.slice(0, 50),
        quarantine_dir: SENSITIVE_DIR,
        sanitized_dir: CORPUS_SANITIZED,
      };

      fs.writeFileSync(path.join(SEC_DATA, "sanitization-report.json"), JSON.stringify(report, null, 2), "utf8");

      return { content: JSON.stringify(report, null, 2) };
    },
  });

  // 3. corpus_normalize — extract structured security knowledge
  pi.registerTool({
    name: "corpus_normalize",
    description: "Extract structured security knowledge from sanitized corpus files. Extracts vulnerability class, root cause, prerequisites, impact, remediation.",
    parameters: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory to normalize (default: ~/.pi/agent/sec-data/corpus-sanitized)" },
        max_files: { type: "number", description: "Max files to process (default: 500)" },
      },
      required: [],
    },
    execute: async (params: any) => {
      const dir = params.directory?.replace(/^~/, os.homedir()) || CORPUS_SANITIZED;
      const maxFiles = params.max_files || 500;

      if (!fs.existsSync(dir)) {
        return { content: JSON.stringify({ error: "Run corpus_sanitize first. Sanitized directory not found." }) };
      }

      const files = walkDir(dir, 5).slice(0, maxFiles);
      const normalized: any[] = [];
      const normDir = path.join(KNOWLEDGE_INDEXES, "normalized");
      fs.mkdirSync(normDir, { recursive: true });

      for (const file of files) {
        try {
          const content = fs.readFileSync(file, "utf8");
          const extracted = normalizeFile(file, content);
          if (Object.keys(extracted).length > 0) {
            const entry = {
              id: `N-${String(normalized.length + 1).padStart(4, "0")}`,
              source_file: file.replace(dir + "/", ""),
              collections: classifyCollection(file, content),
              ...extracted,
              content_preview: content.substring(0, 500),
            };
            normalized.push(entry);
          }
        } catch {}
      }

      const outputPath = path.join(normDir, "normalized.json");
      fs.writeFileSync(outputPath, JSON.stringify({ count: normalized.length, items: normalized }, null, 2), "utf8");

      return {
        content: JSON.stringify({
          files_processed: files.length,
          normalized_items: normalized.length,
          output: outputPath,
          by_vuln_class: normalized.reduce((acc: any, n: any) => {
            if (n.vuln_class) { acc[n.vuln_class] = (acc[n.vuln_class] || 0) + 1; }
            return acc;
          }, {}),
        }, null, 2),
      };
    },
  });

  // 4. corpus_index — build specialized knowledge indexes
  pi.registerTool({
    name: "corpus_index",
    description: "Build specialized knowledge indexes from normalized corpus. Creates collections: /api, /auth, /authorization, /business-logic, /cloud, /mobile, /web, /smart-contract, etc.",
    parameters: {
      type: "object",
      properties: {
        rebuild: { type: "boolean", description: "If true, rebuild all indexes from scratch (default: false)" },
      },
      required: [],
    },
    execute: async (params: any) => {
      const normPath = path.join(KNOWLEDGE_INDEXES, "normalized", "normalized.json");
      if (!fs.existsSync(normPath)) {
        return { content: JSON.stringify({ error: "Run corpus_normalize first. No normalized data found." }) };
      }

      const normData = JSON.parse(fs.readFileSync(normPath, "utf8"));
      const indexes: Record<string, any[]> = {};

      // Initialize all collections
      for (const coll of Object.keys(COLLECTIONS)) {
        indexes[coll] = [];
      }
      indexes["general"] = [];

      // Index each normalized item
      for (const item of normData.items) {
        for (const coll of item.collections || ["general"]) {
          if (!indexes[coll]) indexes[coll] = [];
          indexes[coll].push({
            id: item.id,
            source_file: item.source_file,
            vuln_class: item.vuln_class,
            root_cause: item.root_cause,
            impact: item.impact,
            remediation: item.remediation,
            content_preview: item.content_preview,
          });
        }
      }

      // Write each index
      const indexDir = KNOWLEDGE_INDEXES;
      const summary: Record<string, number> = {};
      for (const [coll, items] of Object.entries(indexes)) {
        const indexPath = path.join(indexDir, `${coll}.json`);
        fs.writeFileSync(indexPath, JSON.stringify({ collection: coll, count: items.length, items }, null, 2), "utf8");
        summary[coll] = items.length;
      }

      return {
        content: JSON.stringify({
          indexes_built: Object.keys(indexes).length,
          by_collection: summary,
          total_items: Object.values(summary).reduce((a: number, b: number) => a + b, 0),
          index_dir: indexDir,
        }, null, 2),
      };
    },
  });

  // 5. /corpus command
  pi.registerCommand("corpus", {
    description: "Show corpus ingestion status, index sizes, and run commands. Usage: /corpus [scan|sanitize|normalize|index]",
    handler: async (args: string) => {
      const cat = loadCatalog();
      const lastScan = cat.last_scan;

      if (!args.trim()) {
        const lines: string[] = ["", "Corpus Ingestion Status:", ""];

        if (lastScan) {
          lines.push(`  Last scan: ${lastScan.directory}`);
          lines.push(`  Files: ${lastScan.file_count}`);
          lines.push(`  Size: ${Math.round(lastScan.total_size / 1024 / 1024)} MB`);
        } else {
          lines.push("  No scan yet. Run: /corpus scan");
        }

        // Check indexes
        const indexFiles = fs.existsSync(KNOWLEDGE_INDEXES)
          ? fs.readdirSync(KNOWLEDGE_INDEXES).filter(f => f.endsWith(".json") && f !== "catalog.json")
          : [];
        lines.push("", "  Indexes:");
        for (const idx of indexFiles) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(KNOWLEDGE_INDEXES, idx), "utf8"));
            lines.push(`    ${idx}: ${data.count || 0} items`);
          } catch {}
        }

        // Check sanitization
        const sanReport = path.join(SEC_DATA, "sanitization-report.json");
        if (fs.existsSync(sanReport)) {
          const report = JSON.parse(fs.readFileSync(sanReport, "utf8"));
          lines.push("", `  Sanitization: ${report.files_with_sensitive_data} files with sensitive data`);
        }

        lines.push("", "  Commands: /corpus scan, /corpus sanitize, /corpus normalize, /corpus index", "");
        return lines.join("\n");
      }

      const cmd = args.trim().split(/\s+/)[0];
      if (cmd === "scan") {
        return "Run: corpus_scan tool with directory parameter";
      } else if (cmd === "sanitize") {
        return "Run: corpus_sanitize tool to detect and isolate sensitive data";
      } else if (cmd === "normalize") {
        return "Run: corpus_normalize tool to extract structured knowledge";
      } else if (cmd === "index") {
        return "Run: corpus_index tool to build specialized indexes";
      }

      return "Usage: /corpus [scan|sanitize|normalize|index]";
    },
  });
}
