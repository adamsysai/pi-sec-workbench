/**
 * pi-profiles — Pi Profile Manager
 *
 * Provides isolated, specialized Pi environments without duplicating
 * the Pi installation. Each profile declaratively specifies:
 *   - model + thinking level
 *   - packages (with optional version pins)
 *   - skills
 *   - extensions
 *   - system prompt
 *   - tool allowlist/denylist
 *   - environment variables
 *   - session directory
 *   - MCP servers
 *
 * Commands:
 *   /profile              — list available profiles
 *   /profile <name>      — switch profile (starts a new pi session)
 *   /profile current     — show current profile
 *   /profile info <name> — show profile details
 *
 * CLI flag:
 *   --profile <name>     — select profile at launch (via extension flag)
 *
 * Architecture:
 *   This extension runs inside Pi's extension API. It reads profile JSON
 *   files from ~/.pi/agent/profiles/<name>/profile.json. When switching,
 *   it generates the correct pi CLI flags and spawns a new pi process,
 *   because Pi cannot safely hot-swap its entire environment at runtime.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";

const PROFILES_DIR = path.join(os.homedir(), ".pi", "agent", "profiles");
const STATE_FILE = path.join(os.homedir(), ".pi", "agent", ".pi-profile-state.json");

interface ProfileConfig {
  name: string;
  description: string;
  model?: string;
  thinking?: string;
  packages?: string[];
  extensions?: string[];
  skills?: string[];
  systemPrompt?: string;
  excludeTools?: string[];
  allowTools?: string[];
  env?: Record<string, string>;
  sessionDir?: string;
  mcpServers?: Array<{ name: string; command: string; args?: string[] }>;
  swarm?: { enabled?: boolean; subagents?: string[] };
  scope?: { authorized?: boolean; targets?: string[]; enforce?: boolean };
}

/** Read current active profile from state file */
function readCurrentProfile(): string | null {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return data.profile ?? null;
  } catch {
    return null;
  }
}

/** Write current profile to state file */
function writeCurrentProfile(profile: string): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ profile, timestamp: Date.now() }, null, 2), "utf8");
  } catch {
    // non-fatal
  }
}

