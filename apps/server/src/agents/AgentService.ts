import {
  type Agent,
  AgentDefinition,
  type AgentDeleteInput,
  type AgentDeleteResult,
  AgentError,
  type AgentForgetInput,
  type AgentForgetResult,
  AgentId,
  type AgentListMemoryInput,
  type AgentListMemoryResult,
  type AgentListResult,
  AgentMemoryEntry,
  AgentMemoryEntryId,
  type AgentMutationResult,
  type AgentRememberInput,
  type AgentRememberResult,
  type AgentTrigger,
  AgentTriggerId,
  CommandId,
  type ScheduledTaskError,
  ScheduledTaskId,
  type ScheduledTaskUpsertSchedule,
  type AgentUpsertInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import { composeAgentPrompt } from "./agentPrompt.ts";

interface AgentRow {
  readonly agent_id: string;
  readonly definition_json: string;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AgentTriggerRow {
  readonly trigger_id: string;
  readonly agent_id: string;
  readonly task_id: string;
  readonly label: string;
  readonly instruction: string;
  readonly enabled: number;
  readonly position: number;
}

interface AgentMemoryRow {
  readonly entry_id: string;
  readonly agent_id: string;
  readonly text: string;
  readonly source_json: string;
  readonly created_at: string;
}

export class AgentService extends Context.Service<
  AgentService,
  {
    readonly list: () => Effect.Effect<AgentListResult, AgentError>;
    readonly subscribeList: () => Stream.Stream<AgentListResult, AgentError>;
    /** Saves the definition and brings every trigger's scheduled task in line with it. */
    readonly upsert: (input: AgentUpsertInput) => Effect.Effect<AgentMutationResult, AgentError>;
    /** Removes the agent, its memory, its history, and the scheduled tasks it owns. */
    readonly delete: (input: AgentDeleteInput) => Effect.Effect<AgentDeleteResult, AgentError>;
    readonly listMemory: (
      input: AgentListMemoryInput,
    ) => Effect.Effect<AgentListMemoryResult, AgentError>;
    /** Stores a memory and rewrites the agent's prompts so the next run starts with it. */
    readonly remember: (
      input: AgentRememberInput,
    ) => Effect.Effect<AgentRememberResult, AgentError>;
    readonly forget: (input: AgentForgetInput) => Effect.Effect<AgentForgetResult, AgentError>;
  }
>()("t3/agents/AgentService") {}

function agentError(message: string, input?: { agentId?: AgentId; cause?: unknown }) {
  return new AgentError({
    message,
    ...(input?.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

// Scheduled-task refusals are written for the person saving, so they pass through as-is.
const fromTaskError = (agentId: AgentId) => (cause: ScheduledTaskError) =>
  agentError(cause.message, { agentId, cause });

const DefinitionJson = Schema.fromJsonString(AgentDefinition);
const decodeDefinitionJson = Schema.decodeUnknownEffect(DefinitionJson);
const encodeDefinitionJson = Schema.encodeSync(DefinitionJson);
const MemorySourceJson = Schema.fromJsonString(AgentMemoryEntry.fields.source);
const decodeMemorySourceJson = Schema.decodeUnknownEffect(MemorySourceJson);
const encodeMemorySourceJson = Schema.encodeSync(MemorySourceJson);
const encodeSnapshotJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/**
 * These tables are created here, outside the numbered migrations, so a fork
 * never competes with upstream for the next migration number.
 */
const ensureSchema = Effect.fn("AgentService.ensureSchema")(function* (sql: SqlClient.SqlClient) {
  yield* sql`
    CREATE TABLE IF NOT EXISTS arch_agents (
      agent_id TEXT PRIMARY KEY,
      definition_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS arch_agent_triggers (
      trigger_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      label TEXT NOT NULL,
      instruction TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      position INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS arch_agent_triggers_agent
    ON arch_agent_triggers (agent_id, position)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS arch_agent_versions (
      agent_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, version)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS arch_agent_memory (
      entry_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      text TEXT NOT NULL,
      source_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS arch_agent_memory_agent
    ON arch_agent_memory (agent_id, created_at)
  `;
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  yield* ensureSchema(sql);
  // Notifications re-emit the full list; slow subscribers need only the newest dirty signal.
  const changesPubSub = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

  const newId = (prefix: string) =>
    random.uuidV4().pipe(
      Effect.map((uuid) => `${prefix}:${uuid}`),
      Effect.mapError((cause) => agentError("Could not generate an id.", { cause })),
    );

  const decodeMemoryRow = Effect.fn("AgentService.decodeMemoryRow")(function* (
    row: AgentMemoryRow,
  ) {
    const source = yield* decodeMemorySourceJson(row.source_json).pipe(
      Effect.mapError((cause) => agentError("Could not decode a stored memory.", { cause })),
    );
    return {
      id: AgentMemoryEntryId.make(row.entry_id),
      agentId: AgentId.make(row.agent_id),
      text: row.text,
      source,
      createdAt: row.created_at,
    } satisfies AgentMemoryEntry;
  });

  const loadMemory = Effect.fn("AgentService.loadMemory")(function* (agentId: AgentId) {
    const rows = yield* sql<AgentMemoryRow>`
      SELECT entry_id, agent_id, text, source_json, created_at
      FROM arch_agent_memory
      WHERE agent_id = ${agentId}
      ORDER BY created_at ASC, entry_id ASC
    `.pipe(Effect.mapError((cause) => agentError("Could not read memory.", { agentId, cause })));
    return yield* Effect.forEach(rows, decodeMemoryRow);
  });

  const loadTriggerRows = (agentId: AgentId) =>
    sql<AgentTriggerRow>`
      SELECT trigger_id, agent_id, task_id, label, instruction, enabled, position
      FROM arch_agent_triggers
      WHERE agent_id = ${agentId}
      ORDER BY position ASC
    `.pipe(Effect.mapError((cause) => agentError("Could not read triggers.", { agentId, cause })));

  const findAgentRow = Effect.fn("AgentService.findAgentRow")(function* (agentId: AgentId) {
    const rows = yield* sql<AgentRow>`
      SELECT agent_id, definition_json, version, created_at, updated_at
      FROM arch_agents
      WHERE agent_id = ${agentId}
    `.pipe(Effect.mapError((cause) => agentError("Could not read the agent.", { agentId, cause })));
    return rows[0] ?? null;
  });

  const requireAgentRow = Effect.fn("AgentService.requireAgentRow")(function* (agentId: AgentId) {
    const row = yield* findAgentRow(agentId);
    if (row === null) return yield* agentError("That agent no longer exists.", { agentId });
    return row;
  });

  const decodeDefinition = (row: AgentRow) =>
    decodeDefinitionJson(row.definition_json).pipe(
      Effect.mapError((cause) =>
        agentError("Could not decode the stored agent.", {
          agentId: AgentId.make(row.agent_id),
          cause,
        }),
      ),
    );

  const list: AgentService["Service"]["list"] = Effect.fn("AgentService.list")(function* () {
    const rows = yield* sql<AgentRow>`
      SELECT agent_id, definition_json, version, created_at, updated_at
      FROM arch_agents
      ORDER BY created_at ASC, agent_id ASC
    `.pipe(Effect.mapError((cause) => agentError("Could not read agents.", { cause })));
    const triggerRows = yield* sql<AgentTriggerRow>`
      SELECT trigger_id, agent_id, task_id, label, instruction, enabled, position
      FROM arch_agent_triggers
      ORDER BY position ASC
    `.pipe(Effect.mapError((cause) => agentError("Could not read triggers.", { cause })));
    const { tasks } = yield* scheduledTasks
      .list()
      .pipe(Effect.mapError((cause) => agentError(cause.message, { cause })));
    const tasksById = new Map(tasks.map((task) => [task.id as string, task]));
    const agents = yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const definition = yield* decodeDefinition(row);
        // A trigger whose scheduled task was deleted elsewhere can no longer fire, so it is not listed.
        const triggers = triggerRows.flatMap((trigger): Array<AgentTrigger> => {
          const task = tasksById.get(trigger.task_id);
          if (trigger.agent_id !== row.agent_id || task === undefined) return [];
          return [
            {
              id: AgentTriggerId.make(trigger.trigger_id),
              label: trigger.label,
              instruction: trigger.instruction,
              enabled: trigger.enabled === 1,
              schedule: task.schedule,
              taskId: task.id,
            },
          ];
        });
        return {
          id: AgentId.make(row.agent_id),
          ...definition,
          triggers,
          version: row.version,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        } satisfies Agent;
      }),
    );
    return { agents };
  });

  const subscribeList: AgentService["Service"]["subscribeList"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading to buffer concurrent changes.
        const subscription = yield* PubSub.subscribe(changesPubSub);
        return Stream.concat(
          Stream.fromEffect(list()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
        );
      }),
    );

  const saveTriggerTask = (
    agentId: AgentId,
    definition: AgentDefinition,
    memory: ReadonlyArray<string>,
    trigger: {
      readonly id: AgentTriggerId;
      readonly label: string;
      readonly instruction: string;
      readonly enabled: boolean;
      readonly schedule: ScheduledTaskUpsertSchedule;
      readonly taskId: ScheduledTaskId | null;
    },
  ) =>
    scheduledTasks
      .upsert({
        // A new trigger derives its task id from the trigger id, so a retried save reuses the task.
        ...(trigger.taskId === null
          ? { commandId: CommandId.make(trigger.id) }
          : { id: trigger.taskId }),
        title: `${definition.name}: ${trigger.label}`,
        prompt: composeAgentPrompt({
          name: definition.name,
          role: definition.role,
          context: definition.context,
          memory,
          trigger,
        }),
        enabled: definition.enabled && trigger.enabled,
        schedule: trigger.schedule,
        projectId: definition.projectId,
        threadId: null,
        // Each run is a fresh thread; continuity comes from memory, not a growing conversation.
        threadMode: "new_thread",
        workspaceStrategy: definition.workspaceStrategy,
        modelSelection: definition.modelSelection,
        runtimeMode: definition.runtimeMode,
        interactionMode: definition.interactionMode,
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.mapError(fromTaskError(agentId)));

  const requireAgent = Effect.fn("AgentService.requireAgent")(function* (agentId: AgentId) {
    const { agents } = yield* list();
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (agent === undefined) return yield* agentError("That agent no longer exists.", { agentId });
    return agent;
  });

  /** Rewrites every trigger's stored prompt after something the prompt includes has changed. */
  const resyncPrompts = Effect.fn("AgentService.resyncPrompts")(function* (agentId: AgentId) {
    const agent = yield* requireAgent(agentId);
    const memory = (yield* loadMemory(agentId)).map((entry) => entry.text);
    yield* Effect.forEach(
      agent.triggers,
      (trigger) => saveTriggerTask(agentId, agent, memory, trigger),
      { discard: true },
    );
  });

  const upsert: AgentService["Service"]["upsert"] = Effect.fn("AgentService.upsert")(
    function* (input) {
      const existing = input.id === undefined ? null : yield* requireAgentRow(input.id);
      const agentId = input.id ?? AgentId.make(yield* newId("agent"));
      const savedAt = yield* now;
      const definition: AgentDefinition = {
        name: input.name,
        role: input.role,
        enabled: input.enabled,
        projectId: input.projectId,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        workspaceStrategy: input.workspaceStrategy,
        context: input.context,
        handoffs: input.handoffs,
      };
      const storedTriggers = existing === null ? [] : yield* loadTriggerRows(agentId);
      const storedById = new Map(storedTriggers.map((row) => [row.trigger_id, row]));
      const memory = (yield* loadMemory(agentId)).map((entry) => entry.text);

      const saved = yield* Effect.forEach(input.triggers, (trigger) =>
        Effect.gen(function* () {
          const stored = trigger.id === undefined ? undefined : storedById.get(trigger.id);
          if (trigger.id !== undefined && stored === undefined) {
            return yield* agentError("That trigger no longer exists.", { agentId });
          }
          const id = trigger.id ?? AgentTriggerId.make(yield* newId("agent-trigger"));
          const { task } = yield* saveTriggerTask(agentId, definition, memory, {
            id,
            label: trigger.label,
            instruction: trigger.instruction,
            enabled: trigger.enabled,
            schedule: trigger.schedule,
            taskId: stored === undefined ? null : ScheduledTaskId.make(stored.task_id),
          });
          return { id, trigger, task };
        }),
      );

      const keptIds = new Set(saved.map((entry) => entry.id as string));
      yield* Effect.forEach(
        storedTriggers.filter((row) => !keptIds.has(row.trigger_id)),
        (row) =>
          scheduledTasks
            .delete({ id: ScheduledTaskId.make(row.task_id) })
            .pipe(Effect.mapError(fromTaskError(agentId))),
        { discard: true },
      );

      const version = existing === null ? 1 : existing.version + 1;
      // The stored schedule goes into history, never the request's, which can carry a webhook secret.
      const snapshot = encodeSnapshotJson({
        definition,
        triggers: saved.map(({ id, trigger, task }) => ({
          id,
          label: trigger.label,
          instruction: trigger.instruction,
          enabled: trigger.enabled,
          schedule: task.schedule,
        })),
      });
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO arch_agents ${sql.insert({
                agent_id: agentId,
                definition_json: encodeDefinitionJson(definition),
                version,
                created_at: existing?.created_at ?? savedAt,
                updated_at: savedAt,
              })}
              ON CONFLICT (agent_id) DO UPDATE SET
                definition_json = excluded.definition_json,
                version = excluded.version,
                updated_at = excluded.updated_at
            `;
            yield* sql`DELETE FROM arch_agent_triggers WHERE agent_id = ${agentId}`;
            yield* Effect.forEach(
              saved,
              ({ id, trigger, task }, position) =>
                sql`
                  INSERT INTO arch_agent_triggers ${sql.insert({
                    trigger_id: id,
                    agent_id: agentId,
                    task_id: task.id,
                    label: trigger.label,
                    instruction: trigger.instruction,
                    enabled: trigger.enabled ? 1 : 0,
                    position,
                  })}
                `,
              { discard: true },
            );
            yield* sql`
              INSERT INTO arch_agent_versions ${sql.insert({
                agent_id: agentId,
                version,
                snapshot_json: snapshot,
                created_at: savedAt,
              })}
            `;
          }),
        )
        .pipe(
          Effect.mapError((cause) => agentError("Could not save the agent.", { agentId, cause })),
        );
      yield* notifyChanged;
      return { agent: yield* requireAgent(agentId) };
    },
  );

  const deleteAgent: AgentService["Service"]["delete"] = Effect.fn("AgentService.delete")(
    function* (input) {
      yield* requireAgentRow(input.id);
      const triggers = yield* loadTriggerRows(input.id);
      yield* Effect.forEach(
        triggers,
        (row) =>
          scheduledTasks
            .delete({ id: ScheduledTaskId.make(row.task_id) })
            .pipe(Effect.mapError(fromTaskError(input.id))),
        { discard: true },
      );
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM arch_agent_memory WHERE agent_id = ${input.id}`;
            yield* sql`DELETE FROM arch_agent_versions WHERE agent_id = ${input.id}`;
            yield* sql`DELETE FROM arch_agent_triggers WHERE agent_id = ${input.id}`;
            yield* sql`DELETE FROM arch_agents WHERE agent_id = ${input.id}`;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            agentError("Could not delete the agent.", { agentId: input.id, cause }),
          ),
        );
      yield* notifyChanged;
      return { id: input.id };
    },
  );

  const listMemory: AgentService["Service"]["listMemory"] = Effect.fn("AgentService.listMemory")(
    function* (input) {
      yield* requireAgentRow(input.agentId);
      return { entries: yield* loadMemory(input.agentId) };
    },
  );

  const remember: AgentService["Service"]["remember"] = Effect.fn("AgentService.remember")(
    function* (input) {
      yield* requireAgentRow(input.agentId);
      const entry: AgentMemoryEntry = {
        id: AgentMemoryEntryId.make(yield* newId("agent-memory")),
        agentId: input.agentId,
        text: input.text,
        source: input.source,
        createdAt: yield* now,
      };
      yield* sql`
        INSERT INTO arch_agent_memory ${sql.insert({
          entry_id: entry.id,
          agent_id: entry.agentId,
          text: entry.text,
          source_json: encodeMemorySourceJson(entry.source),
          created_at: entry.createdAt,
        })}
      `.pipe(
        Effect.mapError((cause) =>
          agentError("Could not store the memory.", { agentId: input.agentId, cause }),
        ),
      );
      yield* resyncPrompts(input.agentId);
      return { entry };
    },
  );

  const forget: AgentService["Service"]["forget"] = Effect.fn("AgentService.forget")(
    function* (input) {
      const removed = yield* sql<{ readonly entry_id: string }>`
        DELETE FROM arch_agent_memory
        WHERE entry_id = ${input.entryId} AND agent_id = ${input.agentId}
        RETURNING entry_id
      `.pipe(
        Effect.mapError((cause) =>
          agentError("Could not remove the memory.", { agentId: input.agentId, cause }),
        ),
      );
      if (removed.length === 0) {
        return yield* agentError("That memory no longer exists.", { agentId: input.agentId });
      }
      yield* resyncPrompts(input.agentId);
      return { entryId: input.entryId };
    },
  );

  return AgentService.of({
    list,
    subscribeList,
    upsert,
    delete: deleteAgent,
    listMemory,
    remember,
    forget,
  });
});

export const layer = Layer.effect(AgentService, make);
