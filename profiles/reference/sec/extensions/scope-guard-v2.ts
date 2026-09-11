/**
 * Scope Guard v2 — enhanced scope enforcement for pi-sec
 *
 * Reads scope from ~/.pi/agent/sec-data/scope.yaml (simplified YAML, parsed manually).
 * Supports: targets, allowed_domains, excluded lists.
 *
 * Tools:
 *   scope_check     — verify a target is in-scope (IPs, domains, CIDR, wildcards)
 *   scope_violation — report a scope violation (persisted to scope-violations.json)
 *
 * Command:
 *   /scope          — show current scope
 *   /scope set ...  — set targets inline
 *   /scope violations — show violation log
 *
 * Enforcement:
 *   When a scope violation is reported, a scope.violation event is published
 *   via pi.emit and the agent should STOP all activity on that target.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Paths ───────────────────────────────────────────────────────────────────

const DATA_DIR       = path.resolve(process.env.PI_SEC_DATA_DIR || ".local/reference-data");
const SCOPE_FILE     = path.join(DATA_DIR, "scope.yaml");
const VIOLATIONS_FILE = path.join(DATA_DIR, "scope-violations.json");

// ─── Types ───────────────────────────────────────────────────────────────────

interface ScopeConfig {
  targets: string[];        // explicitly authorized targets (domains, IPs, CIDRs, wildcards)
  allowed_domains: string[]; // domain-level allow (includes subdomains)
  excluded: string[];        // explicitly excluded targets — overrides all allow rules
  enforce: boolean;           // if true, out-of-scope = stop
}

interface ScopeViolation {
  id: string;
  timestamp: string;
  target: string;
  reason: string;
  context?: string;
  agent?: string;
}

interface ViolationLog {
  violations: ScopeViolation[];
}

// ─── YAML Parser (simplified — no js-yaml dependency) ───────────────────────

/**
 * Parse a simplified YAML scope file:
 *   ---
 *   targets:
 *     - example.com
 *     - api.example.com
 *   allowed_domains:
 *     - example.com
 *   excluded:
 *     - payments.example.com
 *
 * Handles: section headers (word:), list items (- value), comments (#),
 * inline values (key: value), and document markers (---).
 */
function parseScopeYaml(text: string): ScopeConfig {
  const config: ScopeConfig = {
    targets: [],
    allowed_domains: [],
    excluded: [],
    enforce: true,
  };

  const lines = text.split("\n");
  let currentSection: keyof ScopeConfig | null = null;

  for (const rawLine of lines) {
    // Strip trailing whitespace
    const line = rawLine.trimEnd();

    // Skip empty lines and YAML document markers
    if (!line.trim() || line.trim() === "---" || line.trim() === "...") continue;

    // Skip comments
    if (line.trim().startsWith("#")) continue;

    // List item: "  - value"
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch) {
      const value = listMatch[1].trim();
      // Strip inline comments and quotes
      const cleaned = stripValue(value);
      if (currentSection && (currentSection === "targets" || currentSection === "allowed_domains" || currentSection === "excluded")) {
        (config[currentSection] as string[]).push(cleaned);
      }
      continue;
    }

    // Inline key: value (e.g. "enforce: false")
    const inlineMatch = line.match(/^(\w+):\s*(.+)$/);
    if (inlineMatch && !line.startsWith(" ")) {
      const key = inlineMatch[1];
      const value = stripValue(inlineMatch[2]);
      if (key === "enforce") {
        config.enforce = value === "true" || value === "yes";
      }
      currentSection = null;
      continue;
    }

    // Section header: "targets:" (no value, starts a list)
    const sectionMatch = line.match(/^(\w+):\s*$/);
    if (sectionMatch && !line.startsWith(" ")) {
      const key = sectionMatch[1];
      if (key === "targets" || key === "allowed_domains" || key === "excluded") {
        currentSection = key as keyof ScopeConfig;
      } else {
        currentSection = null;
      }
      continue;
    }
  }

  return config;
}

