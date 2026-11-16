import type { Agent, AgentId, ScheduledTask } from "@t3tools/contracts";
import { ClockIcon, RepeatIcon, UserIcon, WebhookIcon } from "lucide-react";
import { type MouseEvent, useEffect, useId, useLayoutEffect, useState } from "react";

import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { scheduleLabel } from "../settings/scheduledTasksSettings.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type AgentGraphNode, layoutAgentGraph } from "./agentGraph.logic";
import { AgentSummary, agentState, STATE_DOT_CLASS, triggerTasks } from "./agentStatus";

/** Space kept clear around the drawing, in pixels. */
const STAGE_PADDING = 40;
/** Below this the names stop being readable, so the stage scrolls instead of shrinking further. */
const MIN_SCALE = 0.72;

const PILL_CLASS =
  "absolute flex items-center gap-1.5 rounded-full border px-2.5 text-xs text-muted-foreground";

function GraphNode({
  node,
  selected,
  tasksById,
  timeZone,
  onSelect,
}: {
  readonly node: AgentGraphNode;
  readonly selected: boolean;
  readonly tasksById: ReadonlyMap<string, ScheduledTask>;
  readonly timeZone: string | undefined;
  readonly onSelect: (id: AgentId) => void;
}) {
  const { agent } = node;
  const style = { left: node.x, top: node.y, width: node.width, height: node.height };
  const select = () => onSelect(agent.id);

  if (node.kind === "agent") {
    const tasks = triggerTasks(agent, tasksById);
    return (
      <button
        type="button"
        style={style}
        aria-pressed={selected}
        data-agent-node={agent.id}
        onClick={select}
        className={cn(
          "absolute flex scroll-m-10 flex-col justify-center gap-0.5 rounded-xl border border-border bg-card px-3 text-left shadow-xs transition-[border-color,box-shadow] hover:border-foreground/40",
          selected && "border-foreground/70 ring-4 ring-foreground/5 hover:border-foreground/70",
        )}
      >
        <span className="flex items-center gap-2">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              STATE_DOT_CLASS[agentState(agent, tasks)],
            )}
          />
          <span className="truncate text-sm font-medium">{agent.name}</span>
        </span>
        <span className="truncate pl-3.5 text-xs text-muted-foreground">
          <AgentSummary agent={agent} tasks={tasks} />
        </span>
      </button>
    );
  }

  if (node.kind === "person") {
    return (
      <button
        type="button"
        style={style}
        onClick={select}
        className={cn(PILL_CLASS, "border-border bg-card text-foreground")}
      >
        <UserIcon className="size-3.5 shrink-0 text-muted-foreground" />A person
      </button>
    );
  }

  if (node.kind === "more-triggers") {
    return (
      <button
        type="button"
        style={style}
        onClick={select}
        className={cn(PILL_CLASS, "border-dashed border-border bg-background")}
      >
        {node.count} more
      </button>
    );
  }

  const { trigger } = node;
  const Icon =
    trigger.schedule.type === "webhook"
      ? WebhookIcon
      : trigger.schedule.type === "interval"
        ? RepeatIcon
        : ClockIcon;
  const paused = !agent.enabled || !trigger.enabled;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            style={style}
            onClick={select}
            className={cn(
              PILL_CLASS,
              "border-dashed border-border bg-background hover:text-foreground",
              paused && "opacity-50",
            )}
          />
        }
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{trigger.label}</span>
      </TooltipTrigger>
      <TooltipPopup>
        {trigger.label} · {scheduleLabel(trigger.schedule, timeZone)}
        {paused ? " · Paused" : null}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Every agent, what wakes it, and who it hands work to. */
