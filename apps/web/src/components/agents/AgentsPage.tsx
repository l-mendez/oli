import { useAtomValue } from "@effect/atom-react";
import {
  type Agent,
  type AgentId,
  type AgentMemoryEntry,
  type AgentTrigger,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ScheduledRelativeLabel } from "../settings/ScheduledTasksSettings";
import { scheduleLabel } from "../settings/scheduledTasksSettings.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AgentEditorDialog } from "./AgentEditorDialog";
import { AgentGraph } from "./AgentGraph";
import { agentToDraft, agentUpsertInputFromDraft } from "./agents.logic";
import { AgentSummary, agentState, STATE_DOT_CLASS, triggerTasks } from "./agentStatus";

export type AgentsView = "graph" | "list";

function isConnected(environment: EnvironmentPresentation | undefined) {
  return environment?.connection.phase === "connected" && environment.serverConfig !== null;
}

function reportFailure(title: string, description: string) {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

export function AgentsPage({
  agentId,
  view,
}: {
  readonly agentId: AgentId | undefined;
  readonly view: AgentsView;
}) {
  const navigate = useNavigate({ from: "/agents" });
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedEnvironments = environments.filter(isConnected);
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);
  const environment =
    connectedEnvironments.find((entry) => entry.environmentId === chosenEnvironmentId) ??
    connectedEnvironments.find((entry) => entry.environmentId === primaryEnvironmentId) ??
    connectedEnvironments[0];
  const environmentId = environment?.environmentId;
  const agentsQuery = useEnvironmentQuery(
    environmentId === undefined ? null : serverEnvironment.agentsLive({ environmentId, input: {} }),
  );
  const tasksQuery = useEnvironmentQuery(
    environmentId === undefined
      ? null
      : serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const [editor, setEditor] = useState<{ readonly agent: Agent | null } | null>(null);

  const agents = agentsQuery.data?.agents ?? [];
  const tasksById = new Map(
    (tasksQuery.data?.tasks ?? []).map((task) => [task.id as string, task]),
  );
  // The list always shows someone; the graph can be looked at with nobody picked.
  const picked = agents.find((agent) => agent.id === agentId);
  const selected = picked ?? (view === "list" ? agents[0] : undefined);
  const show = (next: { readonly agent: AgentId | undefined; readonly view: AgentsView }) =>
    void navigate({
      to: "/agents",
      search: {
        ...(next.agent === undefined ? {} : { agent: next.agent }),
        ...(next.view === "list" ? { view: "list" as const } : {}),
      },
      replace: true,
    });
  const select = (id: AgentId | undefined) => show({ agent: id, view });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <h1 className="text-sm font-medium">Agents</h1>
          <div className="flex-1" />
          {agents.length > 0 ? (
            <ToggleGroup
              aria-label="View"
              value={[view]}
              onValueChange={(values) => {
                const next = values[0] as AgentsView | undefined;
                if (next !== undefined) show({ agent: picked?.id, view: next });
              }}
            >
              <Toggle value="graph">Graph</Toggle>
              <Toggle value="list">List</Toggle>
            </ToggleGroup>
          ) : null}
          {connectedEnvironments.length > 1 && environment ? (
            <Select
              value={environment.environmentId}
              onValueChange={(id) => {
                setChosenEnvironmentId(id as EnvironmentId);
                select(undefined);
              }}
            >
              <SelectTrigger size="sm" className="w-44" aria-label="Runs on">
                <SelectValue>{environment.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {connectedEnvironments.map((entry) => (
                  <SelectItem key={entry.environmentId} value={entry.environmentId}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={environmentId === undefined}
            onClick={() => setEditor({ agent: null })}
          >
            <PlusIcon className="size-3" />
            New agent
          </Button>
        </WorkspacePageHeader>

        {environmentId === undefined ? (
          <PageMessage title="No computer connected">
            Connect a computer to create agents on it.
          </PageMessage>
        ) : agentsQuery.error ? (
          <PageMessage title="Agents are not available here">{agentsQuery.error}</PageMessage>
        ) : agentsQuery.data === null ? null : agents.length === 0 ? (
          <PageMessage
            title="No agents yet"
            action={
              <Button size="sm" onClick={() => setEditor({ agent: null })}>
                New agent
              </Button>
            }
          >
            An agent is a standing role. It wakes on a schedule or a webhook, does its work in a
            fresh run, and keeps what it learns for next time.
          </PageMessage>
        ) : view === "graph" ? (
          <div className="relative flex min-h-0 flex-1">
            <AgentGraph
              agents={agents}
              tasksById={tasksById}
              timeZone={tasksQuery.data?.timeZone}
              selectedId={selected?.id}
              onSelect={select}
            />
            {selected === undefined ? null : (
              <aside
                aria-label={selected.name}
                className="flex w-104 shrink-0 border-l border-border bg-background max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:w-full max-lg:max-w-104"
              >
                <AgentDetail
                  key={selected.id}
                  environmentId={environmentId}
                  agent={selected}
                  agents={agents}
                  tasksById={tasksById}
                  timeZone={tasksQuery.data?.timeZone}
                  onEdit={() => setEditor({ agent: selected })}
                  onSelect={select}
                  onClose={() => select(undefined)}
                />
              </aside>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <nav
              aria-label="Agents"
              className="w-64 shrink-0 overflow-y-auto border-r border-border p-2 max-md:w-48"
            >
              {agents.map((agent) => {
                const tasks = triggerTasks(agent, tasksById);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    aria-current={agent.id === selected?.id}
                    onClick={() => select(agent.id)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-accent/50",
                      agent.id === selected?.id && "bg-accent",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        STATE_DOT_CLASS[agentState(agent, tasks)],
                      )}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{agent.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        <AgentSummary agent={agent} tasks={tasks} />
                      </span>
                    </span>
                  </button>
                );
              })}
            </nav>
            {selected === undefined ? null : (
              <AgentDetail
                key={selected.id}
                environmentId={environmentId}
                agent={selected}
                agents={agents}
                tasksById={tasksById}
                timeZone={tasksQuery.data?.timeZone}
                onEdit={() => setEditor({ agent: selected })}
                onSelect={select}
              />
            )}
          </div>
        )}
      </div>
      {editor && environmentId !== undefined ? (
        <AgentEditorDialog
          key={editor.agent?.id ?? "new"}
          environmentId={environmentId}
          agent={editor.agent}
          agents={agents}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </SidebarInset>
  );
}

function PageMessage({
  title,
  action,
  children,
}: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function AgentDetail({
  environmentId,
  agent,
  agents,
  tasksById,
  timeZone,
  onEdit,
  onSelect,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: Agent;
  readonly agents: ReadonlyArray<Agent>;
  readonly tasksById: ReadonlyMap<string, ScheduledTask>;
  readonly timeZone: string | undefined;
  readonly onEdit: () => void;
  readonly onSelect: (id: AgentId) => void;
  /** Given when the detail sits beside the graph and can be put away. */
  readonly onClose?: () => void;
}) {
  const canOperate = useAtomValue(serverEnvironment.upsertAgent.permissionAtom(environmentId));
  const project = useProjects().find(
    (entry) => entry.environmentId === environmentId && entry.id === agent.projectId,
  );
  const upsertAgent = useAtomCommand(serverEnvironment.upsertAgent, { label: "agent upsert" });
  const deleteAgent = useAtomCommand(serverEnvironment.deleteAgent, { label: "agent delete" });
  const [busy, setBusy] = useState(false);

  const setEnabled = async (enabled: boolean) => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const input = agentUpsertInputFromDraft(
      { ...agentToDraft(agent), enabled },
      agent.modelSelection,
    );
    if ("error" in input) return reportFailure("Could not update the agent", input.error);
    setBusy(true);
    const result = await upsertAgent({ environmentId, input });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not update the agent", String(squashAtomCommandFailure(result)));
    }
  };

  const remove = async () => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const message = `Delete "${agent.name}"?\nIts triggers, memory and history are removed. This cannot be undone.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    setBusy(true);
    const result = await deleteAgent({ environmentId, input: { id: agent.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not delete the agent", String(squashAtomCommandFailure(result)));
    }
  };

  return (
    <div className="scrollbar-gutter-both min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 pt-6 pb-16">
        <header className="space-y-1">
          <div className="flex items-center gap-3">
            <h2 className="min-w-0 flex-1 truncate text-lg font-medium">{agent.name}</h2>
            <Switch
              checked={agent.enabled}
              disabled={busy || !canOperate}
              aria-label={`Enable ${agent.name}`}
              onCheckedChange={(enabled) => void setEnabled(enabled)}
            />
            <Button size="xs" variant="outline" disabled={!canOperate} onClick={onEdit}>
              <PencilIcon className="size-3" />
              Edit
            </Button>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={busy || !canOperate}
                    aria-label={`Actions for ${agent.name}`}
                  />
                }
              >
                <MoreHorizontalIcon className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => void remove()}>
                  <Trash2Icon />
                  Delete
                </MenuItem>
              </MenuPopup>
            </Menu>
            {onClose ? (
              <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose}>
                <XIcon className="size-4" />
              </Button>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {project?.title ?? "Unknown project"} · {agent.modelSelection.model} · version{" "}
            {agent.version}
          </p>
        </header>

        <Section title="Role">
          <p className="text-sm whitespace-pre-wrap">{agent.role}</p>
        </Section>

        <Section title="Wakes on">
          {agent.triggers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing wakes this agent yet. Edit it to add a trigger.
            </p>
          ) : (
            <div className="divide-y divide-border/60 rounded-lg border border-border/70">
              {agent.triggers.map((trigger) => (
                <TriggerRow
                  key={trigger.id}
                  environmentId={environmentId}
                  agentEnabled={agent.enabled}
                  trigger={trigger}
                  task={tasksById.get(trigger.taskId)}
                  timeZone={timeZone}
                  canOperate={canOperate}
                />
              ))}
            </div>
          )}
        </Section>

        {agent.handoffs.length > 0 ? (
          <Section title="Hands off to">
            <ul className="divide-y divide-border/60 rounded-lg border border-border/70">
              {agent.handoffs.map((handoff) => {
                const targetId = handoff.to.type === "agent" ? handoff.to.agentId : null;
                const target = agents.find((entry) => entry.id === targetId);
                return (
                  <li key={targetId ?? "person"} className="space-y-0.5 px-3.5 py-2.5">
                    <p className="text-sm">
                      {handoff.to.type === "human" ? (
                        "A person"
                      ) : target === undefined ? (
                        <span className="text-muted-foreground">A deleted agent</span>
                      ) : (
                        <button
                          type="button"
                          className="underline-offset-4 hover:underline"
                          onClick={() => onSelect(target.id)}
                        >
                          {target.name}
                        </button>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {handoff.autonomy === "auto" ? "Without asking" : "After a person agrees"}
                      {handoff.when ? ` · ${handoff.when}` : null}
                    </p>
                  </li>
                );
              })}
            </ul>
          </Section>
        ) : null}

        {agent.context.length > 0 ? (
          <Section title="Reads first">
            <ul className="space-y-1 font-mono text-xs">
              {agent.context.map((file) => (
                <li key={file.path} className="truncate">
                  {file.path}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <AgentMemory environmentId={environmentId} agentId={agent.id} canOperate={canOperate} />
      </div>
    </div>
  );
}

function TriggerRow({
  environmentId,
  agentEnabled,
  trigger,
  task,
  timeZone,
  canOperate,
}: {
  readonly environmentId: EnvironmentId;
  readonly agentEnabled: boolean;
  readonly trigger: AgentTrigger;
  readonly task: ScheduledTask | undefined;
  readonly timeZone: string | undefined;
  readonly canOperate: boolean;
}) {
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "agent trigger run now",
  });
  const [busy, setBusy] = useState(false);
  const isWebhook = trigger.schedule.type === "webhook";
  const runNow = async () => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    setBusy(true);
    const result = await run({ environmentId, input: { id: trigger.taskId } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not start the run", String(squashAtomCommandFailure(result)));
    }
  };
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3.5 py-3">
      <div className="min-w-48 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{trigger.label}</span>
          {task && task.lastRunStatus !== "never" ? (
            <Badge
              variant={
                task.lastRunStatus === "failed"
                  ? "error"
                  : task.lastRunStatus === "succeeded"
                    ? "success"
                    : "info"
              }
            >
              {task.lastRunStatus}
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {scheduleLabel(trigger.schedule, timeZone, task?.nextRunAt)} ·{" "}
          {task?.blockedByPolicy !== undefined ? (
            task.blockedByPolicy
          ) : !agentEnabled || !trigger.enabled ? (
            "Paused"
          ) : isWebhook ? (
            "Listening"
          ) : task?.nextRunAt ? (
            <>
              Next run <ScheduledRelativeLabel value={task.nextRunAt} />
            </>
          ) : (
            "Not scheduled"
          )}
          {task && task.runCount > 0 ? ` · ${task.runCount} runs` : null}
        </p>
        <p className="line-clamp-2 text-xs text-muted-foreground/80">{trigger.instruction}</p>
        {task?.lastRunError ? (
          <p className="text-xs text-destructive">{task.lastRunError}</p>
        ) : null}
      </div>
      {isWebhook ? (
        <Button
          size="xs"
          variant="ghost-muted"
          render={
            <Link
              to="/settings/scheduled-tasks"
              search={{ environmentId, taskId: trigger.taskId }}
            />
          }
        >
          Address and deliveries
        </Button>
      ) : (
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={busy || !canOperate}
          onClick={() => void runNow()}
        >
          <PlayIcon className="size-3" />
          Run now
        </Button>
      )}
    </div>
  );
}

function AgentMemory({
  environmentId,
  agentId,
  canOperate,
}: {
  readonly environmentId: EnvironmentId;
  readonly agentId: AgentId;
  readonly canOperate: boolean;
}) {
  const memoryQuery = useEnvironmentQuery(
    serverEnvironment.agentMemory({ environmentId, input: { agentId } }),
  );
  const remember = useAtomCommand(serverEnvironment.rememberForAgent, { label: "agent remember" });
  const forget = useAtomCommand(serverEnvironment.forgetAgentMemory, { label: "agent forget" });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const entries = memoryQuery.data?.entries ?? [];

  const add = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      return;
    }
    setBusy(true);
    const result = await remember({
      environmentId,
      input: { agentId, text: trimmed, source: { type: "user" } },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not save the memory", String(squashAtomCommandFailure(result)));
      }
      return;
    }
    setText("");
    memoryQuery.refresh();
  };

  const remove = async (entry: AgentMemoryEntry) => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    setBusy(true);
    const result = await forget({ environmentId, input: { agentId, entryId: entry.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not remove the memory", String(squashAtomCommandFailure(result)));
    }
    memoryQuery.refresh();
  };

  return (
    <Section title="Memory">
      {memoryQuery.error ? <p className="text-sm text-destructive">{memoryQuery.error}</p> : null}
      {memoryQuery.data !== null && entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing yet. What this agent remembers is included at the start of every run.
        </p>
      ) : null}
      {entries.length > 0 ? (
        <ul className="divide-y divide-border/60 rounded-lg border border-border/70">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3 px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm whitespace-pre-wrap">{entry.text}</p>
                <p className="text-xs text-muted-foreground">
                  {entry.source.type === "user" ? "Added by a person" : "Learned in a run"} ·{" "}
                  {formatRelativeTimeLabel(entry.createdAt, nowMs)}
                </p>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy || !canOperate}
                aria-label="Forget this"
                onClick={() => void remove(entry)}
              >
                <XIcon className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-end gap-2">
        <Textarea
          aria-label="Something this agent should remember"
          className="max-h-32 min-h-9 overflow-y-auto"
          placeholder="Tell it something to remember from now on."
          value={text}
          disabled={!canOperate}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void add();
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !canOperate || !text.trim()}
          onClick={() => void add()}
        >
          Remember
        </Button>
      </div>
    </Section>
  );
}
