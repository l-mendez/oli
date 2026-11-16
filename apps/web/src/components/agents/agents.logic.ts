import {
  type Agent,
  type AgentHandoff,
  type AgentHandoffAutonomy,
  AgentId,
  type AgentTrigger,
  type AgentTriggerId,
  type AgentUpsertInput,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScheduledTaskSchedule,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";

export type TriggerWhen = "interval" | "fixed" | "webhook" | "once";
export type AgentWorkspaceMode = OrchestrationV2ThreadLaunchWorkspaceStrategy["type"];

export interface TriggerDraft {
  /** Stable while the form is open; saved triggers reuse their id. */
  readonly key: string;
  readonly id: AgentTriggerId | null;
  readonly label: string;
  readonly instruction: string;
  readonly enabled: boolean;
  readonly when: TriggerWhen;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  readonly weekdays: ReadonlySet<number>;
  /** What is saved now. Settings this form does not show are kept from it. */
  readonly stored: ScheduledTaskSchedule | null;
}

/** Chosen in a handoff's target list for a person rather than another agent. */
export const HANDOFF_TO_PERSON = "person";

export interface HandoffDraft {
  readonly key: string;
  /** An agent's id, or `HANDOFF_TO_PERSON`. */
  readonly target: string;
  readonly autonomy: AgentHandoffAutonomy;
  readonly when: string;
}

export interface AgentDraft {
  readonly id: AgentId | null;
  readonly name: string;
  readonly role: string;
  readonly enabled: boolean;
  readonly projectId: string;
  /** `instanceId:model`, or empty for the project's default model. */
  readonly modelKey: string;
  /** The saved selection, kept whole so its options survive an edit that leaves the model alone. */
  readonly savedModelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceMode: AgentWorkspaceMode;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly existingWorktreePath: string;
  /** One project-relative path per line. */
  readonly contextText: string;
  readonly handoffs: ReadonlyArray<HandoffDraft>;
  readonly triggers: ReadonlyArray<TriggerDraft>;
}

const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export function newTriggerDraft(key: string): TriggerDraft {
  return {
    key,
    id: null,
    label: "",
    instruction: "",
    enabled: true,
    when: "fixed",
    intervalMinutes: "60",
    timeOfDay: "09:00",
    weekdays: new Set([1, 2, 3, 4, 5]),
    stored: null,
  };
}

/** Handing to a person starts as a request, since a person has to pick it up anyway. */
export function newHandoffDraft(key: string): HandoffDraft {
  return { key, target: HANDOFF_TO_PERSON, autonomy: "ask", when: "" };
}

export function newAgentDraft(projectId: string, firstTriggerKey: string): AgentDraft {
  return {
    id: null,
    name: "",
    role: "",
    enabled: true,
    projectId,
    modelKey: "",
    savedModelSelection: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceMode: "worktree",
    baseRef: "main",
    startFromOrigin: true,
    existingWorktreePath: "",
    contextText: "",
    handoffs: [],
    triggers: [newTriggerDraft(firstTriggerKey)],
  };
}

function triggerToDraft(trigger: AgentTrigger): TriggerDraft {
  const { schedule } = trigger;
  return {
    ...newTriggerDraft(trigger.id),
    id: trigger.id,
    label: trigger.label,
    instruction: trigger.instruction,
    enabled: trigger.enabled,
    when: schedule.type === "fixed_time" ? "fixed" : schedule.type,
    ...(schedule.type === "interval"
      ? { intervalMinutes: String(schedule.everyMs / 60_000) }
      : schedule.type === "fixed_time"
        ? {
            timeOfDay: schedule.timeOfDay,
            weekdays: new Set(
              schedule.weekdays === undefined || schedule.weekdays.length === 0
                ? ALL_WEEKDAYS
                : schedule.weekdays,
            ),
          }
        : {}),
    stored: schedule,
  };
}

export function agentToDraft(agent: Agent): AgentDraft {
  const workspace = agent.workspaceStrategy;
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    enabled: agent.enabled,
    projectId: agent.projectId,
    modelKey: `${agent.modelSelection.instanceId}:${agent.modelSelection.model}`,
    savedModelSelection: agent.modelSelection,
    runtimeMode: agent.runtimeMode,
    interactionMode: agent.interactionMode,
    workspaceMode: workspace.type,
    baseRef: workspace.type === "worktree" ? workspace.baseRef : "main",
    startFromOrigin: workspace.type === "worktree" ? (workspace.startFromOrigin ?? true) : true,
    existingWorktreePath: workspace.type === "existing_worktree" ? workspace.worktreePath : "",
    contextText: agent.context.map((file) => file.path).join("\n"),
    handoffs: agent.handoffs.map((handoff, index) => ({
      key: `saved:${index}`,
      target: handoff.to.type === "agent" ? handoff.to.agentId : HANDOFF_TO_PERSON,
      autonomy: handoff.autonomy,
      when: handoff.when ?? "",
    })),
    triggers: agent.triggers.map(triggerToDraft),
  };
}

