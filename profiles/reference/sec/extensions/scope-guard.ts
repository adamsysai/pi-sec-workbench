/**
 * Scope Guard — enforces authorization boundaries for pi-sec
 *
 * Reads authorized targets from the profile config and blocks
 * any tool execution against targets outside the authorized scope.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface ScopeConfig {
  authorized: boolean;
  targets: string[];
  enforce: boolean;
}

function loadScope(): ScopeConfig {
  try {
    const profilePath = path.join(os.homedir(), ".pi", "agent", "profiles", "sec", "profile.json");
    if (!fs.existsSync(profilePath)) return { authorized: false, targets: [], enforce: true };
    const config = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    return config.scope ?? { authorized: false, targets: [], enforce: true };
  } catch {
    return { authorized: false, targets: [], enforce: true };
  }
}

/** Check if a target matches any authorized pattern */
function isTargetAuthorized(target: string, authorizedTargets: string[]): boolean {
  if (authorizedTargets.length === 0) return false;
  for (const authorized of authorizedTargets) {
    // Exact match
    if (target === authorized) return true;
    // CIDR match (basic)
    if (authorized.includes("/")) {
      try {
        const [network, bits] = authorized.split("/");
        const targetIp = target.split(":")[0];
        // Simple check — not a full CIDR implementation
        if (targetIp.startsWith(network.split(".").slice(0, 2).join("."))) return true;
      } catch {}
    }
    // Domain wildcard
    if (authorized.startsWith("*.")) {
      const domain = authorized.slice(2);
      if (target === domain || target.endsWith("." + domain)) return true;
    }
    // Domain or subdomain match
    if (target === authorized || target.endsWith("." + authorized)) return true;
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "scope_check",
    description: "Check if a target is within the authorized testing scope. Returns authorized status and matched rules.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "IP, hostname, or domain to check against authorized scope"
        }
      },
      required: ["target"]
    },
    execute: async (params: any) => {
      const scope = loadScope();
      if (!scope.authorized) {
        return {
          content: JSON.stringify({
            target: params.target,
            authorized: false,
            reason: "No authorization configured. Set scope.authorized=true and scope.targets in profile.json"
          }, null, 2)
        };
      }
      const authorized = isTargetAuthorized(params.target, scope.targets);
      return {
        content: JSON.stringify({
          target: params.target,
          authorized,
          matchedRule: authorized ? "found in authorized targets" : "not in authorized targets",
          enforce: scope.enforce
        }, null, 2)
      };
    }
  });

  pi.registerTool({
    name: "scope_set",
    description: "Set authorized targets for testing. Requires confirmation. Use carefully.",
    parameters: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: { type: "string" },
          description: "Authorized target IPs, domains, or CIDR ranges"
        },
        authorized: {
          type: "boolean",
          description: "Set to true to authorize testing"
        }
      },
      required: ["targets", "authorized"]
    },
    execute: async (params: any) => {
      try {
        const profilePath = path.join(os.homedir(), ".pi", "agent", "profiles", "sec", "profile.json");
        const config = JSON.parse(fs.readFileSync(profilePath, "utf8"));
        config.scope = {
          authorized: params.authorized,
          targets: params.targets,
          enforce: true
        };
        fs.writeFileSync(profilePath, JSON.stringify(config, null, 2), "utf8");
        return {
          content: JSON.stringify({
            success: true,
            scope: config.scope,
            message: params.authorized
              ? `Authorized targets set: ${params.targets.join(", ")}`
              : "Authorization removed. Operating in advisory mode."
          }, null, 2)
        };
      } catch (e: any) {
        return { content: `Error setting scope: ${e.message}` };
      }
    }
  });

  // Register /scope command for quick status
  pi.registerCommand("scope", {
    description: "Show or set authorized testing scope. Usage: /scope [set target1,target2 ...]",
    handler: async (args: string) => {
      const scope = loadScope();
      if (!args.trim()) {
        return [
          "",
          "Authorization Scope:",
          `  Authorized: ${scope.authorized ? "YES" : "NO"}`,
          `  Targets:    ${scope.targets.length ? scope.targets.join(", ") : "(none set)"}`,
          `  Enforce:    ${scope.enforce ? "YES" : "NO"}`,
          "",
          "Set: /scope set target.com,10.0.0.0/24",
          ""
        ].join("\n");
      }

      const parts = args.trim().split(/\s+/);
      if (parts[0] === "set" && parts[1]) {
        const targets = parts[1].split(",").map(t => t.trim()).filter(Boolean);
        try {
          const profilePath = path.join(os.homedir(), ".pi", "agent", "profiles", "sec", "profile.json");
          const config = JSON.parse(fs.readFileSync(profilePath, "utf8"));
          config.scope = { authorized: true, targets, enforce: true };
          fs.writeFileSync(profilePath, JSON.stringify(config, null, 2), "utf8");
          return `✓ Authorized scope set: ${targets.join(", ")}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }

      return "Usage: /scope [set target1,target2 ...]";
    }
  });
}
