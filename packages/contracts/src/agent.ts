import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ScheduledTaskSchedule, ScheduledTaskUpsertSchedule } from "./scheduledTask.ts";

export const AgentId = TrimmedNonEmptyString.pipe(Schema.brand("AgentId"));
export type AgentId = typeof AgentId.Type;

export const AgentTriggerId = TrimmedNonEmptyString.pipe(Schema.brand("AgentTriggerId"));
export type AgentTriggerId = typeof AgentTriggerId.Type;

export const AgentMemoryEntryId = TrimmedNonEmptyString.pipe(Schema.brand("AgentMemoryEntryId"));
export type AgentMemoryEntryId = typeof AgentMemoryEntryId.Type;

const MAX_AGENT_TRIGGERS = 16;
const MAX_AGENT_CONTEXT_FILES = 32;
const MAX_AGENT_HANDOFFS = 16;

const AgentTriggerFields = {
  label: TrimmedNonEmptyString.annotate({
    description: "Short name for what wakes the agent, such as 'regulator page changed'.",
  }),
  instruction: TrimmedNonEmptyString.annotate({
    description:
      "What the agent does when this fires. A webhook trigger can use {{body.path}}, {{headers.name}}, {{query.name}}.",
  }),
  enabled: Schema.Boolean,
};

/**
 * One way an agent wakes up. Each trigger is carried by a scheduled task the
 * agent owns, so scheduling, webhooks, and de-duplication stay in one place.
 */
export const AgentTrigger = Schema.Struct({
  id: AgentTriggerId,
  ...AgentTriggerFields,
  schedule: ScheduledTaskSchedule,
  taskId: ScheduledTaskId,
});
export type AgentTrigger = typeof AgentTrigger.Type;

export const AgentUpsertTrigger = Schema.Struct({
  id: Schema.optional(AgentTriggerId).annotate({
    description: "Omit for a new trigger. An existing trigger left out of a save is removed.",
  }),
  ...AgentTriggerFields,
  schedule: ScheduledTaskUpsertSchedule,
});
export type AgentUpsertTrigger = typeof AgentUpsertTrigger.Type;

/** A project file whose contents go into every run's prompt; the provider never chooses to load it. */
export const AgentContextFile = Schema.Struct({
  path: TrimmedNonEmptyString.annotate({ description: "Path relative to the project root." }),
});
export type AgentContextFile = typeof AgentContextFile.Type;

export const AgentHandoffTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("agent"), agentId: AgentId }),
  Schema.Struct({ type: Schema.Literal("human") }),
]);
export type AgentHandoffTarget = typeof AgentHandoffTarget.Type;

/** `auto` hands work over without asking; `ask` waits for a person. Set by whoever edits the agent. */
export const AgentHandoffAutonomy = Schema.Literals(["auto", "ask"]);
export type AgentHandoffAutonomy = typeof AgentHandoffAutonomy.Type;

export const AgentHandoff = Schema.Struct({
  to: AgentHandoffTarget,
  autonomy: AgentHandoffAutonomy,
  when: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Plain-language condition, such as 'the change touches capital calculations'.",
  }),
});
export type AgentHandoff = typeof AgentHandoff.Type;

const AgentDefinitionFields = {
  name: TrimmedNonEmptyString,
  role: TrimmedNonEmptyString.annotate({
    description: "Standing instructions: what this agent is responsible for and how it works.",
  }),
  enabled: Schema.Boolean,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  context: Schema.Array(AgentContextFile).check(Schema.isMaxLength(MAX_AGENT_CONTEXT_FILES)),
  handoffs: Schema.Array(AgentHandoff).check(Schema.isMaxLength(MAX_AGENT_HANDOFFS)),
};

/** The parts of an agent a person edits, without its triggers. */
export const AgentDefinition = Schema.Struct(AgentDefinitionFields);
export type AgentDefinition = typeof AgentDefinition.Type;

/**
 * A long-lived role. Runs are disposable threads; what persists is this
 * definition, its triggers, and its memory.
 */
export const Agent = Schema.Struct({
  id: AgentId,
  ...AgentDefinitionFields,
  triggers: Schema.Array(AgentTrigger),
  /** Starts at 1 and goes up by one on every saved change to the definition. */
  version: PositiveInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Agent = typeof Agent.Type;

export const AgentListInput = Schema.Struct({});
export type AgentListInput = typeof AgentListInput.Type;

export const AgentListResult = Schema.Struct({
  agents: Schema.Array(Agent),
});
export type AgentListResult = typeof AgentListResult.Type;

export const AgentUpsertInput = Schema.Struct({
  id: Schema.optional(AgentId),
  ...AgentDefinitionFields,
  triggers: Schema.Array(AgentUpsertTrigger).check(Schema.isMaxLength(MAX_AGENT_TRIGGERS)),
});
export type AgentUpsertInput = typeof AgentUpsertInput.Type;

export const AgentMutationResult = Schema.Struct({
  agent: Agent,
});
export type AgentMutationResult = typeof AgentMutationResult.Type;

export const AgentDeleteInput = Schema.Struct({
  id: AgentId,
});
export type AgentDeleteInput = typeof AgentDeleteInput.Type;

export const AgentDeleteResult = Schema.Struct({
  id: AgentId,
});
export type AgentDeleteResult = typeof AgentDeleteResult.Type;

/** Where a memory came from, so a person can judge it and undo it. */
export const AgentMemorySource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("user") }),
  Schema.Struct({ type: Schema.Literal("run"), threadId: ThreadId }),
]);
export type AgentMemorySource = typeof AgentMemorySource.Type;

export const AgentMemoryEntry = Schema.Struct({
  id: AgentMemoryEntryId,
  agentId: AgentId,
  text: TrimmedNonEmptyString,
  source: AgentMemorySource,
  createdAt: IsoDateTime,
});
export type AgentMemoryEntry = typeof AgentMemoryEntry.Type;

export const AgentListMemoryInput = Schema.Struct({
  agentId: AgentId,
});
export type AgentListMemoryInput = typeof AgentListMemoryInput.Type;

export const AgentListMemoryResult = Schema.Struct({
  entries: Schema.Array(AgentMemoryEntry),
});
export type AgentListMemoryResult = typeof AgentListMemoryResult.Type;

export const AgentRememberInput = Schema.Struct({
  agentId: AgentId,
  text: TrimmedNonEmptyString,
  source: AgentMemorySource,
});
export type AgentRememberInput = typeof AgentRememberInput.Type;

export const AgentRememberResult = Schema.Struct({
  entry: AgentMemoryEntry,
});
export type AgentRememberResult = typeof AgentRememberResult.Type;

export const AgentForgetInput = Schema.Struct({
  agentId: AgentId,
  entryId: AgentMemoryEntryId,
});
export type AgentForgetInput = typeof AgentForgetInput.Type;

export const AgentForgetResult = Schema.Struct({
  entryId: AgentMemoryEntryId,
});
export type AgentForgetResult = typeof AgentForgetResult.Type;

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String,
  agentId: Schema.optional(AgentId),
  cause: Schema.optional(Schema.Defect()),
}) {}