/** The schedule to save for a trigger, or the reason it cannot be saved. */
function triggerScheduleFromDraft(
  draft: TriggerDraft,
): ScheduledTaskUpsertSchedule | { readonly error: string } {
  if (draft.when === "interval") {
    const everyMs = Math.round(Number(draft.intervalMinutes) * 60_000);
    if (!Number.isSafeInteger(everyMs) || everyMs < 60_000) {
      return { error: "Enter an interval of at least one minute." };
    }
    return { type: "interval", everyMs };
  }
  if (draft.when === "fixed") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.timeOfDay)) {
      return { error: "Enter a time of day." };
    }
    const weekdays = [...draft.weekdays].toSorted((left, right) => left - right);
    if (weekdays.length === 0) return { error: "Pick at least one day." };
    return {
      type: "fixed_time",
      timeOfDay: draft.timeOfDay,
      ...(weekdays.length === ALL_WEEKDAYS.length ? {} : { weekdays }),
    };
  }
  // Signature, filters and de-duplication are set on the scheduled task; keep what is stored.
  if (draft.stored !== null && draft.stored.type === draft.when) return draft.stored;
  if (draft.when === "webhook") return { type: "webhook" };
  return { error: "Pick when this trigger fires." };
}

function contextPathsFromText(text: string): ReadonlyArray<string> {
  return [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  ];
}

/** The save request for a draft, or the first thing that stops it from saving. */
export function agentUpsertInputFromDraft(
  draft: AgentDraft,
  selection: ModelSelection | null,
): AgentUpsertInput | { readonly error: string } {
  const name = draft.name.trim();
  const role = draft.role.trim();
  if (!name) return { error: "Give the agent a name." };
  if (!role) return { error: "Describe the agent's role." };
  if (!draft.projectId) return { error: "Pick a project." };
  if (selection === null) return { error: "Pick a model." };
  if (draft.workspaceMode === "existing_worktree" && !draft.existingWorktreePath.trim()) {
    return { error: "Enter the path of the checkout to run in." };
  }
  const context = contextPathsFromText(draft.contextText);
  if (context.length > 32) return { error: "List at most 32 files to read first." };

  const triggers: Array<AgentUpsertInput["triggers"][number]> = [];
  for (const trigger of draft.triggers) {
    const label = trigger.label.trim();
    const instruction = trigger.instruction.trim();
    if (!label) return { error: "Name every trigger." };
    if (!instruction) return { error: `Say what the agent does on "${label}".` };
    const schedule = triggerScheduleFromDraft(trigger);
    if ("error" in schedule) return { error: `${label}: ${schedule.error}` };
    triggers.push({
      ...(trigger.id === null ? {} : { id: trigger.id }),
      label,
      instruction,
      enabled: trigger.enabled,
      schedule,
    });
  }

  const handoffs: Array<AgentHandoff> = [];
  const targets = new Set<string>();
  for (const handoff of draft.handoffs) {
    if (handoff.target === draft.id) return { error: "An agent cannot hand off to itself." };
    if (targets.has(handoff.target)) return { error: "List each handoff target once." };
    targets.add(handoff.target);
    const when = handoff.when.trim();
    handoffs.push({
      to:
        handoff.target === HANDOFF_TO_PERSON
          ? { type: "human" }
          : { type: "agent", agentId: AgentId.make(handoff.target) },
      autonomy: handoff.autonomy,
      ...(when ? { when } : {}),
    });
  }

  const saved = draft.savedModelSelection;
  return {
    ...(draft.id === null ? {} : { id: draft.id }),
    name,
    role,
    enabled: draft.enabled,
    projectId: draft.projectId as ProjectId,
    modelSelection:
      saved !== null && saved.instanceId === selection.instanceId && saved.model === selection.model
        ? saved
        : selection,
    runtimeMode: draft.runtimeMode,
    interactionMode: draft.interactionMode,
    workspaceStrategy:
      draft.workspaceMode === "root"
        ? { type: "root" }
        : draft.workspaceMode === "existing_worktree"
          ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() }
          : {
              type: "worktree",
              baseRef: draft.baseRef.trim() || "main",
              startFromOrigin: draft.startFromOrigin,
            },
    context: context.map((path) => ({ path })),
    handoffs,
    triggers,
  };
}
