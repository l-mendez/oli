import type { Agent, AgentHandoff, AgentTrigger } from "@t3tools/contracts";

/**
 * Where everything sits on the agent graph. Work flows downwards: an agent's
 * triggers come in from its left, and its handoffs leave from its bottom.
 */

export const AGENT_WIDTH = 216;
const AGENT_HEIGHT = 62;
const TRIGGER_WIDTH = 184;
const TRIGGER_HEIGHT = 28;
const PERSON_WIDTH = 124;
const PERSON_HEIGHT = 32;

const TRIGGER_GAP = 8;
const TRIGGER_TO_AGENT = 44;
const COLUMN_GAP = 56;
const ROW_GAP = 84;
/** Triggers drawn per agent; the rest are counted in one extra pill. */
const MAX_TRIGGERS_SHOWN = 4;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type AgentGraphNode =
  | (Box & { readonly kind: "agent"; readonly id: string; readonly agent: Agent })
  | (Box & {
      readonly kind: "trigger";
      readonly id: string;
      readonly agent: Agent;
      readonly trigger: AgentTrigger;
    })
  | (Box & {
      readonly kind: "more-triggers";
      readonly id: string;
      readonly agent: Agent;
      readonly count: number;
    })
  | (Box & { readonly kind: "person"; readonly id: string; readonly agent: Agent });

export interface AgentGraphEdge {
  readonly id: string;
  readonly kind: "trigger" | "handoff";
  /** The agents this line belongs to, for highlighting a selection. */
  readonly agentIds: ReadonlyArray<string>;
  readonly path: string;
  /** A handoff that waits for a person before it happens. */
  readonly asks: boolean;
  readonly label: string | null;
  readonly labelX: number;
  readonly labelY: number;
}

export interface AgentGraphLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: ReadonlyArray<AgentGraphNode>;
  readonly edges: ReadonlyArray<AgentGraphEdge>;
}

/** One agent or person with everything drawn beside it, placed as a unit. */
interface Cell {
  readonly id: string;
  readonly agent: Agent;
  readonly person: boolean;
  readonly layer: number;
  /** Shown triggers, then how many more there are. */
  readonly triggers: ReadonlyArray<AgentTrigger>;
  readonly hiddenTriggers: number;
  readonly width: number;
  readonly height: number;
  /** From the cell's left edge to the middle of its card. */
  readonly cardCenter: number;
  readonly parents: ReadonlyArray<string>;
}

const agentTarget = (handoff: AgentHandoff) =>
  handoff.to.type === "agent" ? (handoff.to.agentId as string) : null;

/**
 * Longest distance from an agent nobody hands to. A handoff that would close a
 * loop is left out, so a cycle still lays out; it is drawn as a line back up.
 */
function agentLayers(agents: ReadonlyArray<Agent>): ReadonlyMap<string, number> {
  const byId = new Map(agents.map((agent) => [agent.id as string, agent]));
  const sources = new Map<string, Array<string>>();
  const state = new Map<string, "open" | "done">();
  const visit = (id: string) => {
    state.set(id, "open");
    for (const handoff of byId.get(id)?.handoffs ?? []) {
      const target = agentTarget(handoff);
      if (target === null || target === id || !byId.has(target)) continue;
      if (state.get(target) === "open") continue;
      if (!state.has(target)) visit(target);
      sources.set(target, [...(sources.get(target) ?? []), id]);
    }
    state.set(id, "done");
  };
  for (const agent of agents) if (!state.has(agent.id)) visit(agent.id);

  const layers = new Map<string, number>();
  const layerOf = (id: string): number => {
    const known = layers.get(id);
    if (known !== undefined) return known;
    const layer = Math.max(0, ...(sources.get(id) ?? []).map((source) => layerOf(source) + 1));
    layers.set(id, layer);
    return layer;
  };
  for (const agent of agents) layerOf(agent.id);
  return layers;
}

