import type { Agent, ScheduledTask } from "@t3tools/contracts";

import { ScheduledRelativeLabel } from "../settings/ScheduledTasksSettings";

type AgentState = "paused" | "idle" | "running" | "failed";

export const STATE_DOT_CLASS: Record<AgentState, string> = {
  paused: "bg-muted-foreground/40",
  idle: "bg-success",
  running: "bg-info motion-safe:animate-pulse",
  failed: "bg-destructive",
};

/** The scheduled tasks that carry an agent's triggers. */
export function triggerTasks(agent: Agent, tasksById: ReadonlyMap<string, ScheduledTask>) {
  return agent.triggers.flatMap((trigger) => {
    const task = tasksById.get(trigger.taskId);
    return task === undefined ? [] : [task];
  });
}

export function agentState(agent: Agent, tasks: ReadonlyArray<ScheduledTask>): AgentState {
  if (!agent.enabled) return "paused";
  if (tasks.some((task) => task.lastRunStatus === "running")) return "running";
  if (tasks.some((task) => task.lastRunStatus === "failed")) return "failed";
  return tasks.some((task) => task.enabled) ? "idle" : "paused";
}

/** One line on what the agent is doing or when it wakes next. */
export function AgentSummary({
  agent,
  tasks,
}: {
  readonly agent: Agent;
  readonly tasks: ReadonlyArray<ScheduledTask>;
}) {
  const state = agentState(agent, tasks);
  if (!agent.enabled) return "Paused";
  if (agent.triggers.length === 0) return "No triggers";
  if (state === "running") return "Running now";
  if (state === "failed") return "Last run failed";
  const nextRunAt = tasks
    .flatMap((task) => (task.enabled && task.nextRunAt ? [task.nextRunAt] : []))
    .toSorted()[0];
  if (nextRunAt !== undefined) {
    return (
      <>
        Wakes <ScheduledRelativeLabel value={nextRunAt} />
      </>
    );
  }
  return tasks.some((task) => task.enabled && task.schedule.type === "webhook")
    ? "Listening"
    : "Paused";
}