/** Strip quotes and inline comments from a YAML value */
function stripValue(raw: string): string {
  let value = raw;
  // Remove inline comment (but not # inside quotes)
  if (!value.startsWith('"') && !value.startsWith("'")) {
    const hashIdx = value.indexOf(" #");
    if (hashIdx !== -1) value = value.substring(0, hashIdx);
  }
  value = value.trim();
  // Remove surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

// ─── Scope Loading ───────────────────────────────────────────────────────────

function loadScope(): ScopeConfig {
  try {
    if (!fs.existsSync(SCOPE_FILE)) {
      // Fall back to profile.json scope if scope.yaml doesn't exist
      const profilePath = path.join(os.homedir(), ".pi", "agent", "profiles", "sec", "profile.json");
      if (fs.existsSync(profilePath)) {
        const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
        const scope = profile.scope ?? {};
        return {
          targets: scope.targets ?? [],
          allowed_domains: scope.allowed_domains ?? scope.targets ?? [],
          excluded: scope.excluded ?? [],
          enforce: scope.enforce ?? true,
        };
      }
      return { targets: [], allowed_domains: [], excluded: [], enforce: true };
    }
    const text = fs.readFileSync(SCOPE_FILE, "utf8");
    return parseScopeYaml(text);
  } catch {
    return { targets: [], allowed_domains: [], excluded: [], enforce: true };
  }
}

function saveScopeYaml(config: ScopeConfig): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const lines: string[] = ["---"];
  lines.push("targets:");
  for (const t of config.targets) lines.push(`  - ${t}`);
  lines.push("allowed_domains:");
  for (const d of config.allowed_domains) lines.push(`  - ${d}`);
  lines.push("excluded:");
  for (const e of config.excluded) lines.push(`  - ${e}`);
  lines.push(`enforce: ${config.enforce}`);
  fs.writeFileSync(SCOPE_FILE, lines.join("\n"), "utf8");
}

// ─── Violation Persistence ───────────────────────────────────────────────────

function loadViolations(): ViolationLog {
  try {
    if (!fs.existsSync(VIOLATIONS_FILE)) return { violations: [] };
    return JSON.parse(fs.readFileSync(VIOLATIONS_FILE, "utf8"));
  } catch {
    return { violations: [] };
  }
}

function saveViolations(log: ViolationLog): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(VIOLATIONS_FILE, JSON.stringify(log, null, 2), "utf8");
}

function recordViolation(violation: ScopeViolation): void {
  const log = loadViolations();
  log.violations.push(violation);
  saveViolations(log);
}

// ─── Target Matching ─────────────────────────────────────────────────────────

/** Check if a value is an IPv4 address */
function isIPv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every(p => {
    const n = parseInt(p, 10);
    return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p;
  });
}