function buildCells(agents: ReadonlyArray<Agent>): ReadonlyArray<Cell> {
  const layers = agentLayers(agents);
  const known = new Set(agents.map((agent) => agent.id as string));
  const parents = new Map<string, Array<string>>();
  for (const agent of agents) {
    for (const handoff of agent.handoffs) {
      const target = agentTarget(handoff);
      if (target === null || !known.has(target)) continue;
      if ((layers.get(target) ?? 0) <= (layers.get(agent.id) ?? 0)) continue;
      parents.set(target, [...(parents.get(target) ?? []), agent.id]);
    }
  }
  return agents.flatMap((agent): Array<Cell> => {
    const layer = layers.get(agent.id) ?? 0;
    const hidden = Math.max(0, agent.triggers.length - MAX_TRIGGERS_SHOWN);
    // The extra pill takes the place of one trigger, so the stack never grows past the limit.
    const triggers = agent.triggers.slice(0, hidden > 0 ? MAX_TRIGGERS_SHOWN - 1 : undefined);
    const pills = triggers.length + (hidden > 0 ? 1 : 0);
    const offset = pills === 0 ? 0 : TRIGGER_WIDTH + TRIGGER_TO_AGENT;
    const cell: Cell = {
      id: agent.id,
      agent,
      person: false,
      layer,
      triggers,
      hiddenTriggers: hidden > 0 ? agent.triggers.length - triggers.length : 0,
      width: offset + AGENT_WIDTH,
      height: Math.max(AGENT_HEIGHT, pills * TRIGGER_HEIGHT + (pills - 1) * TRIGGER_GAP),
      cardCenter: offset + AGENT_WIDTH / 2,
      parents: parents.get(agent.id) ?? [],
    };
    if (!agent.handoffs.some((handoff) => handoff.to.type === "human")) return [cell];
    return [
      cell,
      {
        id: `${agent.id}/person`,
        agent,
        person: true,
        layer: layer + 1,
        triggers: [],
        hiddenTriggers: 0,
        width: PERSON_WIDTH,
        height: PERSON_HEIGHT,
        cardCenter: PERSON_WIDTH / 2,
        parents: [agent.id],
      },
    ];
  });
}

const mean = (values: ReadonlyArray<number>) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Left edges for one row. Each cell wants its card under the middle of the
 * cards that hand to it. Packing once from each side and averaging keeps cells
 * apart while leaving siblings balanced around their parent.
 */
function placeRow(row: ReadonlyArray<Cell>, centers: ReadonlyMap<string, number>) {
  const wanted = row.map((cell) => {
    const above = cell.parents.flatMap((id) => {
      const center = centers.get(id);
      return center === undefined ? [] : [center];
    });
    return above.length === 0 ? null : mean(above) - cell.cardCenter;
  });
  const fromLeft: Array<number> = [];
  row.forEach((cell, index) => {
    const previous = row[index - 1];
    const floor =
      previous === undefined ? -Infinity : fromLeft[index - 1]! + previous.width + COLUMN_GAP;
    const want = wanted[index] ?? (previous === undefined ? 0 : floor);
    fromLeft.push(Math.max(want, floor));
  });
  const fromRight: Array<number> = Array.from({ length: row.length }, () => 0);
  for (let index = row.length - 1; index >= 0; index -= 1) {
    const cell = row[index]!;
    const ceiling =
      index === row.length - 1 ? Infinity : fromRight[index + 1]! - COLUMN_GAP - cell.width;
    const want = wanted[index] ?? (index === row.length - 1 ? fromLeft[index]! : ceiling);
    fromRight[index] = Math.min(want, ceiling);
  }
  return row.map((_, index) => (fromLeft[index]! + fromRight[index]!) / 2);
}

const round = (value: number) => Math.round(value * 10) / 10;

type Point = readonly [x: number, y: number];
type Curve = readonly [Point, Point, Point, Point];

const curvePath = ([start, ...rest]: Curve) =>
  `M${round(start[0])},${round(start[1])} C${rest.map(([x, y]) => `${round(x)},${round(y)}`).join(" ")}`;

