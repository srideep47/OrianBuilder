import { classifyTaskFailure, chooseRecovery } from "./failure_recovery";
import { ResourceLeaseManager } from "./resource_leases";

export type GoalStatus =
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export type GoalNodeStatus =
  | "queued"
  | "waiting"
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface GoalNodeDefinition {
  id: string;
  title: string;
  kind: "action" | "delegate" | "verification";
  operation: string;
  input?: Record<string, unknown>;
  dependencies?: string[];
  resources?: string[];
  priority?: number;
  maxAttempts?: number;
  reversible?: boolean;
}

export interface GoalDefinition {
  id: string;
  title: string;
  userRequest: string;
  maxConcurrency?: number;
  nodes: GoalNodeDefinition[];
}

export interface GoalNodeState extends GoalNodeDefinition {
  status: GoalNodeStatus;
  attempt: number;
  priority: number;
  phase?: string;
  summary?: string;
  error?: string;
  waitingFor?: string[];
  startedAt?: number;
  completedAt?: number;
}

export interface GoalSnapshot {
  id: string;
  title: string;
  userRequest: string;
  status: GoalStatus;
  maxConcurrency: number;
  nodes: GoalNodeState[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface GoalNodeResult {
  ok: boolean;
  summary: string;
  /** Explicit false means the worker completed but acceptance failed. */
  verified?: boolean;
  error?: string;
}

export interface GoalExecutionContext {
  signal: AbortSignal;
  attempt: number;
}

export type GoalNodeExecutor = (
  node: GoalNodeDefinition,
  context: GoalExecutionContext,
) => Promise<GoalNodeResult>;

export interface ExecutiveEvent {
  goalId: string;
  nodeId?: string;
  type:
    | "goal-created"
    | "goal-started"
    | "goal-paused"
    | "goal-resumed"
    | "goal-finished"
    | "node-started"
    | "node-waiting"
    | "node-retrying"
    | "node-verifying"
    | "node-finished";
  status: GoalStatus | GoalNodeStatus;
  summary: string;
  timestamp: number;
}

interface InternalGoal extends GoalSnapshot {
  controller?: AbortController;
  completion?: Promise<GoalSnapshot>;
  wake?: () => void;
  /** Per-node cancellation keeps one workstream independent from the goal. */
  nodeControllers?: Map<string, AbortController>;
}

function copyNode(node: GoalNodeState): GoalNodeState {
  return {
    ...node,
    input: node.input ? { ...node.input } : undefined,
    dependencies: node.dependencies ? [...node.dependencies] : undefined,
    resources: node.resources ? [...node.resources] : undefined,
    waitingFor: node.waitingFor ? [...node.waitingFor] : undefined,
  };
}

function publicSnapshot(goal: InternalGoal): GoalSnapshot {
  return {
    id: goal.id,
    title: goal.title,
    userRequest: goal.userRequest,
    status: goal.status,
    maxConcurrency: goal.maxConcurrency,
    nodes: goal.nodes.map(copyNode),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    completedAt: goal.completedAt,
  };
}

function validateDefinition(definition: GoalDefinition): void {
  if (!definition.id.trim() || !definition.title.trim()) {
    throw new Error("A goal requires a stable id and title.");
  }
  if (definition.nodes.length === 0) {
    throw new Error("A goal requires at least one node.");
  }
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (!node.id.trim()) throw new Error("Every goal node requires an id.");
    if (ids.has(node.id)) throw new Error(`Duplicate goal node: ${node.id}`);
    ids.add(node.id);
  }
  for (const node of definition.nodes) {
    for (const dependency of node.dependencies ?? []) {
      if (!ids.has(dependency)) {
        throw new Error(`${node.id} depends on missing node ${dependency}.`);
      }
      if (dependency === node.id) {
        throw new Error(`${node.id} cannot depend on itself.`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error("Goal graph contains a cycle.");
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? [])
      visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

/**
 * Deterministic DAG scheduler behind Marta's conversational front end.
 *
 * Models propose work; this class owns concurrency, dependencies, leases,
 * retries, cancellation, and the actual terminal state.
 */
export class ParallelExecutive {
  private readonly goals = new Map<string, InternalGoal>();
  private readonly leaseUnsubscribe: () => void;

  constructor(
    private readonly executeNode: GoalNodeExecutor,
    private readonly onEvent: (event: ExecutiveEvent) => void = () => {},
    private readonly leases = new ResourceLeaseManager(),
    private readonly now: () => number = Date.now,
  ) {
    this.leaseUnsubscribe = this.leases.subscribe(() => this.wakeAll());
  }

  dispose(): void {
    this.leaseUnsubscribe();
    for (const goal of this.goals.values()) goal.controller?.abort();
  }

  createGoal(definition: GoalDefinition): GoalSnapshot {
    validateDefinition(definition);
    if (this.goals.has(definition.id)) {
      throw new Error(`Goal ${definition.id} already exists.`);
    }
    const at = this.now();
    const goal: InternalGoal = {
      id: definition.id,
      title: definition.title,
      userRequest: definition.userRequest,
      status: "queued",
      maxConcurrency: Math.max(1, Math.min(16, definition.maxConcurrency ?? 3)),
      nodes: definition.nodes.map((node) => ({
        ...node,
        dependencies: [...(node.dependencies ?? [])],
        resources: [...(node.resources ?? [])],
        priority: node.priority ?? 0,
        maxAttempts: Math.max(1, Math.min(5, node.maxAttempts ?? 2)),
        reversible: node.reversible ?? true,
        status: "queued" as const,
        attempt: 0,
      })),
      createdAt: at,
      updatedAt: at,
      nodeControllers: new Map(),
    };
    this.goals.set(goal.id, goal);
    this.emit(goal, undefined, "goal-created", "Goal queued.");
    return publicSnapshot(goal);
  }

  /** Restore a persisted graph. In-flight work becomes paused and resumable. */
  restoreGoal(snapshot: GoalSnapshot): GoalSnapshot {
    validateDefinition({
      id: snapshot.id,
      title: snapshot.title,
      userRequest: snapshot.userRequest,
      maxConcurrency: snapshot.maxConcurrency,
      nodes: snapshot.nodes,
    });
    if (this.goals.has(snapshot.id)) return this.getGoal(snapshot.id)!;
    const interrupted = ["queued", "running", "paused"].includes(
      snapshot.status,
    );
    const restored: InternalGoal = {
      ...snapshot,
      status: interrupted ? "paused" : snapshot.status,
      nodes: snapshot.nodes.map((node) => ({
        ...copyNode(node),
        status: ["running", "verifying"].includes(node.status)
          ? "queued"
          : node.status,
        phase: ["running", "verifying"].includes(node.status)
          ? "Interrupted; ready to resume"
          : node.phase,
      })),
      updatedAt: this.now(),
      completedAt: interrupted ? undefined : snapshot.completedAt,
      nodeControllers: new Map(),
    };
    this.goals.set(restored.id, restored);
    return publicSnapshot(restored);
  }

  getGoal(id: string): GoalSnapshot | null {
    const goal = this.goals.get(id);
    return goal ? publicSnapshot(goal) : null;
  }

  listGoals(): GoalSnapshot[] {
    return [...this.goals.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(publicSnapshot);
  }

  runGoal(id: string): Promise<GoalSnapshot> {
    const goal = this.requireGoal(id);
    if (goal.completion) return goal.completion;
    if (["succeeded", "failed", "cancelled"].includes(goal.status)) {
      return Promise.resolve(publicSnapshot(goal));
    }
    goal.controller = new AbortController();
    goal.status = "running";
    goal.updatedAt = this.now();
    this.emit(goal, undefined, "goal-started", "Goal started.");
    goal.completion = this.schedule(goal, goal.controller.signal).finally(
      () => {
        goal.completion = undefined;
        goal.controller = undefined;
      },
    );
    return goal.completion;
  }

  control(
    id: string,
    command:
      | { action: "pause" | "resume" | "cancel" }
      | { action: "prioritize"; nodeId: string; priority: number }
      | { action: "cancel-node"; nodeId: string },
  ): GoalSnapshot {
    const goal = this.requireGoal(id);
    if (command.action === "pause" && goal.status === "running") {
      goal.status = "paused";
      this.emit(
        goal,
        undefined,
        "goal-paused",
        "Goal paused after current work.",
      );
    } else if (command.action === "resume" && goal.status === "paused") {
      goal.status = "running";
      this.emit(goal, undefined, "goal-resumed", "Goal resumed.");
      if (!goal.completion) void this.runGoal(id);
    } else if (command.action === "cancel") {
      goal.status = "cancelled";
      goal.controller?.abort();
    } else if (command.action === "prioritize") {
      const node = this.requireNode(goal, command.nodeId);
      node.priority = command.priority;
      goal.updatedAt = this.now();
    } else if (command.action === "cancel-node") {
      const node = this.requireNode(goal, command.nodeId);
      if (!["succeeded", "failed"].includes(node.status)) {
        goal.nodeControllers?.get(node.id)?.abort();
        node.status = "cancelled";
        node.completedAt = this.now();
        this.leases.release(`${goal.id}:${node.id}`);
      }
    }
    goal.wake?.();
    return publicSnapshot(goal);
  }

  private async schedule(
    goal: InternalGoal,
    signal: AbortSignal,
  ): Promise<GoalSnapshot> {
    const active = new Map<string, Promise<void>>();

    while (true) {
      if (signal.aborted || goal.status === "cancelled") {
        goal.status = "cancelled";
        for (const node of goal.nodes) {
          if (!["succeeded", "failed", "cancelled"].includes(node.status)) {
            node.status = "cancelled";
            node.completedAt = this.now();
          }
          this.leases.release(`${goal.id}:${node.id}`);
        }
        break;
      }

      this.cancelNodesWithFailedDependencies(goal);

      if (goal.status !== "paused") {
        const candidates = goal.nodes
          .filter(
            (node) =>
              ["queued", "waiting"].includes(node.status) &&
              (node.dependencies ?? []).every(
                (dependency) =>
                  this.requireNode(goal, dependency).status === "succeeded",
              ),
          )
          .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

        for (const node of candidates) {
          if (active.size >= goal.maxConcurrency) break;
          const owner = `${goal.id}:${node.id}`;
          const acquisition = this.leases.acquire(owner, node.resources ?? []);
          if (!acquisition.ok) {
            const waitingFor = acquisition.conflicts.map(
              (conflict) => `${conflict.key} (${conflict.owner})`,
            );
            if (
              node.status !== "waiting" ||
              node.waitingFor?.join("|") !== waitingFor.join("|")
            ) {
              node.status = "waiting";
              node.waitingFor = waitingFor;
              this.emit(
                goal,
                node,
                "node-waiting",
                `Waiting for ${waitingFor.join(", ")}.`,
              );
            }
            continue;
          }

          node.status = "running";
          node.waitingFor = undefined;
          node.attempt += 1;
          node.startedAt ??= this.now();
          this.emit(goal, node, "node-started", `Started ${node.title}.`);
          const controller = new AbortController();
          goal.nodeControllers ??= new Map();
          goal.nodeControllers.set(node.id, controller);
          const abortNode = (): void => controller.abort();
          signal.addEventListener("abort", abortNode, { once: true });
          // A coding or media task can legitimately outlive the lease TTL.
          // Renew ownership while it is making progress so a second goal never
          // enters the same GPU, preview port or git index concurrently.
          const leaseHeartbeat = setInterval(
            () => this.leases.heartbeat(owner),
            30_000,
          );
          const execution = this.runNode(goal, node, controller.signal).finally(
            () => {
              active.delete(node.id);
              clearInterval(leaseHeartbeat);
              signal.removeEventListener("abort", abortNode);
              goal.nodeControllers?.delete(node.id);
              this.leases.release(owner);
              goal.wake?.();
            },
          );
          active.set(node.id, execution);
        }
      }

      const unfinished = goal.nodes.some((node) =>
        ["queued", "waiting", "running", "verifying"].includes(node.status),
      );
      if (!unfinished && active.size === 0) break;
      if (active.size > 0) {
        await Promise.race(active.values());
      } else {
        await this.waitForWake(goal, 250);
      }
    }

    goal.completedAt = this.now();
    goal.updatedAt = goal.completedAt;
    if (goal.status !== "cancelled") {
      goal.status = goal.nodes.every((node) => node.status === "succeeded")
        ? "succeeded"
        : "failed";
    }
    this.emit(
      goal,
      undefined,
      "goal-finished",
      goal.status === "succeeded"
        ? "Goal verified and completed."
        : goal.status === "cancelled"
          ? "Goal cancelled."
          : "Goal stopped with failed work.",
    );
    return publicSnapshot(goal);
  }

  private async runNode(
    goal: InternalGoal,
    node: GoalNodeState,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const result = await this.executeNode(copyNode(node), {
        signal,
        attempt: node.attempt,
      });
      if (signal.aborted) return;

      node.summary = result.summary;
      if (result.ok) {
        node.status = "verifying";
        node.phase = "Verifying result";
        this.emit(goal, node, "node-verifying", `Verifying ${node.title}.`);
      }
      if (result.ok && result.verified !== false) {
        node.status = "succeeded";
        node.error = undefined;
        node.completedAt = this.now();
        this.emit(goal, node, "node-finished", `${node.title} completed.`);
        return;
      }

      const message =
        result.error ??
        (result.verified === false
          ? "Acceptance verification failed."
          : result.summary);
      const failure = classifyTaskFailure(message);
      const recovery = chooseRecovery({
        failure,
        attempt: node.attempt,
        maxAttempts: node.maxAttempts ?? 2,
        reversible: node.reversible ?? true,
      });
      node.error = failure.publicSummary;
      if (recovery.action === "retry" || recovery.action === "replan") {
        node.status = "queued";
        node.phase = recovery.action === "replan" ? "Replanning" : "Retrying";
        this.emit(goal, node, "node-retrying", recovery.reason);
        return;
      }
      node.status = "failed";
      node.phase = recovery.action === "ask-user" ? "Needs user" : "Failed";
      node.completedAt = this.now();
      this.emit(goal, node, "node-finished", recovery.reason);
    } catch (error) {
      if (signal.aborted) return;
      const failure = classifyTaskFailure(
        error instanceof Error ? error.message : String(error),
      );
      const recovery = chooseRecovery({
        failure,
        attempt: node.attempt,
        maxAttempts: node.maxAttempts ?? 2,
        reversible: node.reversible ?? true,
      });
      node.error = failure.publicSummary;
      if (recovery.action === "retry" || recovery.action === "replan") {
        node.status = "queued";
        node.phase = recovery.action === "replan" ? "Replanning" : "Retrying";
        this.emit(goal, node, "node-retrying", recovery.reason);
      } else {
        node.status = "failed";
        node.phase = recovery.action === "ask-user" ? "Needs user" : "Failed";
        node.completedAt = this.now();
        this.emit(goal, node, "node-finished", recovery.reason);
      }
    }
  }

  private cancelNodesWithFailedDependencies(goal: InternalGoal): void {
    for (const node of goal.nodes) {
      if (!["queued", "waiting"].includes(node.status)) continue;
      const failed = (node.dependencies ?? []).find((dependency) =>
        ["failed", "cancelled"].includes(
          this.requireNode(goal, dependency).status,
        ),
      );
      if (!failed) continue;
      node.status = "cancelled";
      node.error = `Dependency ${failed} did not complete.`;
      node.completedAt = this.now();
      this.emit(goal, node, "node-finished", node.error);
    }
  }

  private emit(
    goal: InternalGoal,
    node: GoalNodeState | undefined,
    type: ExecutiveEvent["type"],
    summary: string,
  ): void {
    const at = this.now();
    goal.updatedAt = at;
    this.onEvent({
      goalId: goal.id,
      nodeId: node?.id,
      type,
      status: node?.status ?? goal.status,
      summary,
      timestamp: at,
    });
  }

  private waitForWake(goal: InternalGoal, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (goal.wake === wake) goal.wake = undefined;
        resolve();
      }, timeoutMs);
      const wake = (): void => {
        clearTimeout(timer);
        if (goal.wake === wake) goal.wake = undefined;
        resolve();
      };
      goal.wake = wake;
    });
  }

  private wakeAll(): void {
    for (const goal of this.goals.values()) goal.wake?.();
  }

  private requireGoal(id: string): InternalGoal {
    const goal = this.goals.get(id);
    if (!goal) throw new Error(`Unknown goal ${id}.`);
    return goal;
  }

  private requireNode(goal: InternalGoal, id: string): GoalNodeState {
    const node = goal.nodes.find((candidate) => candidate.id === id);
    if (!node) throw new Error(`Unknown node ${id} in goal ${goal.id}.`);
    return node;
  }
}