/** Convert IPv4 string to 32-bit integer */
function ipToInt(ip: string): number {
  const parts = ip.split(".").map(p => parseInt(p, 10));
  return (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/** Check if a value is a CIDR notation (e.g. 10.0.0.0/24) */
function isCIDR(value: string): boolean {
  const match = value.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (!match) return false;
  const bits = parseInt(match[2], 10);
  return bits >= 0 && bits <= 32;
}

/** Check if an IP falls within a CIDR range */
function ipInCIDR(ip: string, cidr: string): boolean {
  if (!isIPv4(ip)) return false;
  const [network, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  const ipInt = ipToInt(ip);
  const netInt = ipToInt(network);
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xFFFFFFFF : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

/** Check if target is a wildcard domain (*.example.com) */
function isWildcard(pattern: string): boolean {
  return pattern.startsWith("*.");
}

/** Check if a hostname matches a domain or wildcard pattern (includes subdomains) */
function domainMatches(hostname: string, pattern: string): boolean {
  // Normalize — strip protocol, port, path
  const target = normalizeTarget(hostname);
  const pat = pattern.toLowerCase().trim();

  // Wildcard match: *.example.com matches example.com and anything.example.com
  if (isWildcard(pat)) {
    const base = pat.slice(2);
    return target === base || target.endsWith("." + base);
  }

  // Exact match or subdomain match
  return target === pat || target.endsWith("." + pat);
}

/** Strip protocol, port, path from a target string to get the bare hostname/IP */
function normalizeTarget(target: string): string {
  let t = target.trim().toLowerCase();

  // Strip protocol
  t = t.replace(/^https?:\/\//, "");
  t = t.replace(/^ftp:\/\//, "");
  t = t.replace(/^ftps:\/\//, "");

  // Strip path
  const slashIdx = t.indexOf("/");
  if (slashIdx !== -1) t = t.substring(0, slashIdx);

  // Strip port (but not for IPv6 — we don't fully support IPv6 yet)
  if (!t.startsWith("[")) {
    const colonIdx = t.lastIndexOf(":");
    if (colonIdx !== -1 && !t.includes(":")) {
      // single colon = port separator
    } else if (colonIdx !== -1) {
      // check if it's a port
      const afterColon = t.substring(colonIdx + 1);
      if (/^\d+$/.test(afterColon)) {
        t = t.substring(0, colonIdx);
      }
    }
  }

  return t;
}

/**
 * Check if a target is in scope.
 * A target is in-scope if:
 *   1. It is NOT in the excluded list (exclusion takes priority)
 *   2. It matches a target entry (exact, CIDR, wildcard, or subdomain)
 *   3. OR its domain matches an allowed_domains entry
 */
function checkScope(target: string, config: ScopeConfig): {
  authorized: boolean;
  matchedRule: string | null;
  excluded: boolean;
  excludeRule: string | null;
} {
  const normalized = normalizeTarget(target);

  // 1. Check exclusions first — they override everything
  for (const excluded of config.excluded) {
    if (matchesAny(normalized, excluded)) {
      return {
        authorized: false,
        matchedRule: null,
        excluded: true,
        excludeRule: excluded,
      };
    }
  }

  // 2. Check targets (highest priority allow list)
  for (const allowed of config.targets) {
    if (matchesAny(normalized, allowed)) {
      return {
        authorized: true,
        matchedRule: `target: ${allowed}`,
        excluded: false,
        excludeRule: null,
      };
    }
  }

  // 3. Check allowed_domains
  for (const domain of config.allowed_domains) {
    if (domainMatches(normalized, domain)) {
      return {
        authorized: true,
        matchedRule: `allowed_domain: ${domain}`,
        excluded: false,
        excludeRule: null,
      };
    }
  }

  // 4. Not in scope
  return {
    authorized: false,
    matchedRule: null,
    excluded: false,
    excludeRule: null,
  };
}

/** Check if a normalized target matches a rule (IP, CIDR, wildcard, domain) */
function matchesAny(target: string, rule: string): boolean {
  const r = rule.toLowerCase().trim();

  // CIDR match
  if (isCIDR(r)) {
    return ipInCIDR(target, r);
  }

  // Exact IP match
  if (isIPv4(r) && isIPv4(target)) {
    return target === r;
  }

  // Wildcard domain match
  if (isWildcard(r)) {
    return domainMatches(target, r);
  }

  // Domain or subdomain match
  return domainMatches(target, r);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateViolationId(): string {
  return `vio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatScope(config: ScopeConfig): string {
  const lines: string[] = ["", "Scope Configuration:", ""];
  lines.push(`  Enforce: ${config.enforce ? "YES (violations will halt activity)" : "NO (advisory mode)"}`);
  lines.push("");
  lines.push(`  Targets (${config.targets.length}):`);
  if (config.targets.length) {
    for (const t of config.targets) lines.push(`    • ${t}`);
  } else {
    lines.push("    (none)");
  }
  lines.push("");
  lines.push(`  Allowed Domains (${config.allowed_domains.length}):`);
  if (config.allowed_domains.length) {
    for (const d of config.allowed_domains) lines.push(`    • ${d}`);
  } else {
    lines.push("    (none)");
  }
  lines.push("");
  lines.push(`  Excluded (${config.excluded.length}):`);
  if (config.excluded.length) {
    for (const e of config.excluded) lines.push(`    • ${e}  [override-all]`);
  } else {
    lines.push("    (none)");
  }
  lines.push("");
  lines.push(`  Scope file: ${SCOPE_FILE}`);
  lines.push("");
  return lines.join("\n");
}

function formatViolations(log: ViolationLog): string {
  if (!log.violations.length) {
    return "No scope violations recorded.";
  }
  const lines: string[] = ["", `Scope Violations (${log.violations.length}):`, ""];
  for (const v of log.violations) {
    lines.push(`  [${v.timestamp}] ${v.target}`);
    lines.push(`    reason:  ${v.reason}`);
    if (v.context) lines.push(`    context: ${v.context}`);
    if (v.agent) lines.push(`    agent:   ${v.agent}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Extension Registration ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── scope_check tool ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "scope_check",
    description:
      "Check if a target is within the authorized testing scope. Supports IPs, domains, CIDR ranges, and wildcard patterns. " +
      "Always call this before any active testing on a target. Returns authorized status, matched rule, and exclusion info.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "IP address, hostname, domain, or URL to check against authorized scope",
        },
      },
      required: ["target"],
    },
    execute: async (params: any) => {
      const config = loadScope();
      const result = checkScope(params.target, config);

      let status: string;
      if (result.excluded) {
        status = "EXCLUDED — this target is explicitly excluded from scope";
      } else if (result.authorized) {
        status = "AUTHORIZED — target is in scope";
      } else {
        status = "OUT OF SCOPE — target does not match any authorized entry";
      }

      const response = {
        target: params.target,
        normalized: normalizeTarget(params.target),
        authorized: result.authorized,
        excluded: result.excluded,
        matchedRule: result.matchedRule,
        excludeRule: result.excludeRule,
        enforce: config.enforce,
        status,
      };

      return { content: JSON.stringify(response, null, 2) };
    },
  });

  // ── scope_violation tool ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "scope_violation",
    description:
      "Report a scope violation. Stores the violation to ~/.pi/agent/sec-data/scope-violations.json " +
      "and publishes a scope.violation event. When enforce=true, the agent must STOP all activity on this target. " +
      "Use when an out-of-scope target is discovered during testing.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "The out-of-scope target that was discovered or accidentally tested",
        },
        reason: {
          type: "string",
          description: "Why this is a violation (e.g. 'discovered during subdomain enumeration', 'not in authorized target list')",
        },
        context: {
          type: "string",
          description: "Additional context — what tool discovered it, what was being tested, etc.",
        },
        agent: {
          type: "string",
          description: "Name of the agent that discovered the violation (e.g. 'recon:subdomain', 'web')",
        },
      },
      required: ["target", "reason"],
    },
    execute: async (params: any) => {
      const violation: ScopeViolation = {
        id: generateViolationId(),
        timestamp: new Date().toISOString(),
        target: params.target,
        reason: params.reason,
        context: params.context,
        agent: params.agent,
      };

      // Persist
      recordViolation(violation);

      // Publish scope.violation event — other extensions/agents can listen
      try {
        (pi as any).emit?.("scope.violation", violation);
      } catch {
        // emit may not be available — non-fatal, violation is still persisted
      }
      try {
        (pi as any).publish?.("scope.violation", violation);
      } catch {
        // publish may not be available — non-fatal
      }

      const config = loadScope();
      const action = config.enforce
        ? "ENFORCEMENT ACTIVE — halt all activity on this target immediately"
        : "ADVISORY MODE — violation logged but enforcement is disabled";

      return {
        content: JSON.stringify({
          violation,
          action,
          violationsFile: VIOLATIONS_FILE,
        }, null, 2),
      };
    },
  });

  // ── /scope command ────────────────────────────────────────────────────────────

  pi.registerCommand("scope", {
    description:
      "Manage testing scope. Usage:\n" +
      "  /scope                          — show current scope\n" +
      "  /scope set <t1,t2,...>          — set authorized targets\n" +
      "  /scope add <target>             — add a target to scope\n" +
      "  /scope exclude <target>        — exclude a target from scope\n" +
      "  /scope allowed <domain>         — add an allowed domain\n" +
      "  /scope enforce [on|off]         — toggle enforcement\n" +
      "  /scope violations               — show recorded violations\n" +
      "  /scope reload                   — reload scope from file",
    handler: async (args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] || "";

      // /scope — show current scope
      if (!sub) {
        const config = loadScope();
        return formatScope(config);
      }

      // /scope set <targets>
      if (sub === "set") {
        const targetStr = parts.slice(1).join(" ");
        if (!targetStr) return "Usage: /scope set <target1,target2,...>";
        const targets = targetStr.split(",").map(t => t.trim()).filter(Boolean);
        const config: ScopeConfig = {
          targets,
          allowed_domains: [...targets],
          excluded: [],
          enforce: true,
        };
        saveScopeYaml(config);
        return `Scope set and saved to ${SCOPE_FILE}\n${formatScope(config)}`;
      }

      // /scope add <target>
      if (sub === "add") {
        const target = parts[1];
        if (!target) return "Usage: /scope add <target>";
        const config = loadScope();
        if (!config.targets.includes(target)) config.targets.push(target);
        saveScopeYaml(config);
        return `Added '${target}' to targets.\n${formatScope(config)}`;
      }

      // /scope exclude <target>
      if (sub === "exclude") {
        const target = parts[1];
        if (!target) return "Usage: /scope exclude <target>";
        const config = loadScope();
        if (!config.excluded.includes(target)) config.excluded.push(target);
        saveScopeYaml(config);
        return `Excluded '${target}' from scope.\n${formatScope(config)}`;
      }

      // /scope allowed <domain>
      if (sub === "allowed") {
        const domain = parts[1];
        if (!domain) return "Usage: /scope allowed <domain>";
        const config = loadScope();
        if (!config.allowed_domains.includes(domain)) config.allowed_domains.push(domain);
        saveScopeYaml(config);
        return `Added '${domain}' to allowed domains.\n${formatScope(config)}`;
      }

      // /scope enforce [on|off]
      if (sub === "enforce") {
        const config = loadScope();
        const toggle = parts[1]?.toLowerCase();
        if (toggle === "on") config.enforce = true;
        else if (toggle === "off") config.enforce = false;
        else config.enforce = !config.enforce; // toggle
        saveScopeYaml(config);
        return `Enforcement: ${config.enforce ? "ON — violations will halt activity" : "OFF — advisory mode"}`;
      }

      // /scope violations
      if (sub === "violations") {
        const log = loadViolations();
        return formatViolations(log);
      }

      // /scope reload
      if (sub === "reload") {
        const config = loadScope();
        return `Scope reloaded from ${SCOPE_FILE}\n${formatScope(config)}`;
      }

      return "Usage: /scope [set|add|exclude|allowed|enforce|violations|reload]";
    },
  });

  // ── Auto-enforcement: intercept tool calls against out-of-scope targets ──────
  //
  // When a bash command or other tool targets a host that is out of scope,
  // emit a scope.violation event and block execution.

  pi.on("tool_call", async (event: any, _ctx: any) => {
    const config = loadScope();
    if (!config.enforce) return;

    // Extract target from bash commands
    const toolName = event.toolName ?? event.tool ?? "";
    const params = event.input ?? event.params ?? {};

    const targets: string[] = [];

    if (toolName === "bash" && typeof params.command === "string") {
      // Extract hostnames/IPs from common bash commands
      const cmd = params.command;
      // Match hostnames in curl, wget, nmap, dig, etc.
      const hostPatterns = [
        /(?:curl|wget)\s+(?:https?:\/\/)?([a-zA-Z0-9._-]+)/g,
        /nmap\s+([a-zA-Z0-9._/-]+)/g,
        /dig\s+(?:@\S+\s+)?([a-zA-Z0-9._-]+)/g,
        /host\s+([a-zA-Z0-9._-]+)/g,
        /nslookup\s+([a-zA-Z0-9._-]+)/g,
        /nc\s+([a-zA-Z0-9._-]+)\s+\d+/g,
        /ssh\s+([a-zA-Z0-9._@-]+)/g,
      ];
      for (const pattern of hostPatterns) {
        let match;
        while ((match = pattern.exec(cmd)) !== null) {
          const host = match[1].includes("@") ? match[1].split("@")[1] : match[1];
          targets.push(host);
        }
      }
    }

    // For each extracted target, check scope
    for (const target of targets) {
      const result = checkScope(target, config);
      if (!result.authorized) {
        const violation: ScopeViolation = {
          id: generateViolationId(),
          timestamp: new Date().toISOString(),
          target,
          reason: result.excluded
            ? `Target is explicitly excluded (${result.excludeRule})`
            : "Target does not match any authorized scope entry",
          context: `Auto-detected in ${toolName} command`,
          agent: "scope-guard-v2:auto",
        };

        recordViolation(violation);

        // Publish event
        try {
          (pi as any).emit?.("scope.violation", violation);
        } catch {}
        try {
          (pi as any).publish?.("scope.violation", violation);
        } catch {}

        // Block the tool call
        return {
          block: true,
          message: `SCOPE VIOLATION — target '${target}' is ${result.excluded ? "excluded" : "out of scope"}.\n` +
            `Violation ID: ${violation.id}\n` +
            `Reason: ${violation.reason}\n` +
            `Enforcement is ACTIVE. All activity on this target must STOP.\n` +
            `Use /scope to review or modify the authorized scope.`,
        };
      }
    }
  });

  // ── On session start, show scope status ─────────────────────────────────────

  pi.on("session_start", async (_event: any, ctx: any) => {
    const config = loadScope();
    const hasScope = config.targets.length > 0 || config.allowed_domains.length > 0;
    if (!hasScope) {
      ctx?.ui?.notify?.(
        "No scope configured — advisory mode only. Use /scope set <targets> to authorize testing.",
        "warn",
      );
    } else {
      ctx?.ui?.notify?.(
        `Scope: ${config.targets.length} targets, ${config.allowed_domains.length} domains, ${config.excluded.length} excluded. Enforcement: ${config.enforce ? "ON" : "OFF"}`,
        "info",
      );
    }
  });
}
