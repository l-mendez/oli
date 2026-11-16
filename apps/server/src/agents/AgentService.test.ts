import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { type AgentUpsertInput, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as AgentService from "./AgentService.ts";
import { composeAgentPrompt } from "./agentPrompt.ts";

// The real scheduled-task service runs here: agents are only correct if its stored tasks are.
const layer = AgentService.layer.pipe(
  Layer.provideMerge(ScheduledTaskService.layer),
  Layer.provide(
    Layer.mergeAll(
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      NodeCrypto.layer,
      Scheduler.layer,
    ),
  ),
  Layer.provide(SqlitePersistence.layerMemory),
);

const watcher: AgentUpsertInput = {
  name: "regulation-watcher",
  role: "Keep the reporting code in line with the regulator's requirements.",
  enabled: true,
  projectId: ProjectId.make("project:test"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
  context: [{ path: "docs/compliance-map.md" }],
  handoffs: [{ to: { type: "human" }, autonomy: "ask", when: "the change touches capital" }],
  triggers: [
    {
      label: "hourly check",
      instruction: "Check whether the requirements page changed.",
      enabled: true,
      schedule: { type: "interval", everyMs: 3_600_000 },
    },
    {
      label: "regulator webhook",
      instruction: "A new version was published: {{body.version}}.",
      enabled: true,
      schedule: { type: "webhook" },
    },
  ],
};

it.effect("an agent owns one scheduled task per trigger, and edits keep them in step", () =>
  Effect.gen(function* () {
    const agents = yield* AgentService.AgentService;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;

    const { agent } = yield* agents.upsert(watcher);
    assert.equal(agent.version, 1);
    assert.deepEqual(
      agent.triggers.map((trigger) => trigger.schedule.type),
      ["interval", "webhook"],
    );
    const created = (yield* scheduledTasks.list()).tasks;
    assert.sameMembers(
      created.map((task) => task.title),
      ["regulation-watcher: hourly check", "regulation-watcher: regulator webhook"],
    );
    const hourly = created.find((task) => task.id === agent.triggers[0]!.taskId)!;
    assert.equal(hourly.threadMode, "new_thread");
    assert.include(hourly.prompt, watcher.role);
    assert.include(hourly.prompt, "docs/compliance-map.md");
    assert.include(hourly.prompt, "Check whether the requirements page changed.");

    // Dropping the webhook trigger and pausing the agent must reach the stored tasks.
    const edited = yield* agents.upsert({
      ...watcher,
      id: agent.id,
      enabled: false,
      triggers: [{ ...watcher.triggers[0]!, id: agent.triggers[0]!.id }],
    });
    assert.equal(edited.agent.version, 2);
    const remaining = (yield* scheduledTasks.list()).tasks;
    assert.deepEqual(
      remaining.map((task) => [task.id, task.enabled]),
      [[hourly.id, false]],
    );

    yield* agents.delete({ id: agent.id });
    assert.lengthOf((yield* scheduledTasks.list()).tasks, 0);
    assert.lengthOf((yield* agents.list()).agents, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("a memory reaches every trigger's prompt, and forgetting takes it out again", () =>
  Effect.gen(function* () {
    const agents = yield* AgentService.AgentService;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const { agent } = yield* agents.upsert(watcher);
    const prompts = scheduledTasks
      .list()
      .pipe(Effect.map(({ tasks }) => tasks.map((t) => t.prompt)));

    const { entry } = yield* agents.remember({
      agentId: agent.id,
      text: "Ignore drafts; only final versions count.",
      source: { type: "user" },
    });
    for (const prompt of yield* prompts) assert.include(prompt, "Ignore drafts");
    assert.deepEqual(
      (yield* agents.listMemory({ agentId: agent.id })).entries.map((item) => item.id),
      [entry.id],
    );

    yield* agents.forget({ agentId: agent.id, entryId: entry.id });
    for (const prompt of yield* prompts) assert.notInclude(prompt, "Ignore drafts");
    const again = yield* agents.forget({ agentId: agent.id, entryId: entry.id }).pipe(Effect.flip);
    assert.equal(again.message, "That memory no longer exists.");
  }).pipe(Effect.provide(layer)),
);

it("only the trigger instruction can carry webhook placeholders", () => {
  const prompt = composeAgentPrompt({
    name: "watcher",
    role: "Never print {{request}}.",
    context: [],
    memory: ["The payload field is {{body.secret}}."],
    trigger: { label: "webhook", instruction: "Version: {{body.version}}" },
  });
  assert.include(prompt, "Version: {{body.version}}");
  assert.notInclude(prompt, "{{request}}");
  assert.notInclude(prompt, "{{body.secret}}");
});