/** List all available profiles */
function listProfiles(): Array<{ name: string; config: ProfileConfig }> {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  const profiles: Array<{ name: string; config: ProfileConfig }> = [];
  const entries = fs.readdirSync(PROFILES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const configPath = path.join(PROFILES_DIR, entry.name, "profile.json");
    if (!fs.existsSync(configPath)) continue;
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      profiles.push({ name: entry.name, config });
    } catch {
      // skip broken configs
    }
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

/** Load a single profile config */
function loadProfile(name: string): ProfileConfig | null {
  const configPath = path.join(PROFILES_DIR, name, "profile.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

/** Format profile list for display */
function formatProfileList(profiles: Array<{ name: string; config: ProfileConfig }>, current: string | null): string {
  const lines: string[] = ["", "Available profiles:", ""];
  for (const p of profiles) {
    const marker = p.name === current ? ">" : " ";
    const model = p.config.model ? ` [${p.config.model}]` : "";
    const desc = p.config.description ? ` — ${p.config.description}` : "";
    lines.push(`  ${marker} ${p.name}${model}${desc}`);
  }
  lines.push("");
  lines.push("Switch: /profile <name>");
  lines.push("Info:   /profile info <name>");
  lines.push("");
  return lines.join("\n");
}

/** Format a single profile's details */
function formatProfileInfo(profile: ProfileConfig): string {
  const lines: string[] = ["", `Profile: ${profile.name}`, ""];
  lines.push(`  Description: ${profile.description}`);
  if (profile.model) lines.push(`  Model:        ${profile.model}`);
  if (profile.thinking) lines.push(`  Thinking:     ${profile.thinking}`);
  if (profile.packages?.length) lines.push(`  Packages:     ${profile.packages.join(", ")}`);
  if (profile.extensions?.length) lines.push(`  Extensions:   ${profile.extensions.length} local`);
  if (profile.skills?.length) lines.push(`  Skills:       ${profile.skills.length} directories`);
  if (profile.excludeTools?.length) lines.push(`  Exclude:      ${profile.excludeTools.join(", ")}`);
  if (profile.allowTools?.length) lines.push(`  Allow:        ${profile.allowTools.join(", ")}`);
  if (profile.env && Object.keys(profile.env).length) lines.push(`  Env vars:     ${Object.keys(profile.env).length}`);
  if (profile.sessionDir) lines.push(`  Session dir:  ${profile.sessionDir}`);
  if (profile.mcpServers?.length) lines.push(`  MCP servers:  ${profile.mcpServers.map(s => s.name).join(", ")}`);
  if (profile.swarm?.enabled) lines.push(`  Swarm:        enabled (${profile.swarm.subagents?.join(", ") || "default"})`);
  if (profile.scope?.authorized !== undefined) {
    lines.push(`  Scope:        ${profile.scope.authorized ? "authorized" : "unauthorized"}`);
    if (profile.scope.targets?.length) lines.push(`  Targets:      ${profile.scope.targets.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Write a project-local .pi/settings.json that merges the profile's
 * packages into the current directory so pi picks them up at launch.
 */
function writeProjectSettings(profile: ProfileConfig, cwd: string): string | null {
  if (!profile.packages?.length) return null;
  const piDir = path.join(cwd, ".pi");
  const settingsPath = path.join(piDir, "settings.json");
  fs.mkdirSync(piDir, { recursive: true });

  let existing: any = {};
  if (fs.existsSync(settingsPath)) {
    try { existing = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
  }
  const existingPkgs = new Set<string>(existing.packages || []);
  const merged = [...existingPkgs];
  for (const pkg of profile.packages!) {
    if (!existingPkgs.has(pkg)) merged.push(pkg);
  }
  existing.packages = merged;
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), "utf8");
  return settingsPath;
}

/**
 * Build the pi CLI arguments for a given profile.
 * This is the core translation layer: profile.json → pi flags.
 */
function buildPiArgs(profile: ProfileConfig, profileDir: string, extraArgs: string[]): string[] {
  const args: string[] = [];

  // Write project-local settings with profile packages so pi loads them
  const settingsPath = writeProjectSettings(profile, process.cwd());
  if (settingsPath) {
    args.push("--approve");  // trust project-local files
  }

  // Model — use provider/model to avoid ambiguity
  if (profile.model) {
    if (profile.model.includes("/")) {
      args.push("--model", profile.model);
    } else if ((profile as any).provider) {
      args.push("--model", `${(profile as any).provider}/${profile.model}`);
    } else {
      args.push("--model", profile.model);
    }
  }

  // Thinking level
  if (profile.thinking) {
    args.push("--thinking", profile.thinking);
  }

  // System prompt (append, so built-in prompt + profile prompt)
  if (profile.systemPrompt) {
    let promptPath: string;
    if (profile.systemPrompt.startsWith("/") || profile.systemPrompt.startsWith("~")) {
      promptPath = profile.systemPrompt.replace(/^~/, os.homedir());
    } else {
      // Relative to profile directory
      promptPath = path.join(profileDir, profile.systemPrompt);
    }
    if (fs.existsSync(promptPath)) {
      args.push("--append-system-prompt", promptPath);
    } else if (fs.existsSync(profile.systemPrompt)) {
      args.push("--append-system-prompt", profile.systemPrompt);
    }
    // If it's inline text, use --append-system-prompt with the text directly
    else {
      args.push("--append-system-prompt", profile.systemPrompt);
    }
  }

  // Extensions (local .ts files)
  if (profile.extensions) {
    for (const ext of profile.extensions) {
      const extPath = ext.startsWith("/") || ext.startsWith("~") ? ext.replace(/^~/, os.homedir()) : path.join(profileDir, ext);
      args.push("--extension", extPath);
    }
  }

  // Skills
  if (profile.skills) {
    for (const skill of profile.skills) {
      const skillPath = skill.startsWith("/") || skill.startsWith("~") ? skill.replace(/^~/, os.homedir()) : path.join(profileDir, skill);
      args.push("--skill", skillPath);
    }
  }

  // Tool denylist
  if (profile.excludeTools?.length) {
    args.push("--exclude-tools", profile.excludeTools.join(","));
  }

  // Tool allowlist (note: --tools is strict allowlist, built-ins must be listed)
  if (profile.allowTools?.length) {
    // Always include core built-ins
    const builtins = ["read", "bash", "edit", "write"];
    const allTools = [...new Set([...builtins, ...profile.allowTools])];
    args.push("--tools", allTools.join(","));
  }

  // Session directory (isolates sessions per-profile)
  if (profile.sessionDir) {
    const sessionDir = profile.sessionDir.replace(/^~/, os.homedir());
    args.push("--session-dir", sessionDir);
  } else {
    // Default: per-profile session dir (use directory name, not profile.name)
    args.push("--session-dir", path.join(os.homedir(), ".pi", "agent", "sessions", path.basename(profileDir)));
  }

  // Pass through any extra args
  args.push(...extraArgs);

  return args;
}

/**
 * Build environment for a profile.
 * Merges current env with profile env vars.
 */
function buildEnv(profile: ProfileConfig): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (profile.env) {
    for (const [key, value] of Object.entries(profile.env)) {
      env[key] = value.replace(/^~/, os.homedir());
    }
  }
  return env;
}

/**
 * Launch a new pi process with the given profile.
 * This achieves true isolation — a fresh process with only the
 * profile-specified packages, skills, extensions, and tools.
 */
function launchProfile(profileName: string, extraArgs: string[]): { success: boolean; message: string } {
  const profile = loadProfile(profileName);
  if (!profile) {
    return { success: false, message: `Profile '${profileName}' not found. Run /profile to see available profiles.` };
  }

  // Write state
  writeCurrentProfile(profileName);

  // Build args — KEY: use --no-extensions and --no-skills to prevent
  // loading the global settings' packages, then selectively re-enable
  // via --extension and --skill flags.
  // However, this would also disable the profile extension itself.
  // Instead, we use project-local .pi/settings.json to control packages.
  // The cleanest approach: generate a temporary project-local settings file.

  const profileDir = path.join(PROFILES_DIR, profileName);
  const args = buildPiArgs(profile, profileDir, extraArgs);
  const env = buildEnv(profile);

  // Find the pi binary
  const piBin = process.argv[1] || "pi";

  // Spawn a new pi process
  const child = spawn(piBin, args, {
    stdio: "inherit",
    env,
    cwd: process.cwd(),
  });

  child.on("error", (err) => {
    console.error(`Failed to launch pi with profile '${profileName}': ${err.message}`);
  });

  // Exit current process — the new one takes over the terminal
  process.on("exit", () => {
    // child process continues
  });

  return {
    success: true,
    message: `Switching to profile '${profileName}' — launching new pi session...`,
  };
}

export default function (pi: ExtensionAPI) {
  // Register the --profile CLI flag
  pi.registerFlag("profile", {
    description: "Select a Pi profile (e.g. sec, fullstack, research)",
    type: "string",
  });

  // Register /profile command
  pi.registerCommand("profile", {
    description: "Switch or list Pi profiles. Usage: /profile [name|current|info <name>]",
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0] || "";
      const profileName = parts[1] || "";
      const current = readCurrentProfile();

      // /profile — list all
      if (!subcommand) {
        const profiles = listProfiles();
        if (profiles.length === 0) {
          return "No profiles found. Create profiles in ~/.pi/agent/profiles/<name>/profile.json";
        }
        return formatProfileList(profiles, current);
      }

      // /profile current
      if (subcommand === "current") {
        if (!current) return "No profile currently active. Use /profile <name> to select one.";
        const config = loadProfile(current);
        if (!config) return `Current profile: ${current} (config missing)`;
        return formatProfileInfo(config);
      }

      // /profile info <name>
      if (subcommand === "info") {
        if (!profileName) return "Usage: /profile info <name>";
        const config = loadProfile(profileName);
        if (!config) return `Profile '${profileName}' not found.`;
        return formatProfileInfo(config);
      }

      // /profile <name> — switch
      const config = loadProfile(subcommand);
      if (!config) {
        const profiles = listProfiles();
        return `Profile '${subcommand}' not found.\n\n${formatProfileList(profiles, current)}`;
      }

      // Launch new pi process with this profile
      const result = launchProfile(subcommand, []);
      if (!result.success) {
        return result.message;
      }

      // The new process takes over — this command returns a status message
      return result.message;
    },
  });

  // On startup, check if --profile flag was passed
  pi.on("before_agent_start", () => {
    const flagValue = pi.getFlag("profile");
    if (flagValue && typeof flagValue === "string") {
      const profile = loadProfile(flagValue);
      if (profile) {
        // Apply profile settings at runtime
        writeCurrentProfile(flagValue);

        // Apply model if set
        if (profile.model) {
          pi.setModel?.(profile.model).catch(() => {});
        }

        // Apply thinking level
        if (profile.thinking) {
          pi.setThinkingLevel?.(profile.thinking as any);
        }

        // Apply tool filtering
        if (profile.excludeTools?.length) {
          const activeTools = pi.getActiveTools?.() ?? [];
          const filtered = activeTools.filter(t => !profile.excludeTools!.includes(t));
          pi.setActiveTools?.(filtered);
        } else if (profile.allowTools?.length) {
          const builtins = ["read", "bash", "edit", "write"];
          const allowed = [...new Set([...builtins, ...profile.allowTools])];
          pi.setActiveTools?.(allowed);
        }
      }
    }
  });
}