export function AgentGraph({
  agents,
  tasksById,
  timeZone,
  selectedId,
  onSelect,
}: {
  readonly agents: ReadonlyArray<Agent>;
  readonly tasksById: ReadonlyMap<string, ScheduledTask>;
  readonly timeZone: string | undefined;
  readonly selectedId: AgentId | undefined;
  readonly onSelect: (id: AgentId | undefined) => void;
}) {
  const layout = layoutAgentGraph(agents);
  const arrowId = useId();
  const [stage, setStage] = useState<HTMLElement | null>(null);
  const [room, setRoom] = useState<{ readonly width: number; readonly height: number } | null>(
    null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the stage before paint and remeasures through a ResizeObserver
  useLayoutEffect(() => {
    if (!stage) return;
    const measure = () =>
      setRoom({
        width: stage.clientWidth - STAGE_PADDING * 2,
        height: stage.clientHeight - STAGE_PADDING * 2,
      });
    measure();
    return observeResize(stage, measure);
  }, [stage]);
  // Shrink to fit the stage, never grow past full size.
  const scale =
    room === null || layout.width === 0
      ? 1
      : Math.max(MIN_SCALE, Math.min(1, room.width / layout.width, room.height / layout.height));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the stage's scroll position on the picked agent when the stage is too small to show everything
  useEffect(() => {
    if (stage === null || selectedId === undefined) return;
    stage
      .querySelector(`[data-agent-node="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [stage, selectedId]);
  const handoffs = layout.edges.filter((edge) => edge.kind === "handoff");
  const clearSelection = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button") === null) onSelect(undefined);
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {/* The click target is the backdrop itself; the nodes inside are the controls. */}
      <div
        ref={setStage}
        role="presentation"
        onClick={clearSelection}
        style={{
          padding: STAGE_PADDING,
          backgroundImage: "radial-gradient(var(--color-border) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
        className="scrollbar-gutter-both flex min-w-0 flex-1 overflow-auto"
      >
        {/* The outer box holds the shrunken size so the stage centres and scrolls by what is seen. */}
        <div
          className="m-auto shrink-0"
          style={{ width: layout.width * scale, height: layout.height * scale }}
        >
          <div
            className="relative origin-top-left"
            style={{
              width: layout.width,
              height: layout.height,
              transform: scale === 1 ? undefined : `scale(${scale})`,
            }}
          >
            <svg
              aria-hidden
              className="pointer-events-none absolute inset-0 overflow-visible"
              width={layout.width}
              height={layout.height}
              fill="none"
            >
              <defs>
                <marker
                  id={arrowId}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path d="M1,1 L7,4 L1,7" stroke="context-stroke" strokeWidth="1.25" />
                </marker>
              </defs>
              {layout.edges.map((edge) => {
                const highlighted = selectedId !== undefined && edge.agentIds.includes(selectedId);
                return (
                  <path
                    key={edge.id}
                    d={edge.path}
                    strokeWidth={1.25}
                    strokeDasharray={edge.asks ? "4 4" : undefined}
                    markerEnd={edge.kind === "handoff" ? `url(#${arrowId})` : undefined}
                    className={cn(
                      "transition-[stroke]",
                      highlighted
                        ? "stroke-foreground/70"
                        : edge.kind === "handoff"
                          ? "stroke-muted-foreground/60"
                          : "stroke-muted-foreground/35",
                    )}
                  />
                );
              })}
            </svg>
            {handoffs.map((edge) =>
              edge.label === null ? null : (
                <Tooltip key={edge.id}>
                  <TooltipTrigger
                    render={
                      <span
                        style={{ left: edge.labelX, top: edge.labelY }}
                        className="absolute max-w-44 -translate-x-1/2 -translate-y-1/2 truncate rounded-sm bg-background px-1.5 text-2xs text-muted-foreground"
                      />
                    }
                  >
                    {edge.label}
                  </TooltipTrigger>
                  <TooltipPopup>{edge.label}</TooltipPopup>
                </Tooltip>
              ),
            )}
            {layout.nodes.map((node) => (
              <GraphNode
                key={node.id}
                node={node}
                selected={node.kind === "agent" && node.agent.id === selectedId}
                tasksById={tasksById}
                timeZone={timeZone}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      </div>
      <p className="pointer-events-none absolute bottom-3 left-4 text-2xs text-muted-foreground">
        {handoffs.length === 0
          ? "Edit an agent and add a handoff to connect it to another."
          : "Solid line: hands off without asking · Dashed line: after a person agrees"}
      </p>
    </div>
  );
}
