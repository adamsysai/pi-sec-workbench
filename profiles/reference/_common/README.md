# Pi Profile Manager

Specialized Pi environments from a single installation — no duplication, no bloat.

## Quick Start

```bash
# List available profiles
pi-profile list

# Launch pi with a profile
pi-profile use sec
pi-profile use fullstack
pi-profile use research

# Show profile details
pi-profile info sec

# Diagnose setup
pi-profile doctor
```

## Inside Pi

Once a profile is active, you can also switch from within pi:

```
/profile              # list all profiles
/profile sec          # switch to sec (launches new session)
/profile current      # show active profile
/profile info sec     # show profile details
```

Or at launch time:

```bash
pi --profile sec
pi --profile fullstack
```

## Available Profiles

| Profile | Focus | Model | Packages |
|---------|-------|-------|----------|
| `sec` | Authorized security research | glm-5.2 | 9 (casefile, exploitsearch, piolium, etc.) |
| `fullstack` | Full-stack software engineering | glm-5.2 | 5 (subagents, web-access, context-mode, etc.) |
| `frontend` | React, Next.js, TypeScript, UI | glm-5.2 | 4 (subagents, chrome-dev-tools, etc.) |
| `backend` | Go, Node, Python, APIs, distributed | glm-5.2 | 4 (subagents, context-mode, etc.) |
| `smart-contract` | Solidity, Foundry, EVM, DeFi | glm-5.2 | 4 (subagents, web-access, etc.) |
| `research` | Web research, papers, synthesis | glm-5.2 | 5 (web-access, mcp-adapter, etc.) |
| `devops` | CI/CD, infrastructure, monitoring | glm-5.2 | 4 (subagents, web-access, etc.) |
| `data` | Data engineering, pipelines, ML | glm-5.2 | 4 (subagents, web-access, etc.) |
| `mobile` | React Native, Flutter, iOS, Android | glm-5.2 | 4 (subagents, web-access, etc.) |

## Architecture

```
~/.pi/agent/profiles/
  _common/
    profile-schema.json     # JSON Schema for profile.json
    pi-profiles.ts          # Extension: /profile command + --profile flag
    pi-profile              # CLI wrapper (symlinked to PATH)
    test.js                 # Test suite
    README.md               # This file
  sec/
    profile.json            # Profile configuration
    system.md               # System prompt
    extensions/
      scope-guard.ts        # Authorization scope guard
    skills/
      web-pentest/SKILL.md
      api-security/SKILL.md
      ...
  fullstack/
    profile.json
    system.md
    skills/
      typescript/SKILL.md
      react-nextjs/SKILL.md
      ...
  frontend/
    ...
  backend/
    ...
  smart-contract/
    ...
  research/
    ...
  devops/
    ...
  data/
    ...
  mobile/
    ...
```

## How It Works

### Profile Switching

Profile switching works by **launching a new pi process** with the correct flags. This is the only way to achieve true isolation — Pi cannot safely hot-swap its entire environment at runtime.

When you run `pi-profile use sec`:

1. The CLI reads `sec/profile.json`
2. Translates the config into pi CLI flags:
   - `--model glm-5.2`
   - `--thinking high`
   - `--append-system-prompt sec/system.md`
   - `--exclude-tools telegram_message,...`
   - `--skill sec/skills/web-pentest`
   - `--session-dir ~/.pi/agent/sessions/sec`
   - `--extension sec/extensions/scope-guard.ts`
   - `--profile sec`
3. Spawns `pi` with those flags
4. The old process exits, the new one takes over the terminal

### Package Isolation

Pi loads packages from two sources:
- **Global** `~/.pi/agent/settings.json` → `packages` array
- **Project-local** `.pi/settings.json` → `packages` array (deep-merged)

The profile system uses **`--exclude-tools`** to disable tools from packages that are globally installed but not wanted in a profile. This avoids modifying global settings.

For true package-level isolation (not loading the extension at all), use project-local `.pi/settings.json`:
```json
{
  "packages": ["npm:pi-subagents", "npm:pi-web-access"]
}
```
Then launch pi in that project directory with `--no-extensions` and selectively `--extension` flags.

### Tool Filtering

Each profile specifies `excludeTools` — a denylist of tool names to disable. This is applied via pi's `--exclude-tools` flag.

Example: `pi-sec` excludes `telegram_message` (not relevant for security work).
Example: `pi-fullstack` excludes `quick_scan`, `CaseAdd`, `ExploitSearch` (not relevant for engineering).
Example: `pi-research` excludes `edit`, `write` (read-only mode).

