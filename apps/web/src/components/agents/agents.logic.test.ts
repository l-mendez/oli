import {
  type Agent,
  AgentId,
  AgentTriggerId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentToDraft, agentUpsertInputFromDraft, newAgentDraft } from "./agents.logic";

const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const steward: Agent = {
  id: AgentId.make("agent:steward"),
  name: "merge-steward",
  role: "Decide what merges into main, and in what order.",
  enabled: true,
  projectId: ProjectId.make("project:api"),
  modelSelection: { ...model, options: [{ id: "effort", value: "high" }] },
  runtimeMode: "auto",
  interactionMode: "default",
  workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
  context: [{ path: "docs/release.md" }],
  handoffs: [{ to: { type: "human" }, autonomy: "ask" }],
  triggers: [
    {
      id: AgentTriggerId.make("agent-trigger:hook"),
      label: "pull request opened",
      instruction: "Review {{body.number}}.",
      enabled: true,
      schedule: {
        type: "webhook",
        signature: { header: "x-hub-signature-256", prefix: "sha256=", encoding: "hex" },
        filters: [{ path: "body.action", op: "equals", value: "opened" }],
      },
      taskId: ScheduledTaskId.make("scheduled-task:hook"),
    },
    {
      id: AgentTriggerId.make("agent-trigger:nightly"),
      label: "nightly sweep",
      instruction: "Look for stale branches.",
      enabled: false,
      schedule: { type: "fixed_time", timeOfDay: "02:30", weekdays: [1, 2, 3, 4, 5] },
      taskId: ScheduledTaskId.make("scheduled-task:nightly"),
    },
  ],
  version: 3,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
};

describe("agent drafts", () => {
  it("saves an unedited agent back as it was, keeping settings the form does not show", () => {
    const input = agentUpsertInputFromDraft(agentToDraft(steward), model);
    expect(input).toEqual({
      id: steward.id,
      name: steward.name,
      role: steward.role,
      enabled: true,
      projectId: steward.projectId,
      // The saved selection carries options the picker does not return.
      modelSelection: steward.modelSelection,
      runtimeMode: "auto",
      interactionMode: "default",
      workspaceStrategy: steward.workspaceStrategy,
      context: steward.context,
      handoffs: steward.handoffs,
      triggers: steward.triggers.map(({ taskId: _taskId, ...trigger }) => trigger),
    });
  });

  it("drops the saved model options once another model is picked", () => {
    const other = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" };
    const input = agentUpsertInputFromDraft(agentToDraft(steward), other);
    expect("error" in input ? input.error : input.modelSelection).toEqual(other);
  });

  it("turns the form's schedule fields into a schedule", () => {
    const draft = agentToDraft(steward);
    const input = agentUpsertInputFromDraft(
      {
        ...draft,
        contextText: " docs/a.md \n\ndocs/a.md\ndocs/b.md",
        triggers: [
          { ...draft.triggers[0]!, when: "interval", intervalMinutes: "90" },
          { ...draft.triggers[1]!, weekdays: new Set([0, 1, 2, 3, 4, 5, 6]) },
        ],
      },
      model,
    );
    if ("error" in input) throw new Error(input.error);
    expect(input.triggers.map((trigger) => trigger.schedule)).toEqual([
      { type: "interval", everyMs: 5_400_000 },
      // Every day is stored as no weekday list.
      { type: "fixed_time", timeOfDay: "02:30" },
    ]);
    expect(input.context).toEqual([{ path: "docs/a.md" }, { path: "docs/b.md" }]);
  });

  it("saves the handoffs the form lists", () => {
    const draft = agentToDraft(steward);
    const save = (handoffs: typeof draft.handoffs) =>
      agentUpsertInputFromDraft({ ...draft, handoffs }, model);
    const toJudge = { key: "new:0", target: "agent:judge", autonomy: "auto", when: " " } as const;
    expect(save([...draft.handoffs, toJudge])).toMatchObject({
      handoffs: [
        { to: { type: "human" }, autonomy: "ask" },
        { to: { type: "agent", agentId: "agent:judge" }, autonomy: "auto" },
      ],
    });
    expect(save([toJudge, { ...toJudge, key: "new:1", autonomy: "ask" }])).toEqual({
      error: "List each handoff target once.",
    });
    expect(save([{ ...toJudge, target: steward.id }])).toEqual({
      error: "An agent cannot hand off to itself.",
    });
  });

  it("names the first thing that stops a save", () => {
    const blank = newAgentDraft("project:api", "new:0");
    const error = (draft: typeof blank) => {
      const input = agentUpsertInputFromDraft(draft, model);
      return "error" in input ? input.error : null;
    };
    expect(error(blank)).toBe("Give the agent a name.");
    const named = { ...blank, name: "watcher", role: "Watch the regulator." };
    expect(error(named)).toBe("Name every trigger.");
    const trigger = { ...named.triggers[0]!, label: "hourly", instruction: "Check the page." };
    expect(
      error({ ...named, triggers: [{ ...trigger, when: "interval", intervalMinutes: "0.5" }] }),
    ).toBe("hourly: Enter an interval of at least one minute.");
    expect(error({ ...named, triggers: [trigger] })).toBeNull();
    expect(agentUpsertInputFromDraft({ ...named, triggers: [trigger] }, null)).toEqual({
      error: "Pick a model.",
    });
  });
});