function curvePoint(curve: Curve, t: number): Point {
  const weights = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3];
  return [
    curve.reduce((sum, point, index) => sum + point[0] * weights[index]!, 0),
    curve.reduce((sum, point, index) => sum + point[1] * weights[index]!, 0),
  ];
}

/** Where along a line its label may sit, most wanted first. */
const LABEL_SPOTS = [0.5, 0.36, 0.64, 0.24, 0.76];
/** How far apart lines sit where several leave or reach the same card. */
const PORT_GAP = 18;

// The label's real size is only known once drawn; this is close enough to keep labels apart.
function labelBox(text: string, [x, y]: Point): Box {
  const width = Math.min(176, text.length * 6 + 12);
  return { x: x - width / 2, y: y - 9, width, height: 18 };
}

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export function layoutAgentGraph(agents: ReadonlyArray<Agent>): AgentGraphLayout {
  const cells = buildCells(agents);
  const rows: Array<Array<Cell>> = [];
  for (const cell of cells) (rows[cell.layer] ??= []).push(cell);

  const left = new Map<string, number>();
  const centers = new Map<string, number>();
  const rowTop: Array<number> = [];
  const rowHeight: Array<number> = [];
  let top = 0;
  for (const [layer, unordered] of rows.entries()) {
    if (unordered === undefined) continue;
    // Under whoever hands to them; agents nobody hands to keep their saved order.
    const order = (cell: Cell) => {
      const above = cell.parents.flatMap((id) => centers.get(id) ?? []);
      return above.length === 0 ? null : mean(above);
    };
    const row = unordered
      .map((cell, index) => ({ cell, index, at: order(cell) }))
      .toSorted((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.index - b.index)
      .map((entry) => entry.cell);
    const xs = placeRow(row, centers);
    row.forEach((cell, index) => {
      left.set(cell.id, xs[index]!);
      centers.set(cell.id, xs[index]! + cell.cardCenter);
    });
    rowTop[layer] = top;
    rowHeight[layer] = Math.max(...row.map((cell) => cell.height));
    top += rowHeight[layer]! + ROW_GAP;
  }

  // A row centred under its parents can start left of the first row.
  const origin = Math.min(0, ...left.values());
  const nodes: Array<AgentGraphNode> = [];
  const edges: Array<AgentGraphEdge> = [];
  const cards = new Map<string, Box>();
  for (const cell of cells) {
    const middle = rowTop[cell.layer]! + rowHeight[cell.layer]! / 2;
    const x = left.get(cell.id)! - origin;
    if (cell.person) {
      const box = { x, y: middle - PERSON_HEIGHT / 2, width: PERSON_WIDTH, height: PERSON_HEIGHT };
      cards.set(cell.id, box);
      nodes.push({ kind: "person", id: cell.id, agent: cell.agent, ...box });
      continue;
    }
    const card = {
      x: x + cell.width - AGENT_WIDTH,
      y: middle - AGENT_HEIGHT / 2,
      width: AGENT_WIDTH,
      height: AGENT_HEIGHT,
    };
    cards.set(cell.id, card);
    nodes.push({ kind: "agent", id: cell.id, agent: cell.agent, ...card });

    const pills = cell.triggers.length + (cell.hiddenTriggers > 0 ? 1 : 0);
    const stack = pills * TRIGGER_HEIGHT + (pills - 1) * TRIGGER_GAP;
    for (let index = 0; index < pills; index += 1) {
      const trigger = cell.triggers[index];
      const y = middle - stack / 2 + index * (TRIGGER_HEIGHT + TRIGGER_GAP);
      const box = { x, y, width: TRIGGER_WIDTH, height: TRIGGER_HEIGHT };
      const id = trigger === undefined ? `${cell.id}/more` : trigger.id;
      nodes.push(
        trigger === undefined
          ? { kind: "more-triggers", id, agent: cell.agent, count: cell.hiddenTriggers, ...box }
          : { kind: "trigger", id, agent: cell.agent, trigger, ...box },
      );
      const fromX = x + TRIGGER_WIDTH;
      const fromY = y + TRIGGER_HEIGHT / 2;
      const bend = TRIGGER_TO_AGENT / 2;
      edges.push({
        id: `${id}>${cell.id}`,
        kind: "trigger",
        agentIds: [cell.id],
        path: `M${round(fromX)},${round(fromY)} C${round(fromX + bend)},${round(fromY)} ${round(card.x - bend)},${round(middle)} ${round(card.x)},${round(middle)}`,
        asks: false,
        label: null,
        labelX: 0,
        labelY: 0,
      });
    }
  }

  const handoffs = agents.flatMap((agent) => {
    const from = cards.get(agent.id);
    if (from === undefined) return [];
    const drawn = new Set<string>();
    return agent.handoffs.flatMap((handoff) => {
      const targetId = agentTarget(handoff) ?? `${agent.id}/person`;
      const to = cards.get(targetId);
      // An agent hands to each target once; a deleted target leaves nothing to draw.
      if (to === undefined || targetId === agent.id || drawn.has(targetId)) return [];
      drawn.add(targetId);
      return [{ agent, handoff, targetId, from, to, down: to.y > from.y + from.height }];
    });
  });
  // Lines sharing a card are spread along its edge, ordered so they do not cross.
  const port = (
    edge: (typeof handoffs)[number],
    shared: (other: (typeof handoffs)[number]) => boolean,
    far: (other: (typeof handoffs)[number]) => Box,
  ) => {
    const group = handoffs
      .filter((other) => other.down && shared(other))
      .toSorted((a, b) => far(a).x + far(a).width / 2 - (far(b).x + far(b).width / 2));
    return (group.indexOf(edge) - (group.length - 1) / 2) * PORT_GAP;
  };

  let right = 0;
  const taken: Array<Box> = [...nodes];
  for (const edge of handoffs) {
    const { from, to } = edge;
    let curve: Curve;
    if (edge.down) {
      const fromX =
        from.x +
        from.width / 2 +
        port(
          edge,
          (other) => other.agent === edge.agent,
          (other) => other.to,
        );
      const toX =
        to.x +
        to.width / 2 +
        port(
          edge,
          (other) => other.targetId === edge.targetId,
          (other) => other.from,
        );
      const fromY = from.y + from.height;
      const bend = Math.max(24, (to.y - fromY) / 2);
      curve = [
        [fromX, fromY],
        [fromX, fromY + bend],
        [toX, to.y - bend],
        [toX, to.y],
      ];
    } else {
      // A handoff to an agent that is not below: out of the right side and around.
      const fromX = from.x + from.width;
      const fromY = from.y + from.height / 2;
      const toX = to.x + to.width;
      const toY = to.y + to.height / 2;
      const reach = Math.max(fromX, toX) + 56;
      right = Math.max(right, reach);
      curve = [
        [fromX, fromY],
        [reach, fromY],
        [reach, toY],
        [toX, toY],
      ];
    }
    const label = edge.handoff.when ?? null;
    let spot = curvePoint(curve, LABEL_SPOTS[0]!);
    if (label !== null) {
      const free = LABEL_SPOTS.map((t) => curvePoint(curve, t)).find(
        (point) => !taken.some((box) => overlap(box, labelBox(label, point))),
      );
      spot = free ?? spot;
      taken.push(labelBox(label, spot));
    }
    edges.push({
      id: `${edge.agent.id}>${edge.targetId}`,
      kind: "handoff",
      agentIds: edge.handoff.to.type === "agent" ? [edge.agent.id, edge.targetId] : [edge.agent.id],
      path: curvePath(curve),
      asks: edge.handoff.autonomy === "ask",
      label,
      labelX: spot[0],
      labelY: spot[1],
    });
  }

  return {
    width: Math.max(right, ...nodes.map((node) => node.x + node.width), 0),
    height: nodes.length === 0 ? 0 : top - ROW_GAP,
    nodes,
    edges,
  };
}