### System Prompt

Each profile has a `system.md` that is appended to pi's built-in system prompt via `--append-system-prompt`. This gives the agent its specialized identity and instructions.

### Session Isolation

Each profile uses its own session directory: `~/.pi/agent/sessions/<profile-name>/`. This prevents cross-profile session contamination.

### Swarm Compatibility

All profiles maintain swarm compatibility via `pi-subagents`. Each profile defines its own subagent names:

- `pi-sec`: web, api, auth, mobile, network, cloud
- `pi-fullstack`: frontend, backend, testing, reviewer
- `pi-frontend`: components, styling, testing, performance
- etc.

The swarm communication layer (pi-intercom) is separate from profile-specific tools.

## Profile Schema

See `~/.pi/agent/profiles/_common/profile-schema.json` for the full JSON Schema.

Key fields:

```json
{
  "name": "pi-sec",
  "description": "...",
  "model": "glm-5.2",
  "thinking": "high",
  "packages": ["npm:@xaccefy/pi-casefile"],
  "extensions": ["extensions/scope-guard.ts"],
  "skills": ["skills/web-pentest"],
  "systemPrompt": "system.md",
  "excludeTools": ["telegram_message"],
  "allowTools": ["read", "bash"],
  "env": { "PI_PROFILE": "sec" },
  "sessionDir": "~/.pi/agent/sessions/sec",
  "mcpServers": [{ "name": "...", "command": "..." }],
  "swarm": { "enabled": true, "subagents": ["web", "api"] },
  "scope": { "authorized": false, "targets": [], "enforce": true }
}
```

## Creating a New Profile

1. Create directory: `mkdir -p ~/.pi/agent/profiles/myprofile/skills`
2. Write `profile.json`:
   ```json
   {
     "name": "pi-myprofile",
     "description": "My custom profile",
     "model": "glm-5.2",
     "thinking": "medium",
     "packages": ["npm:pi-subagents"],
     "skills": [],
     "systemPrompt": "system.md",
     "excludeTools": [],
     "env": { "PI_PROFILE": "myprofile" },
     "swarm": { "enabled": true, "subagents": ["worker1"] }
   }
   ```
3. Write `system.md` with specialized instructions
4. Create skills in `skills/` directories
5. Run `pi-profile doctor` to validate
6. Use: `pi-profile use myprofile`

## Security

### Scope Guard (pi-sec)

The `pi-sec` profile includes a scope guard extension that:
- Tracks authorized targets (IPs, domains, CIDR ranges)
- Provides `scope_check` and `scope_set` tools
- Provides `/scope` command for quick status

Before any active testing:
```
/scope set target.com,10.0.0.0/24
```

### Third-Party Package Safety

All packages listed in profiles are inspected:
- Source: checked on npm
- Dependencies: checked for known issues
- Network behavior: packages that make unexpected network calls are noted
- Filesystem behavior: packages that write outside expected directories are noted

Each profile only loads packages that materially improve its purpose. No profile loads all 19 global packages.

## Installation

The profile system is already installed at `~/.pi/agent/profiles/`. The `pi-profile` CLI is symlinked to `/opt/homebrew/bin/pi-profile`.

To install the profiles extension into pi globally (optional — for `/profile` command inside pi):
```bash
pi install ~/.pi/agent/profiles/_common/pi-profiles.ts
```

## Tests

```bash
node ~/.pi/agent/profiles/_common/test.js
```

Current results: 51 tests, 0 failures.

## File Layout

```
~/.pi/agent/profiles/
  _common/
    profile-schema.json
    pi-profiles.ts
    pi-profile           # CLI wrapper
    test.js
    README.md
  sec/
    profile.json
    system.md
    extensions/scope-guard.ts
    skills/*/SKILL.md
  fullstack/
    profile.json
    system.md
    skills/*/SKILL.md
  frontend/
    profile.json
    system.md
    skills/*/SKILL.md
  backend/
    profile.json
    system.md
    skills/*/SKILL.md
  smart-contract/
    profile.json
    system.md
    skills/*/SKILL.md
  research/
    profile.json
    system.md
    skills/*/SKILL.md
  devops/
    profile.json
    system.md
    skills/*/SKILL.md
  data/
    profile.json
    system.md
    skills/*/SKILL.md
  mobile/
    profile.json
    system.md
    skills/*/SKILL.md
```
