/**
 * Task Manager — persistent task graph for the security swarm
 *
 * Stores tasks at ~/.pi/agent/sec-data/task-graph.json
 * Tasks are reclaimable if an agent dies mid-execution.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ════════════════════════════════════════════════════════════════════════════
//  Types
// ════════════════════════════════════════════════════════════════════════════

type TaskStatus =
  | "PENDING"
  | "CLAIMED"
  | "RUNNING"
  | "BLOCKED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

type Priority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

interface Evidence {
  timestamp: string;
  agent: string;
  note: string;
  data?: unknown;
}

interface Task {
  id: string;
  parent_task: string | null;
  owner: string | null;
  status: TaskStatus;
  priority: Priority;
  target: string | null;
  hypothesis: string;
  dependencies: string[];
  evidence: Evidence[];
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  heartbeat_at: string | null;
  estimated_cost: number;
  actual_cost: number;
  failure_reason: string | null;
}

interface TaskGraph {
  tasks: Task[];
  counter: number;
}

// ════════════════════════════════════════════════════════════════════════════
//  Persistence
// ════════════════════════════════════════════════════════════════════════════

const DATA_DIR = path.resolve(process.env.PI_SEC_DATA_DIR || ".local/reference-data");
const GRAPH_FILE = path.join(DATA_DIR, "task-graph.json");

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 min without heartbeat = orphaned

function load(): TaskGraph {
  try {
    const raw = fs.readFileSync(GRAPH_FILE, "utf8");
    const g = JSON.parse(raw) as TaskGraph;
    if (!Array.isArray(g.tasks)) g.tasks = [];
    if (typeof g.counter !== "number") g.counter = 0;
    return g;
  } catch {
    return { tasks: [], counter: 0 };
  }
}

function save(g: TaskGraph): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(GRAPH_FILE, JSON.stringify(g, null, 2), "utf8");
}

function now(): string {
  return new Date().toISOString();
}

function nextId(g: TaskGraph): string {
  g.counter += 1;
  return `T-${String(g.counter).padStart(3, "0")}`;
}

function findTask(g: TaskGraph, id: string): Task | undefined {
  return g.tasks.find((t) => t.id === id);
}

function touch(t: Task): void {
  t.updated_at = now();
}

// ════════════════════════════════════════════════════════════════════════════
//  Dependency resolution
// ════════════════════════════════════════════════════════════════════════════

function depsSatisfied(g: TaskGraph, task: Task): boolean {
  return task.dependencies.every((depId) => {
    const dep = findTask(g, depId);
    return dep && dep.status === "COMPLETED";
  });
}

function depsBlocked(g: TaskGraph, task: Task): string[] {
  return task.dependencies.filter((depId) => {
    const dep = findTask(g, depId);
    return !dep || dep.status !== "COMPLETED";
  });
}

function depFailed(g: TaskGraph, task: Task): string[] {
  return task.dependencies.filter((depId) => {
    const dep = findTask(g, depId);
    return dep && (dep.status === "FAILED" || dep.status === "CANCELLED");
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  Orphan detection
// ════════════════════════════════════════════════════════════════════════════

function isOrphaned(t: Task): boolean {
  if (t.status !== "CLAIMED" && t.status !== "RUNNING") return false;
  if (!t.heartbeat_at && t.claimed_at) {
    // No heartbeat ever — check if claimed too long ago
    return Date.now() - new Date(t.claimed_at).getTime() > STALE_THRESHOLD_MS;
  }
  if (t.heartbeat_at) {
    return Date.now() - new Date(t.heartbeat_at).getTime() > STALE_THRESHOLD_MS;
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
//  Formatting helpers
// ════════════════════════════════════════════════════════════════════════════

const PRIORITY_ORDER: Record<Priority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function priorityLabel(p: Priority): string {
  switch (p) {
    case "CRITICAL": return "\x1b[1;31mCRIT\x1b[0m";
    case "HIGH":     return "\x1b[31mHIGH \x1b[0m";
    case "MEDIUM":   return "\x1b[33mMED  \x1b[0m";
    case "LOW":      return "\x1b[34mLOW  \x1b[0m";
  }
}

function statusLabel(s: TaskStatus): string {
  switch (s) {
    case "PENDING":   return "\x1b[90mPENDING\x1b[0m";
    case "CLAIMED":   return "\x1b[36mCLAIMED\x1b[0m";
    case "RUNNING":   return "\x1b[32mRUNNING\x1b[0m";
    case "BLOCKED":   return "\x1b[35mBLOCKED\x1b[0m";
    case "COMPLETED": return "\x1b[1;32mDONE   \x1b[0m";
    case "FAILED":    return "\x1b[1;31mFAILED \x1b[0m";
    case "CANCELLED": return "\x1b[90mCANCEL \x1b[0m";
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function formatTask(t: Task): string {
  const owner = t.owner ? truncate(t.owner, 14).padEnd(14) : "—".padEnd(14);
  const target = t.target ? truncate(t.target, 24).padEnd(24) : "—".padEnd(24);
  const hyp = truncate(t.hypothesis, 50);
  return `${t.id}  ${priorityLabel(t.priority)}  ${statusLabel(t.status)}  ${owner}  ${target}  ${hyp}`;
}

// ════════════════════════════════════════════════════════════════════════════
//  Extension
// ════════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {

  // ── 1. task_create ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_create",
    description:
      "Create a new task in the security swarm task graph. Auto-generates ID (T-001, T-002, …). " +
      "Dependencies block execution until those tasks reach COMPLETED.",
    parameters: {
      type: "object",
      properties: {
        hypothesis: {
          type: "string",
          description: "What this task investigates or accomplishes (the hypothesis or goal)",
        },
        priority: {
          type: "string",
          enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
          description: "Task priority — used for claim ordering",
        },
        target: {
          type: "string",
          description: "Target scope (domain, IP, endpoint, service)",
        },
        parent_task: {
          type: "string",
          description: "ID of parent task if this is a subtask",
        },
        dependencies: {
          type: "array",
          items: { type: "string" },
          description: "Task IDs that must be COMPLETED before this task can be claimed",
        },
        owner: {
          type: "string",
          description: "Agent name to pre-assign (optional — normally left empty for open claiming)",
        },
        estimated_cost: {
          type: "number",
          description: "Estimated cost (tokens, seconds, or abstract units)",
        },
      },
      required: ["hypothesis", "priority"],
    },
    execute: async (params: any) => {
      const g = load();
      const id = nextId(g);
      const ts = now();

      const deps = params.dependencies || [];
      const blockedDeps = deps.filter((d: string) => !findTask(g, d));

      const task: Task = {
        id,
        parent_task: params.parent_task || null,
        owner: params.owner || null,
        status: deps.length > 0 ? "BLOCKED" : "PENDING",
        priority: params.priority,
        target: params.target || null,
        hypothesis: params.hypothesis,
        dependencies: deps,
        evidence: [],
        created_at: ts,
        updated_at: ts,
        claimed_at: null,
        heartbeat_at: null,
        estimated_cost: params.estimated_cost || 0,
        actual_cost: 0,
        failure_reason: null,
      };

      // If deps exist but some are already completed, check if we can unblock
      if (deps.length > 0 && depsSatisfied(g, task)) {
        task.status = "PENDING";
      }

      // If any dependency FAILED or CANCELLED, mark the task as BLOCKED permanently
      const failedDeps = depFailed(g, task);
      if (failedDeps.length > 0) {
        task.status = "BLOCKED";
      }

      g.tasks.push(task);
      save(g);

      const blockedMsg =
        blockedDeps.length > 0
          ? ` (blocked on: ${blockedDeps.join(", ")})`
          : "";

      return {
        content: JSON.stringify({
          ok: true,
          id: task.id,
          status: task.status,
          message: `Task ${task.id} created${blockedMsg}`,
        }, null, 2),
      };
    },
  });

  // ── 2. task_claim ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_claim",
    description:
      "Claim a task for an agent. The agent becomes the owner and the task moves to CLAIMED. " +
      "If no task_id is given, auto-selects the highest-priority PENDING task. " +
      "Call task_update with heartbeat=true periodically to show the agent is alive. " +
      "Orphaned tasks (no heartbeat for 5 min) can be reclaimed via task_reclaim.",
    parameters: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "Specific task ID to claim (optional — if omitted, auto-selects best PENDING task)",
        },
        agent: {
          type: "string",
          description: "Agent name claiming the task (e.g. 'recon:subdomain', 'api', 'validator')",
        },
      },
      required: ["agent"],
    },
    execute: async (params: any) => {
      const g = load();

      // Auto-select if no task_id
      if (!params.task_id) {
        const pending = g.tasks
          .filter((t) => t.status === "PENDING")
          .sort((a, b) => {
            const pri = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
            if (pri !== 0) return pri;
            return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
          });

        if (pending.length === 0) {
          return {
            content: JSON.stringify({
              ok: false,
              message: "No PENDING tasks available to claim",
            }, null, 2),
          };
        }
        params.task_id = pending[0].id;
      }

      const task = findTask(g, params.task_id);
      if (!task) {
        return { content: JSON.stringify({ ok: false, error: `Task ${params.task_id} not found` }, null, 2) };
      }

      if (task.status === "COMPLETED" || task.status === "CANCELLED") {
        return {
          content: JSON.stringify({
            ok: false,
            error: `Task ${task.id} is ${task.status} — cannot claim`,
          }, null, 2),
        };
      }

      if (task.status === "BLOCKED") {
        const blocked = depsBlocked(g, task);
        return {
          content: JSON.stringify({
            ok: false,
            error: `Task ${task.id} is BLOCKED on dependencies: ${blocked.join(", ")}`,
            blocked_deps: blocked,
          }, null, 2),
        };
      }

      // Check if already claimed by another agent and not orphaned
      if (
        task.owner &&
        task.owner !== params.agent &&
        (task.status === "CLAIMED" || task.status === "RUNNING") &&
        !isOrphaned(task)
      ) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `Task ${task.id} is owned by ${task.owner} (${task.status})`,
          }, null, 2),
        };
      }

      // Check dependencies are satisfied
      if (!depsSatisfied(g, task)) {
        const blocked = depsBlocked(g, task);
        task.status = "BLOCKED";
        touch(task);
        save(g);
        return {
          content: JSON.stringify({
            ok: false,
            error: `Task ${task.id} dependencies not satisfied: ${blocked.join(", ")}`,
            blocked_deps: blocked,
          }, null, 2),
        };
      }

      // Claim it
      const wasOrphaned = isOrphaned(task);
      task.owner = params.agent;
      task.status = "CLAIMED";
      task.claimed_at = now();
      task.heartbeat_at = now();
      touch(task);
      save(g);

      return {
        content: JSON.stringify({
          ok: true,
          id: task.id,
          owner: task.owner,
          status: task.status,
          reclaimed: wasOrphaned,
          priority: task.priority,
          target: task.target,
          hypothesis: task.hypothesis,
          dependencies: task.dependencies,
          message: wasOrphaned
            ? `Task ${task.id} reclaimed from orphaned state by ${params.agent}`
            : `Task ${task.id} claimed by ${params.agent}`,
        }, null, 2),
      };
    },
  });

  // ── 3. task_update ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_update",
    description:
      "Update a task's status, add evidence, or send a heartbeat. " +
      "Set status=RUNNING when work starts. " +
      "Set heartbeat=true periodically to show the agent is alive (prevents orphan reclamation). " +
      "Set status=COMPLETED or FAILED when done (optionally with evidence).",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to update" },
        status: {
          type: "string",
          enum: ["PENDING", "CLAIMED", "RUNNING", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED"],
          description: "New status (optional)",
        },
        evidence: {
          type: "string",
          description: "Evidence note to append (e.g. finding summary, command output, reasoning)",
        },
        evidence_data: {
          type: "string",
          description: "Structured evidence data (JSON string — will be parsed)",
        },
        heartbeat: {
          type: "boolean",
          description: "Set to true to update heartbeat timestamp without changing status",
        },
        actual_cost: {
          type: "number",
          description: "Actual cost incurred (accumulates)",
        },
        failure_reason: {
          type: "string",
          description: "Reason for failure (when status=FAILED)",
        },
      },
      required: ["task_id"],
    },
    execute: async (params: any) => {
      const g = load();
      const task = findTask(g, params.task_id);
      if (!task) {
        return { content: JSON.stringify({ ok: false, error: `Task ${params.task_id} not found` }, null, 2) };
      }

      const updates: string[] = [];

      // Heartbeat
      if (params.heartbeat) {
        task.heartbeat_at = now();
        touch(task);
        // Don't change status on heartbeat alone, but ensure it's at least CLAIMED
        if (task.status === "PENDING") {
          task.status = "CLAIMED";
          updates.push("status: PENDING → CLAIMED (heartbeat)");
        }
        updates.push("heartbeat refreshed");
      }

      // Status change
      if (params.status && params.status !== task.status) {
        const oldStatus = task.status;
        const newStatus = params.status as TaskStatus;

        // Validate transitions
        if (newStatus === "COMPLETED") {
          // Check deps are done
          if (!depsSatisfied(g, task)) {
            return {
              content: JSON.stringify({
                ok: false,
                error: `Cannot complete ${task.id} — dependencies not satisfied: ${depsBlocked(g, task).join(", ")}`,
              }, null, 2),
            };
          }
          task.status = "COMPLETED";
        } else if (newStatus === "RUNNING") {
          if (task.status !== "CLAIMED" && task.status !== "RUNNING") {
            return {
              content: JSON.stringify({
                ok: false,
                error: `Cannot set RUNNING — task ${task.id} is ${task.status} (must be CLAIMED first)`,
              }, null, 2),
            };
          }
          task.status = "RUNNING";
        } else if (newStatus === "FAILED") {
          task.status = "FAILED";
          task.failure_reason = params.failure_reason || "Unspecified failure";
        } else if (newStatus === "CANCELLED") {
          task.status = "CANCELLED";
        } else if (newStatus === "BLOCKED") {
          task.status = "BLOCKED";
        } else if (newStatus === "PENDING") {
          // Re-queue a claimed/running task (release ownership)
          task.status = "PENDING";
          task.owner = null;
          task.claimed_at = null;
          task.heartbeat_at = null;
        } else {
          task.status = newStatus;
        }

        updates.push(`status: ${oldStatus} → ${task.status}`);
      }

      // Evidence
      if (params.evidence) {
        const ev: Evidence = {
          timestamp: now(),
          agent: task.owner || "unknown",
          note: params.evidence,
        };
        if (params.evidence_data) {
          try {
            ev.data = JSON.parse(params.evidence_data);
          } catch {
            ev.data = params.evidence_data;
          }
        }
        task.evidence.push(ev);
        updates.push(`evidence added: "${truncate(params.evidence, 60)}"`);
      }

      // Cost
      if (typeof params.actual_cost === "number") {
        task.actual_cost += params.actual_cost;
        updates.push(`cost +${params.actual_cost} (total: ${task.actual_cost})`);
      }

      // Check if any blocked tasks can now be unblocked
      let unblocked: string[] = [];
      if (task.status === "COMPLETED") {
        for (const other of g.tasks) {
          if (other.status === "BLOCKED" && other.dependencies.includes(task.id)) {
            if (depsSatisfied(g, other)) {
              other.status = "PENDING";
              touch(other);
              unblocked.push(other.id);
            }
          }
        }
      }

      // Check if any tasks should be auto-failed due to dependency failure
      let cascadedFail: string[] = [];
      if (task.status === "FAILED" || task.status === "CANCELLED") {
        for (const other of g.tasks) {
          if (
            (other.status === "PENDING" || other.status === "BLOCKED") &&
            other.dependencies.includes(task.id)
          ) {
            other.status = "BLOCKED";
            touch(other);
            cascadedFail.push(other.id);
          }
        }
      }

      touch(task);
      save(g);

      return {
        content: JSON.stringify({
          ok: true,
          id: task.id,
          status: task.status,
          owner: task.owner,
          updates,
          unblocked,
          cascaded_block: cascadedFail,
          evidence_count: task.evidence.length,
        }, null, 2),
      };
    },
  });

  // ── 4. task_list ────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_list",
    description:
      "List tasks in the task graph. Filter by status, owner, or priority. " +
      "Returns tasks sorted by priority (CRITICAL first) then by creation time.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["PENDING", "CLAIMED", "RUNNING", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED"],
          description: "Filter by status",
        },
        owner: {
          type: "string",
          description: "Filter by owner/agent name",
        },
        priority: {
          type: "string",
          enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
          description: "Filter by priority",
        },
        target: {
          type: "string",
          description: "Filter by target (substring match)",
        },
        limit: {
          type: "number",
          description: "Max results (default 50)",
        },
      },
    },
    execute: async (params: any) => {
      const g = load();
      let tasks = g.tasks;

      if (params.status) tasks = tasks.filter((t) => t.status === params.status);
      if (params.owner) tasks = tasks.filter((t) => t.owner === params.owner);
      if (params.priority) tasks = tasks.filter((t) => t.priority === params.priority);
      if (params.target) tasks = tasks.filter((t) => t.target && t.target.includes(params.target));

      tasks.sort((a, b) => {
        const pri = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (pri !== 0) return pri;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

      const limit = params.limit || 50;
      tasks = tasks.slice(0, limit);

      const result = tasks.map((t) => ({
        id: t.id,
        status: t.status,
        priority: t.priority,
        owner: t.owner,
        target: t.target,
        hypothesis: t.hypothesis,
        dependencies: t.dependencies,
        created_at: t.created_at,
        updated_at: t.updated_at,
        evidence_count: t.evidence.length,
        estimated_cost: t.estimated_cost,
        actual_cost: t.actual_cost,
      }));

      return {
        content: JSON.stringify({
          count: result.length,
          total_in_graph: g.tasks.length,
          tasks: result,
        }, null, 2),
      };
    },
  });

  // ── 5. task_get ──────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_get",
    description: "Get full details of a single task including all evidence entries.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" },
      },
      required: ["task_id"],
    },
    execute: async (params: any) => {
      const g = load();
      const task = findTask(g, params.task_id);
      if (!task) {
        return { content: JSON.stringify({ ok: false, error: `Task ${params.task_id} not found` }, null, 2) };
      }

      // Include dependency status info
      const depInfo = task.dependencies.map((depId) => {
        const dep = findTask(g, depId);
        return {
          id: depId,
          status: dep?.status || "MISSING",
          completed: dep?.status === "COMPLETED",
        };
      });

      // Include child tasks
      const children = g.tasks
        .filter((t) => t.parent_task === task.id)
        .map((t) => ({ id: t.id, status: t.status, hypothesis: t.hypothesis }));

      return {
        content: JSON.stringify({
          ...task,
          dependency_status: depInfo,
          child_tasks: children,
          orphaned: isOrphaned(task),
        }, null, 2),
      };
    },
  });

  // ── 6. task_reclaim ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_reclaim",
    description:
      "Reclaim orphaned tasks — tasks that were CLAIMED or RUNNING but whose agent " +
      "stopped sending heartbeats (>5 min stale). " +
      "Reclaims by: (a) a specific agent reclaiming a specific task, " +
      "(b) an agent reclaiming all orphaned tasks it wants, " +
      "(c) scanning for all orphans and resetting them to PENDING for re-claiming.",
    parameters: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "Specific task ID to reclaim (optional)",
        },
        agent: {
          type: "string",
          description: "Agent claiming the orphaned task (required if reclaiming a specific task)",
        },
        scan_only: {
          type: "boolean",
          description: "If true, only scan and report orphans without reclaiming (default: false)",
        },
        reset_all: {
          type: "boolean",
          description: "If true, reset ALL orphaned tasks to PENDING (releasing ownership). Default: false.",
        },
        stale_threshold_min: {
          type: "number",
          description: "Override stale threshold in minutes (default: 5)",
        },
      },
    },
    execute: async (params: any) => {
      const g = load();

      const thresholdMs =
        (params.stale_threshold_min || 5) * 60 * 1000;

      // Custom orphan check with override threshold
      const checkOrphan = (t: Task): boolean => {
        if (t.status !== "CLAIMED" && t.status !== "RUNNING") return false;
        const ref = t.heartbeat_at || t.claimed_at;
        if (!ref) return false;
        return Date.now() - new Date(ref).getTime() > thresholdMs;
      };

      const orphans = g.tasks.filter(checkOrphan);

      if (params.scan_only) {
        return {
          content: JSON.stringify({
            ok: true,
            orphan_count: orphans.length,
            orphans: orphans.map((t) => ({
              id: t.id,
              owner: t.owner,
              status: t.status,
              last_heartbeat: t.heartbeat_at,
              claimed_at: t.claimed_at,
              hypothesis: t.hypothesis,
              stale_for_min: t.heartbeat_at
                ? Math.round((Date.now() - new Date(t.heartbeat_at).getTime()) / 60000)
                : t.claimed_at
                  ? Math.round((Date.now() - new Date(t.claimed_at).getTime()) / 60000)
                  : 0,
            })),
          }, null, 2),
        };
      }

      // Reclaim specific task
      if (params.task_id) {
        const task = findTask(g, params.task_id);
        if (!task) {
          return { content: JSON.stringify({ ok: false, error: `Task ${params.task_id} not found` }, null, 2) };
        }
        if (!checkOrphan(task)) {
          return {
            content: JSON.stringify({
              ok: false,
              error: `Task ${task.id} is not orphaned (status: ${task.status}, last heartbeat: ${task.heartbeat_at})`,
            }, null, 2),
          };
        }
        if (!params.agent) {
          return { content: JSON.stringify({ ok: false, error: "Agent name required to reclaim a task" }, null, 2) };
        }

        const oldOwner = task.owner;
        task.owner = params.agent;
        task.status = "CLAIMED";
        task.claimed_at = now();
        task.heartbeat_at = now();
        touch(task);
        save(g);

        return {
          content: JSON.stringify({
            ok: true,
            id: task.id,
            previous_owner: oldOwner,
            new_owner: task.owner,
            status: task.status,
            message: `Task ${task.id} reclaimed from ${oldOwner} by ${params.agent}`,
          }, null, 2),
        };
      }

      // Reset all orphans to PENDING
      if (params.reset_all) {
        const reset: string[] = [];
        for (const task of orphans) {
          const oldOwner = task.owner;
          task.owner = null;
          task.status = "PENDING";
          task.claimed_at = null;
          task.heartbeat_at = null;
          touch(task);
          reset.push(`${task.id} (was ${oldOwner})`);
        }
        save(g);

        return {
          content: JSON.stringify({
            ok: true,
            reset_count: reset.length,
            reset_tasks: reset,
            message: `Reset ${reset.length} orphaned tasks to PENDING`,
          }, null, 2),
        };
      }

      // Default: if agent provided, reclaim highest-priority orphan
      if (params.agent && orphans.length > 0) {
        orphans.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
        const task = orphans[0];
        const oldOwner = task.owner;
        task.owner = params.agent;
        task.status = "CLAIMED";
        task.claimed_at = now();
        task.heartbeat_at = now();
        touch(task);
        save(g);

        return {
          content: JSON.stringify({
            ok: true,
            id: task.id,
            previous_owner: oldOwner,
            new_owner: task.owner,
            status: task.status,
            message: `Task ${task.id} reclaimed from ${oldOwner} by ${params.agent}`,
          }, null, 2),
        };
      }

      // No orphans or no action specified
      return {
        content: JSON.stringify({
          ok: true,
          orphan_count: orphans.length,
          message: orphans.length === 0
            ? "No orphaned tasks found"
            : `${orphans.length} orphaned tasks found. Use reset_all=true to reset them to PENDING, or provide task_id + agent to reclaim a specific one.`,
        }, null, 2),
      };
    },
  });

  // ── 7. task_block ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_block",
    description:
      "Block a task on its dependencies, or check why a task is blocked. " +
      "When a task is blocked, it cannot be claimed until all dependencies reach COMPLETED. " +
      "If any dependency has FAILED or been CANCELLED, the task is permanently blocked.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to block or check" },
        add_dependencies: {
          type: "array",
          items: { type: "string" },
          description: "Add these task IDs as dependencies",
        },
        check_only: {
          type: "boolean",
          description: "If true, only report dependency status without modifying (default: false)",
        },
      },
      required: ["task_id"],
    },
    execute: async (params: any) => {
      const g = load();
      const task = findTask(g, params.task_id);
      if (!task) {
        return { content: JSON.stringify({ ok: false, error: `Task ${params.task_id} not found` }, null, 2) };
      }

      // Add new dependencies
      if (!params.check_only && params.add_dependencies && params.add_dependencies.length > 0) {
        const existing = new Set(task.dependencies);
        const added: string[] = [];
        for (const depId of params.add_dependencies) {
          if (!existing.has(depId)) {
            // Verify the dependency exists
            const dep = findTask(g, depId);
            if (!dep) {
              return {
                content: JSON.stringify({
                  ok: false,
                  error: `Dependency ${depId} does not exist in the task graph`,
                }, null, 2),
              };
            }
            task.dependencies.push(depId);
            existing.add(depId);
            added.push(depId);
          }
        }

        // Re-evaluate status
        if (!depsSatisfied(g, task)) {
          task.status = "BLOCKED";
        }
        touch(task);
        save(g);
      }

      // Report dependency status
      const depStatus = task.dependencies.map((depId) => {
        const dep = findTask(g, depId);
        return {
          id: depId,
          status: dep?.status || "MISSING",
          completed: dep?.status === "COMPLETED",
          failed: dep?.status === "FAILED" || dep?.status === "CANCELLED",
          hypothesis: dep?.hypothesis || null,
        };
      });

      const blocked = depsBlocked(g, task);
      const failed = depFailed(g, task);
      const satisfied = depsSatisfied(g, task);

      return {
        content: JSON.stringify({
          ok: true,
          id: task.id,
          status: task.status,
          dependencies: depStatus,
          unsatisfied: blocked,
          failed_deps: failed,
          all_satisfied: satisfied,
          permanently_blocked: failed.length > 0,
          message: failed.length > 0
            ? `Task ${task.id} is permanently blocked — dependencies FAILED/CANCELLED: ${failed.join(", ")}`
            : blocked.length > 0
              ? `Task ${task.id} is blocked on: ${blocked.join(", ")}`
              : `Task ${task.id} dependencies are all satisfied`,
        }, null, 2),
      };
    },
  });

  // ── Command: /tasks ─────────────────────────────────────────────────────────
  pi.registerCommand("tasks", {
    description: "Task graph dashboard — show counts by status and latest assignments",
    handler: async (args: string) => {
      const g = load();
      const tasks = g.tasks;

      if (tasks.length === 0) {
        return [
          "",
          "  ╔══════════════════════════════════════════╗",
          "  ║       Task Graph — Empty                 ║",
          "  ╚══════════════════════════════════════════╝",
          "",
          "  No tasks created yet.",
          "  Use task_create to add the first task.",
          "",
        ].join("\n");
      }

      const counts: Record<string, number> = {
        PENDING: 0,
        CLAIMED: 0,
        RUNNING: 0,
        BLOCKED: 0,
        COMPLETED: 0,
        FAILED: 0,
        CANCELLED: 0,
      };
      for (const t of tasks) {
        counts[t.status] = (counts[t.status] || 0) + 1;
      }

      // Detect orphans
      const orphans = tasks.filter(isOrphaned);

      // Latest assignments (CLAIMED or RUNNING, sorted by updated_at desc)
      const active = tasks
        .filter((t) => t.status === "CLAIMED" || t.status === "RUNNING")
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
        .slice(0, 10);

      // Pending by priority
      const pending = tasks
        .filter((t) => t.status === "PENDING")
        .sort((a, b) => {
          const pri = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
          if (pri !== 0) return pri;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        })
        .slice(0, 10);

      // Recently completed
      const recent = tasks
        .filter((t) => t.status === "COMPLETED" || t.status === "FAILED")
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
        .slice(0, 5);

      const lines: string[] = [
        "",
        "  ╔══════════════════════════════════════════════════════════════╗",
        "  ║              Security Swarm — Task Graph                     ║",
        "  ╚══════════════════════════════════════════════════════════════╝",
        "",
        "  Overview",
        `    Total:       ${tasks.length}`,
        `    \x1b[90mPENDING\x1b[0m:    ${counts.PENDING}`,
        `    \x1b[36mCLAIMED\x1b[0m:    ${counts.CLAIMED}`,
        `    \x1b[32mRUNNING\x1b[0m:    ${counts.RUNNING}`,
        `    \x1b[35mBLOCKED\x1b[0m:    ${counts.BLOCKED}`,
        `    \x1b[1;32mCOMPLETED\x1b[0m: ${counts.COMPLETED}`,
        `    \x1b[1;31mFAILED\x1b[0m:    ${counts.FAILED}`,
        `    \x1b[90mCANCELLED\x1b[0m: ${counts.CANCELLED}`,
      ];

      if (orphans.length > 0) {
        lines.push("");
        lines.push(`  \x1b[1;33m⚠  ${orphans.length} ORPHANED TASK(S) — agents stopped heartbeating\x1b[0m`);
        for (const t of orphans) {
          const staleMin = t.heartbeat_at
            ? Math.round((Date.now() - new Date(t.heartbeat_at).getTime()) / 60000)
            : "?";
          lines.push(`     ${t.id}  owner=${t.owner}  stale=${staleMin}min  "${truncate(t.hypothesis, 40)}"`);
        }
        lines.push("  → Use task_reclaim with reset_all=true to re-queue them");
      }

      if (active.length > 0) {
        lines.push("");
        lines.push("  Active Assignments");
        lines.push("  " + "─".repeat(76));
        lines.push("  " + "ID       PRI    STATUS   OWNER           TARGET                        HYPOTHESIS".padEnd(76));
        lines.push("  " + "─".repeat(76));
        for (const t of active) {
          lines.push("  " + formatTask(t));
        }
      }

      if (pending.length > 0) {
        lines.push("");
        lines.push("  Pending (ready to claim)");
        lines.push("  " + "─".repeat(76));
        for (const t of pending) {
          lines.push("  " + formatTask(t));
        }
        if (counts.PENDING > pending.length) {
          lines.push(`  … and ${counts.PENDING - pending.length} more pending`);
        }
      }

      if (recent.length > 0) {
        lines.push("");
        lines.push("  Recently Finished");
        lines.push("  " + "─".repeat(76));
        for (const t of recent) {
          lines.push("  " + formatTask(t));
        }
      }

      if (args.trim() === "blocked" && counts.BLOCKED > 0) {
        const blockedTasks = tasks.filter((t) => t.status === "BLOCKED");
        lines.push("");
        lines.push("  Blocked Tasks (detail)");
        lines.push("  " + "─".repeat(76));
        for (const t of blockedTasks) {
          const blocked = depsBlocked(g, t);
          const failed = depFailed(g, t);
          lines.push(`  ${t.id}  ${truncate(t.hypothesis, 40)}`);
          lines.push(`         blocked on: ${blocked.join(", ") || "(none)"}`);
          if (failed.length > 0) {
            lines.push(`         \x1b[31mfailed deps: ${failed.join(", ")}\x1b[0m`);
          }
        }
      }

      if (args.trim() === "orphans") {
        lines.push("");
        lines.push("  Orphan Scan");
        lines.push("  " + "─".repeat(76));
        if (orphans.length === 0) {
          lines.push("  No orphaned tasks. All agents are alive.");
        } else {
          for (const t of orphans) {
            const staleMin = t.heartbeat_at
              ? Math.round((Date.now() - new Date(t.heartbeat_at).getTime()) / 60000)
              : "?";
            lines.push(`  ${t.id}  owner=${t.owner}  stale=${staleMin}min  ${truncate(t.hypothesis, 40)}`);
          }
        }
      }

      lines.push("");
      return lines.join("\n");
    },
  });
}
