/**
 * pattern-library.ts — Structured vulnerability pattern library
 *
 * Patterns represent:
 * ARCHITECTURE PATTERN → SECURITY INVARIANT → WEAKNESS PATTERN →
 * OBSERVABLE SIGNAL → VALIDATION STRATEGY → POTENTIAL IMPACT
 *
 * Pre-populated with 20 common patterns.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SEC_DATA = path.resolve(process.env.PI_SEC_DATA_DIR || ".local/reference-data");
const PATTERNS_DIR = path.join(SEC_DATA, "patterns");
const PATTERNS_FILE = path.join(PATTERNS_DIR, "patterns.json");

interface Pattern {
  id: string;
  name: string;
  architecture_pattern: string;
  security_invariant: string;
  weakness_pattern: string;
  observable_signals: string[];
  validation_strategy: string;
  potential_impact: string;
  vuln_class: string;
  tags: string[];
}

// Pre-populated patterns
const SEED_PATTERNS: Pattern[] = [
  {
    id: "PTN-001",
    name: "IDOR/BOLA in REST APIs",
    architecture_pattern: "REST API with object IDs in URL paths (/api/users/:id, /api/orders/:id)",
    security_invariant: "User A can only access resources owned by User A. Object IDs must be validated against ownership.",
    weakness_pattern: "Object ID in URL is used directly to fetch resource without checking if the requesting user owns or has access to that resource.",
    observable_signals: ["Sequential object IDs (1, 2, 3)", "No ownership check in API handler", "Same response for different authenticated users requesting same ID", "IDOR parameter in URL path not validated"],
    validation_strategy: "1. Authenticate as User A, note resource ID. 2. Authenticate as User B. 3. Request User A's resource ID as User B. 4. If response contains User A's data → confirmed IDOR.",
    potential_impact: "Unauthorized data access, mass data exfiltration, account takeover if sensitive resources exposed.",
    vuln_class: "idor",
    tags: ["api", "authorization", "rest", "bola"],
  },
  {
    id: "PTN-002",
    name: "IDOR/BOLA in GraphQL",
    architecture_pattern: "GraphQL API with type-based resolvers and object fetching by ID",
    security_invariant: "Field resolvers must enforce authorization per-object, not just at the query level.",
    weakness_pattern: "GraphQL resolver fetches object by ID without checking if the requesting user has access to that object. Introspection reveals all types and fields.",
    observable_signals: ["GraphQL endpoint accepts arbitrary IDs", "No field-level authorization", "Introspection enabled in production", "Batch queries allow mass IDOR", "Alias-based attacks for brute force"],
    validation_strategy: "1. Query an object owned by User A. 2. Re-query same object as User B. 3. If data returned → confirmed. 4. Test with aliases for mass extraction.",
    potential_impact: "Mass data exfiltration via batched queries, full database enumeration through GraphQL.",
    vuln_class: "idor",
    tags: ["api", "graphql", "authorization"],
  },
  {
    id: "PTN-003",
    name: "JWT Algorithm Confusion (RS256→HS256)",
    architecture_pattern: "JWT authentication with RS256 (asymmetric) signing",
    security_invariant: "The server must enforce the expected signing algorithm and reject tokens with different algorithms.",
    weakness_pattern: "Server accepts HS256 algorithm and uses the public key as the HMAC secret, allowing token forgery.",
    observable_signals: ["JWT with alg:RS256 in header", "Public key available (e.g. /jwks.json, /.well-known/jwks.json)", "Server doesn't pin algorithm", "Library vulnerable to algorithm confusion"],
    validation_strategy: "1. Obtain public key. 2. Craft JWT with alg:HS256 using public key as HMAC secret. 3. Send forged token. 4. If accepted → confirmed.",
    potential_impact: "Authentication bypass, complete account impersonation, admin access if admin tokens forged.",
    vuln_class: "auth-bypass",
    tags: ["jwt", "auth", "algorithm-confusion"],
  },
  {
    id: "PTN-004",
    name: "OAuth Redirect URI Manipulation",
    architecture_pattern: "OAuth 2.0 authorization code flow with redirect_uri validation",
    security_invariant: "Redirect URI must be strictly validated against an allowlist. Open redirects must not be used as intermediaries.",
    weakness_pattern: "Redirect URI validation is insufficient — allows path traversal, subdomain takeover, or open redirect chains to exfiltrate authorization codes.",
    observable_signals: ["redirect_uri parameter in URL", "Validation only checks domain prefix", "Path traversal in redirect_uri", "Open redirect on same domain", "State parameter missing or not validated"],
    validation_strategy: "1. Start OAuth flow with malicious redirect_uri. 2. Test path traversal (https://app.com/redirect?url=https://evil.com). 3. Test subdomain takeover. 4. If code lands on attacker-controlled URL → confirmed.",
    potential_impact: "Authorization code theft, account takeover, token theft via malicious redirect.",
    vuln_class: "oauth",
    tags: ["oauth", "auth", "redirect", "open-redirect"],
  },
  {
    id: "PTN-005",
    name: "SSRF via URL Parameters",
    architecture_pattern: "Server-side HTTP requests based on user input (webhooks, URL previews, image fetching, PDF rendering)",
    security_invariant: "User-supplied URLs must be validated against an allowlist. Internal IP ranges must be blocked.",
    weakness_pattern: "Server fetches user-supplied URL without validating destination, allowing access to internal services, cloud metadata, or localhost services.",
    observable_signals: ["URL parameter accepted and fetched server-side", "No IP range blocking (169.254.169.254, 10.x, 172.16-31.x, 192.168.x)", "Response contains fetched content", "Timing differences for internal vs external", "Error messages reveal internal topology"],
    validation_strategy: "1. Submit URL to cloud metadata (http://169.254.169.254/latest/meta-data/). 2. Submit URL to localhost services. 3. If internal content returned → confirmed. 4. Test DNS rebinding if IP filtering exists.",
    potential_impact: "Cloud credential theft via metadata service, internal port scanning, access to internal admin panels, database access.",
    vuln_class: "ssrf",
    tags: ["ssrf", "server-side", "cloud", "metadata"],
  },
  {
    id: "PTN-006",
    name: "SSRF via DNS Rebinding",
    architecture_pattern: "Server-side URL fetching with IP-based filtering",
    security_invariant: "IP validation must occur at connection time, not just at DNS resolution time.",
    weakness_pattern: "Server validates IP at DNS resolution time, but connects to a different IP (rebinding) that bypasses the filter.",
    observable_signals: ["IP-based filtering exists", "URL fetched server-side", "Filtering happens before connection", "No re-resolution at connect time"],
    validation_strategy: "1. Set up DNS rebinding domain. 2. First resolution returns public IP (passes filter). 3. Second resolution returns 169.254.169.254. 4. If metadata returned → confirmed.",
    potential_impact: "Bypass IP filtering to reach internal services, cloud metadata access.",
    vuln_class: "ssrf",
    tags: ["ssrf", "dns-rebinding", "bypass"],
  },
  {
    id: "PTN-007",
    name: "SQL Injection in ORDER BY",
    architecture_pattern: "SQL query with dynamic ORDER BY clause from user input",
    security_invariant: "ORDER BY parameters must be validated against a column allowlist. Parameterized queries don't protect ORDER BY.",
    weakness_pattern: "User input placed directly in ORDER BY clause without validation, allowing boolean-based or time-based injection.",
    observable_signals: ["Sort parameter in API", "Different response ordering with different sort values", "Error when special characters in sort param", "Time delay with SLEEP() in sort param"],
    validation_strategy: "1. Test sort parameter with normal column. 2. Test with non-existent column (error?). 3. Test boolean: (CASE WHEN 1=1 THEN column1 ELSE column2 END). 4. Test time-based: SLEEP(5). 5. If response changes or delays → confirmed.",
    potential_impact: "Database enumeration, data extraction via boolean/time-based injection, potential RCE via INTO OUTFILE.",
    vuln_class: "sqli",
    tags: ["sqli", "order-by", "injection"],
  },
  {
    id: "PTN-008",
    name: "SQL Injection via JSON",
    architecture_pattern: "JSON API with JSON fields parsed and used in SQL queries",
    security_invariant: "JSON field values must be parameterized, not string-interpolated into SQL.",
    weakness_pattern: "JSON field values are extracted and used in SQL query construction without parameterization.",
    observable_signals: ["JSON request body with fields used in queries", "SQL errors when special characters in JSON values", "Different responses with injection payloads in JSON fields", "JSON path injection"],
    validation_strategy: "1. Send JSON with ' in field value. 2. Check for SQL error. 3. Test boolean: \"' OR 1=1--\". 4. Test UNION: \"' UNION SELECT 1,2,3--\". 5. If data returned or error → confirmed.",
    potential_impact: "Full database access, data exfiltration, potential RCE.",
    vuln_class: "sqli",
    tags: ["sqli", "json", "injection"],
  },
  {
    id: "PTN-009",
    name: "NoSQL Injection",
    architecture_pattern: "NoSQL database (MongoDB) with query parameters from user input",
    security_invariant: "Query operators must not be injectable. User input must not allow $-prefixed operators.",
    weakness_pattern: "User input parsed as JSON allows MongoDB operators like $ne, $gt, $regex to bypass authentication or extract data.",
    observable_signals: ["JSON input used in MongoDB queries", "No sanitization of $-prefixed keys", "Authentication bypass with {\"password\":{\"$ne\":\"\"}}", "Different responses with $regex operators"],
    validation_strategy: "1. Send {\"username\":\"admin\",\"password\":{\"$ne\":\"\"}}. 2. If login succeeds → confirmed auth bypass. 3. Test {$gt:\"\"} for data extraction. 4. Test $regex for blind extraction.",
    potential_impact: "Authentication bypass, full database enumeration, data exfiltration.",
    vuln_class: "nosqli",
    tags: ["nosql", "injection", "mongodb", "auth-bypass"],
  },
  {
    id: "PTN-010",
    name: "XSS via Template Injection",
    architecture_pattern: "Server-side template rendering with user input in template context",
    security_invariant: "User input must be treated as data, not as template syntax. Templates must use auto-escaping.",
    weakness_pattern: "User input is placed in template context allowing template syntax injection (Jinja2, Twig, Handlebars, etc.) leading to XSS or RCE.",
    observable_signals: ["User input rendered in page", "Template syntax ({{}}, ${}, <%= %>) in input causes different output", "Mathematical expressions evaluated", "Server-side errors with template syntax"],
    validation_strategy: "1. Test {{7*7}} in input fields. 2. If 49 rendered → SSTI confirmed. 3. Escalate to RCE with template-specific payloads. 4. If only <script> tags work → XSS not SSTI.",
    potential_impact: "Cross-site scripting, server-side code execution, full server compromise.",
    vuln_class: "xss",
    tags: ["xss", "ssti", "template", "rce"],
  },
  {
    id: "PTN-011",
    name: "XSS via DOM Sinks",
    architecture_pattern: "Client-side JavaScript that writes user-controlled data to DOM without sanitization",
    security_invariant: "All user input written to DOM must be sanitized. Dangerous sinks (innerHTML, document.write, eval) must be avoided.",
    weakness_pattern: "JavaScript reads URL parameters or postMessage data and writes to DOM sinks (innerHTML, outerHTML, document.write, eval, setTimeout with string).",
    observable_signals: ["URL parameters reflected in page", "innerHTML or document.write in JS", "No CSP or weak CSP", "postMessage without origin check", "Fragment (#) used for data passing"],
    validation_strategy: "1. Identify DOM sink in JS source. 2. Trace data flow from source (URL param, postMessage, hash). 3. Inject payload via source. 4. If script executes → confirmed. 5. Check CSP headers.",
    potential_impact: "Cookie theft, session hijacking, credential phishing, browser exploitation.",
    vuln_class: "xss",
    tags: ["xss", "dom", "client-side", "csp"],
  },
  {
    id: "PTN-012",
    name: "CSRF on Stateless API",
    architecture_pattern: "Stateless API using JWT in cookies (not Authorization header)",
    security_invariant: "Stateless APIs using cookie-based auth are vulnerable to CSRF unless CSRF tokens or SameSite cookies are used.",
    weakness_pattern: "API accepts JWT from cookies without CSRF protection. SameSite cookie attribute not set. No custom header requirement.",
    observable_signals: ["Auth token in cookie not header", "No SameSite attribute", "No CSRF token", "Content-Type: application/x-www-form-urlencoded accepted", "No custom header check (X-Requested-With)"],
    validation_strategy: "1. Identify state-changing endpoint. 2. Create HTML form that submits to API. 3. If request succeeds from different origin → confirmed. 4. Check SameSite cookie. 5. Test if custom header required.",
    potential_impact: "Unauthorized state changes, fund transfers, email changes, account modifications.",
    vuln_class: "csrf",
    tags: ["csrf", "api", "cookie", "stateless"],
  },
  {
    id: "PTN-013",
    name: "Mass Assignment",
    architecture_pattern: "API that accepts JSON and maps directly to model properties",
    security_invariant: "API must use explicit field allowlists (DTOs), not accept arbitrary properties.",
    weakness_pattern: "API accepts JSON and binds all properties to model, allowing user to set fields like role, isAdmin, balance, etc.",
    observable_signals: ["API accepts JSON body", "Extra fields not rejected", "Model has sensitive fields (role, isAdmin, balance)", "No DTO/allowlist in controller", "Update endpoint accepts all fields"],
    validation_strategy: "1. Send normal update request. 2. Add \"role\":\"admin\" to JSON body. 3. If role changes → confirmed. 4. Test other sensitive fields: isAdmin, balance, verified, status.",
    potential_impact: "Privilege escalation, account modification, financial manipulation.",
    vuln_class: "mass-assignment",
    tags: ["api", "authorization", "privilege-escalation"],
  },
  {
    id: "PTN-014",
    name: "Race Condition in Payment",
    architecture_pattern: "Payment processing with balance check then deduction (non-atomic)",
    security_invariant: "Balance check and deduction must be atomic. Database transactions with proper isolation must be used.",
    weakness_pattern: "Balance checked first, then deducted separately. Concurrent requests can both pass the check before either deduction.",
    observable_signals: ["Balance check and deduction in separate operations", "No database transaction", "No pessimistic locking", "No idempotency key", "No rate limiting on payment endpoint"],
    validation_strategy: "1. Identify balance check endpoint. 2. Send 10 concurrent requests to use same balance. 3. If multiple succeed → confirmed race. 4. Check if double-spend occurred.",
    potential_impact: "Free purchases, balance manipulation, double-spending, financial fraud.",
    vuln_class: "race-condition",
    tags: ["business-logic", "payment", "race", "concurrency"],
  },
  {
    id: "PTN-015",
    name: "Rate Limit Bypass",
    architecture_pattern: "Rate limiting based on IP address or single identifier",
    security_invariant: "Rate limiting must account for all possible ways to identify a client, not just IP.",
    weakness_pattern: "Rate limit only on IP, allowing bypass via X-Forwarded-For, multiple accounts, or rotating IPs.",
    observable_signals: ["Rate limit on IP only", "X-Forwarded-For accepted", "No limit per-account", "Different endpoints have separate limits", "No limit on GraphQL batch queries"],
    validation_strategy: "1. Hit rate-limited endpoint until blocked. 2. Add X-Forwarded-For: random IP. 3. If unblocked → confirmed. 4. Test different paths to same resource. 5. Test batch queries.",
    potential_impact: "Brute force attacks, credential stuffing, data scraping, OTP bypass.",
    vuln_class: "rate-limit",
    tags: ["rate-limit", "bypass", "brute-force"],
  },
  {
    id: "PTN-016",
    name: "Privilege Escalation via Parameter Pollution",
    architecture_pattern: "API that accepts parameters from multiple sources (query, body, headers)",
    security_invariant: "Parameter source must be deterministic. Priority must be explicit and consistent.",
    weakness_pattern: "API accepts role/permission from query parameter that overrides body value, or header overrides body.",
    observable_signals: ["Parameters accepted from multiple sources", "Different values in query vs body", "Role/permission parameter in URL", "No source priority enforcement"],
    validation_strategy: "1. Send normal request with role:member in body. 2. Add role=admin in query string. 3. If role becomes admin → confirmed. 4. Test header vs body. 5. Test JSON vs form encoding.",
    potential_impact: "Privilege escalation, authorization bypass.",
    vuln_class: "privilege-escalation",
    tags: ["api", "authorization", "parameter-pollution"],
  },
  {
    id: "PTN-017",
    name: "Session Fixation",
    architecture_pattern: "Session management that doesn't rotate session ID on authentication",
    security_invariant: "Session ID must be regenerated after login to prevent fixation attacks.",
    weakness_pattern: "Session ID remains the same before and after login, allowing attacker to set a known session ID.",
    observable_signals: ["Session cookie same before/after login", "No Set-Cookie on login response", "Session ID in URL", "No session rotation on privilege change"],
    validation_strategy: "1. Note session cookie before login. 2. Login. 3. Check if cookie changed. 4. If same → confirmed session fixation. 5. Test if pre-set session ID accepted after login.",
    potential_impact: "Session hijacking, account takeover via pre-set session ID.",
    vuln_class: "session",
    tags: ["auth", "session", "fixation"],
  },
  {
    id: "PTN-018",
    name: "Insecure Deserialization",
    architecture_pattern: "Application that deserializes user-supplied data (Java, .NET, Python pickle, PHP unserialize)",
    security_invariant: "User-supplied data must never be deserialized. Use JSON or other safe formats.",
    weakness_pattern: "Application deserializes objects from user input, allowing code execution via gadget chains.",
    observable_signals: ["Serialized data in parameters/cookies", "Java/Ruby/PHP/Python backend", "Base64-encoded serialized objects", "Magic methods called during deserialization", "ysoserial-style payloads cause errors"],
    validation_strategy: "1. Identify serialized data format. 2. Generate payload with gadget chain (ysoserial, pickle, etc.). 3. Send payload. 4. If code executes (DNS callback, file creation) → confirmed RCE. 5. Test blind deserialization with OOB.",
    potential_impact: "Remote code execution, full server compromise.",
    vuln_class: "deserialization",
    tags: ["rce", "deserialization", "java", "python"],
  },
  {
    id: "PTN-019",
    name: "Path Traversal in File Upload",
    architecture_pattern: "File upload with filename used in storage path",
    security_invariant: "Filenames must be sanitized. Generated filenames should be used, not user-supplied.",
    weakness_pattern: "User-supplied filename is used in file path construction allowing ../ traversal to overwrite system files.",
    observable_signals: ["Filename in upload used for storage path", "No filename sanitization", "../ in filename accepted", "Absolute path in filename", "Null byte in filename"],
    validation_strategy: "1. Upload file with filename ../../../tmp/test.txt. 2. Check if file written outside upload dir. 3. Try absolute path /etc/cron.d/test. 4. If file exists → confirmed.",
    potential_impact: "Arbitrary file write, code execution via overwrite, path traversal to read sensitive files.",
    vuln_class: "path-traversal",
    tags: ["file-upload", "path-traversal", "rce"],
  },
  {
    id: "PTN-020",
    name: "Open Redirect Chains",
    architecture_pattern: "Multiple redirect endpoints that validate against different criteria",
    security_invariant: "All redirect endpoints must validate against the same allowlist. No redirect chains allowed.",
    weakness_pattern: "Redirect A validates domain but allows redirect to redirect B, which allows external redirect. Or open redirect used for OAuth token theft.",
    observable_signals: ["Multiple redirect parameters in flow", "Different validation for different redirect endpoints", "Redirect chain possible", "Open redirect on same domain as OAuth"],
    validation_strategy: "1. Identify redirect endpoints. 2. Test each for open redirect. 3. Chain: redirect A → redirect B → external. 4. If chain reaches external URL → confirmed. 5. Test in OAuth flow for code theft.",
    potential_impact: "Phishing via trusted domain, OAuth token theft, SSRF via redirect chains.",
    vuln_class: "open-redirect",
    tags: ["redirect", "oauth", "phishing", "chain"],
  },
];

function loadPatterns(): { patterns: Pattern[] } {
  if (!fs.existsSync(PATTERNS_FILE)) {
    fs.mkdirSync(PATTERNS_DIR, { recursive: true });
    fs.writeFileSync(PATTERNS_FILE, JSON.stringify({ patterns: SEED_PATTERNS }, null, 2), "utf8");
    return { patterns: SEED_PATTERNS };
  }
  try {
    return JSON.parse(fs.readFileSync(PATTERNS_FILE, "utf8"));
  } catch {
    return { patterns: SEED_PATTERNS };
  }
}

function savePatterns(data: { patterns: Pattern[] }) {
  fs.mkdirSync(PATTERNS_DIR, { recursive: true });
  fs.writeFileSync(PATTERNS_FILE, JSON.stringify(data, null, 2), "utf8");
}

function nextPatternId(patterns: Pattern[]): string {
  const maxId = patterns.reduce((max, p) => {
    const num = parseInt(p.id.replace("PTN-", ""), 10);
    return num > max ? num : max;
  }, 0);
  return `PTN-${String(maxId + 1).padStart(3, "0")}`;
}

export default function (pi: ExtensionAPI) {
  // Initialize patterns on load
  loadPatterns();

  // 1. pattern_add
  pi.registerTool({
    name: "pattern_add",
    description: "Add a new vulnerability pattern to the library. Patterns represent: architecture → invariant → weakness → signal → validation → impact.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Pattern name" },
        architecture_pattern: { type: "string" },
        security_invariant: { type: "string" },
        weakness_pattern: { type: "string" },
        observable_signals: { type: "array", items: { type: "string" } },
        validation_strategy: { type: "string" },
        potential_impact: { type: "string" },
        vuln_class: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["name", "architecture_pattern", "security_invariant", "weakness_pattern", "observable_signals", "validation_strategy", "potential_impact", "vuln_class"],
    },
    execute: async (params: any) => {
      const data = loadPatterns();
      const id = nextPatternId(data.patterns);
      const pattern: Pattern = { id, tags: params.tags || [], ...params };
      data.patterns.push(pattern);
      savePatterns(data);
      return { content: JSON.stringify({ success: true, id, message: `Pattern added: ${params.name}` }) };
    },
  });

  // 2. pattern_search
  pi.registerTool({
    name: "pattern_search",
    description: "Search patterns by vulnerability class, observable signal, or architecture.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        vuln_class: { type: "string", description: "Filter by vulnerability class" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
    execute: async (params: any) => {
      const data = loadPatterns();
      let results = data.patterns;

      if (params.vuln_class) {
        results = results.filter(p => p.vuln_class === params.vuln_class);
      }

      const query = params.query.toLowerCase();
      results = results.filter(p => {
        const haystack = JSON.stringify(p).toLowerCase();
        return haystack.includes(query);
      });

      return {
        content: JSON.stringify({
          query: params.query,
          vuln_class: params.vuln_class || "all",
          results: results.slice(0, params.limit || 10).map(p => ({
            id: p.id,
            name: p.name,
            vuln_class: p.vuln_class,
            observable_signals: p.observable_signals,
            validation_strategy: p.validation_strategy,
            potential_impact: p.potential_impact,
          })),
        }, null, 2),
      };
    },
  });

  // 3. pattern_list
  pi.registerTool({
    name: "pattern_list",
    description: "List all patterns in the library, grouped by vulnerability class.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: async () => {
      const data = loadPatterns();
      const byClass: Record<string, Pattern[]> = {};
      for (const p of data.patterns) {
        if (!byClass[p.vuln_class]) byClass[p.vuln_class] = [];
        byClass[p.vuln_class].push(p);
      }
      return {
        content: JSON.stringify({
          total_patterns: data.patterns.length,
          by_class: Object.fromEntries(
            Object.entries(byClass).map(([cls, patterns]) => [cls, patterns.map(p => ({ id: p.id, name: p.name }))])
          ),
        }, null, 2),
      };
    },
  });

  // 4. pattern_export
  pi.registerTool({
    name: "pattern_export",
    description: "Export the full pattern library as JSON.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: async () => {
      const data = loadPatterns();
      return { content: JSON.stringify(data, null, 2) };
    },
  });

  // 5. /patterns command
  pi.registerCommand("patterns", {
    description: "Show pattern count by class and search patterns. Usage: /patterns [search query]",
    handler: async (args: string) => {
      const data = loadPatterns();

      if (!args.trim()) {
        const byClass: Record<string, number> = {};
        for (const p of data.patterns) {
          byClass[p.vuln_class] = (byClass[p.vuln_class] || 0) + 1;
        }
        const lines: string[] = ["", "Vulnerability Pattern Library:", ""];
        lines.push(`  Total: ${data.patterns.length} patterns`);
        lines.push("", "  By class:");
        for (const [cls, count] of Object.entries(byClass).sort()) {
          lines.push(`    ${cls}: ${count}`);
        }
        lines.push("", "  Usage: /patterns <search query>", "");
        return lines.join("\n");
      }

      const query = args.trim().toLowerCase();
      const results = data.patterns.filter(p => JSON.stringify(p).toLowerCase().includes(query));
      const lines: string[] = [`\n  Search: "${args.trim()}" — ${results.length} matches\n`];
      for (const p of results.slice(0, 10)) {
        lines.push(`  ${p.id} — ${p.name} [${p.vuln_class}]`);
        lines.push(`    Impact: ${p.potential_impact.substring(0, 80)}...`);
      }
      lines.push("");
      return lines.join("\n");
    },
  });
}
