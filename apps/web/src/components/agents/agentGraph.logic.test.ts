import {
  type Agent,
  type AgentHandoff,
  AgentId,
  AgentTriggerId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { AGENT_WIDTH, type AgentGraphLayout, layoutAgentGraph } from "./agentGraph.logic";

const toAgent = (id: string, autonomy: AgentHandoff["autonomy"] = "auto"): AgentHandoff => ({
  to: { type: "agent", agentId: AgentId.make(id) },
  autonomy,
});
const toPerson: AgentHandoff = { to: { type: "human" }, autonomy: "ask", when: "it is unsure" };

function agent(id: string, handoffs: ReadonlyArray<AgentHandoff> = [], triggers = 0): Agent {
  return {
    id: AgentId.make(id),
    name: id,
    role: "Do the work.",
    enabled: true,
    projectId: ProjectId.make("project:api"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "auto",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    context: [],
    handoffs,
    triggers: Array.from({ length: triggers }, (_, index) => ({
      id: AgentTriggerId.make(`${id}:trigger:${index}`),
      label: `event ${index}`,
      instruction: "Handle it.",
      enabled: true,
      schedule: { type: "webhook" as const, signature: null },
      taskId: ScheduledTaskId.make(`${id}:task:${index}`),
    })),
    version: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

const card = (layout: AgentGraphLayout, id: string) => {
  const node = layout.nodes.find((entry) => entry.kind === "agent" && entry.id === id);
  if (node === undefined) throw new Error(`No card for ${id}`);
  return { ...node, center: node.x + node.width / 2 };
};

function overlaps(layout: AgentGraphLayout) {
  return layout.nodes.some((a, index) =>
    layout.nodes
      .slice(index + 1)
      .some(
        (b) =>
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height,
      ),
  );
}

describe("agent graph layout", () => {
  it("puts triggers to the left of an agent and whoever it hands to below it", () => {
    const layout = layoutAgentGraph([
      agent("watcher", [toAgent("builder"), toPerson], 2),
      agent("builder", [], 1),
    ]);
    const watcher = card(layout, "watcher");
    const builder = card(layout, "builder");
    const person = layout.nodes.find((node) => node.kind === "person")!;
    const triggers = layout.nodes.filter(
      (node) => node.kind === "trigger" && node.agent.id === "watcher",
    );

    expect(triggers).toHaveLength(2);
    expect(triggers.every((node) => node.x + node.width < watcher.x)).toBe(true);
    expect(builder.y).toBeGreaterThan(watcher.y + watcher.height);
    expect(person.y).toBeGreaterThan(watcher.y + watcher.height);
    // The two it hands to sit either side of it.
    expect((builder.center + person.x + person.width / 2) / 2).toBeCloseTo(watcher.center, 0);
    expect(overlaps(layout)).toBe(false);
    expect(layout.nodes.every((node) => node.x >= 0 && node.y >= 0)).toBe(true);
    expect(layout.nodes.every((node) => node.x + node.width <= layout.width)).toBe(true);

    const handoffs = layout.edges.filter((edge) => edge.kind === "handoff");
    expect(handoffs.map((edge) => [edge.id, edge.asks, edge.label])).toEqual([
      ["watcher>builder", false, null],
      ["watcher>watcher/person", true, "it is unsure"],
    ]);
    expect(layout.edges.filter((edge) => edge.kind === "trigger")).toHaveLength(3);
  });

  it("places an agent below the longest chain that reaches it", () => {
    const layout = layoutAgentGraph([
      agent("a", [toAgent("b"), toAgent("c")]),
      agent("b", [toAgent("c")]),
      agent("c"),
    ]);
    expect(card(layout, "b").y).toBeGreaterThan(card(layout, "a").y);
    expect(card(layout, "c").y).toBeGreaterThan(card(layout, "b").y);
    expect(card(layout, "b").center).toBeCloseTo(card(layout, "a").center, 0);
  });

  it("lays out agents that hand back to each other", () => {
    const layout = layoutAgentGraph([agent("a", [toAgent("b")]), agent("b", [toAgent("a")])]);
    const a = card(layout, "a");
    const b = card(layout, "b");
    expect(b.y).toBeGreaterThan(a.y);
    expect(layout.edges.map((edge) => edge.id)).toEqual(["a>b", "b>a"]);
    // The line back up leaves room on the right of both cards.
    expect(layout.width).toBeGreaterThan(Math.max(a.x, b.x) + AGENT_WIDTH);
  });

  it("counts the triggers it has no room to draw", () => {
    const layout = layoutAgentGraph([agent("busy", [], 7)]);
    expect(layout.nodes.filter((node) => node.kind === "trigger")).toHaveLength(3);
    expect(layout.nodes.find((node) => node.kind === "more-triggers")).toMatchObject({ count: 4 });
    expect(overlaps(layout)).toBe(false);
  });

  it("ignores a handoff to an agent that no longer exists, or to itself", () => {
    const layout = layoutAgentGraph([agent("a", [toAgent("gone"), toAgent("a")])]);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toEqual([]);
  });

  it("has nothing to draw without agents", () => {
    expect(layoutAgentGraph([])).toEqual({ width: 0, height: 0, nodes: [], edges: [] });
  });
});
