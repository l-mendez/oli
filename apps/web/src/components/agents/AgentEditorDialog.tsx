import { useAtomValue } from "@effect/atom-react";
import {
  type Agent,
  type AgentHandoffAutonomy,
  AuthOrchestrationOperateScope,
  clampManagedRuntimeMode,
  type EnvironmentId,
  type ModelSelection,
  ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolvePastedPath } from "@t3tools/shared/path";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import {
  scheduledTaskDefaultModel,
  WEEKDAY_LABELS,
} from "../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import {
  type AgentDraft,
  type AgentWorkspaceMode,
  agentToDraft,
  agentUpsertInputFromDraft,
  HANDOFF_TO_PERSON,
  type HandoffDraft,
  newAgentDraft,
  newHandoffDraft,
  newTriggerDraft,
  type TriggerDraft,
  type TriggerWhen,
} from "./agents.logic";

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

const WORKSPACE_MODE_LABELS: Record<AgentWorkspaceMode, string> = {
  worktree: "A new worktree for each run",
  root: "The project checkout",
  existing_worktree: "A specific checkout",
};

const HANDOFF_AUTONOMY_LABELS: Record<AgentHandoffAutonomy, string> = {
  auto: "Without asking",
  ask: "After a person agrees",
};

// Unsaved triggers and handoffs need a key that survives reordering and removal.
let newRowSeed = 0;
const newRowKey = () => `new:${newRowSeed++}`;

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

function splitModelKey(value: string): ModelSelection | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, index)),
    model: value.slice(index + 1),
  };
}

export function AgentEditorDialog({
  environmentId,
  agent,
  agents,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: Agent | null;
  /** Every agent here, for choosing who this one hands off to. */
  readonly agents: ReadonlyArray<Agent>;
  readonly onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      {/* The form owns the draft so a keystroke re-renders it, not the dialog chrome. */}
      <DialogPopup className="max-w-xl">
        <AgentEditorForm
          environmentId={environmentId}
          agent={agent}
          agents={agents}
          saving={saving}
          onSavingChange={setSaving}
          onClose={onClose}
        />
      </DialogPopup>
    </Dialog>
  );
}

function AgentEditorForm({
  environmentId,
  agent,
  agents,
  saving,
  onSavingChange: setSaving,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: Agent | null;
  readonly agents: ReadonlyArray<Agent>;
  readonly saving: boolean;
  readonly onSavingChange: (saving: boolean) => void;
  readonly onClose: () => void;
}) {
  const environment = useEnvironment(environmentId);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const allProjects = useProjects();
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canOperate = useAtomValue(serverEnvironment.upsertAgent.permissionAtom(environmentId));
  const upsertAgent = useAtomCommand(serverEnvironment.upsertAgent, { label: "agent upsert" });
  const environmentProjects = allProjects.filter(
    (project) => project.environmentId === environmentId,
  );
  const [draft, setDraft] = useState<AgentDraft>(() => {
    if (agent) return agentToDraft(agent);
    const open = environmentProjects.filter((project) => project.archivedAt == null);
    const initial = open.find((project) => project.pinnedAt != null) ?? open[0];
    return newAgentDraft(initial?.id ?? "", newRowKey());
  });
  // Pinned first. The chosen project stays listed after it is archived.
  const projects = environmentProjects
    .filter((project) => project.archivedAt == null || project.id === draft.projectId)
    .toSorted((left, right) => Number(right.pinnedAt != null) - Number(left.pinnedAt != null));
  const selectedProject = projects.find((project) => project.id === draft.projectId);
  const instanceEntries = providerInstanceEntriesFor(
    providers,
    settings,
    selectedProject?.id ?? null,
  );
  const draftSelection = draft.modelKey ? splitModelKey(draft.modelKey) : null;
  const activeSelection =
    draftSelection &&
    instanceEntries.some((entry) => entry.instanceId === draftSelection.instanceId && entry.enabled)
      ? draftSelection
      : scheduledTaskDefaultModel(settings, selectedProject ?? null, instanceEntries);
  const activeInstanceId =
    activeSelection?.instanceId ?? instanceEntries[0]?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = activeSelection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    activeModel,
  );
  const submissionPending = useRef(false);

  const patch = (change: Partial<AgentDraft>) => setDraft((current) => ({ ...current, ...change }));
  const patchTrigger = (key: string, change: Partial<TriggerDraft>) =>
    setDraft((current) => ({
      ...current,
      triggers: current.triggers.map((trigger) =>
        trigger.key === key ? { ...trigger, ...change } : trigger,
      ),
    }));

  const patchHandoff = (key: string, change: Partial<HandoffDraft>) =>
    setDraft((current) => ({
      ...current,
      handoffs: current.handoffs.map((handoff) =>
        handoff.key === key ? { ...handoff, ...change } : handoff,
      ),
    }));
  const otherAgents = agents.filter((entry) => entry.id !== draft.id);

  const reportFailure = (title: string, description: string) => {
    toastManager.add(stackedThreadToast({ type: "error", title, description }));
  };

  const submit = async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current ||
      saving ||
      !connected
    )
      return;
    const input = agentUpsertInputFromDraft(draft, activeSelection);
    if ("error" in input) {
      reportFailure("The agent is incomplete", input.error);
      return;
    }
    // Lock before React renders, and keep successful saves locked until the form closes.
    submissionPending.current = true;
    setSaving(true);
    const result = await upsertAgent({
      environmentId,
      input: {
        ...input,
        // A mode above the administrator's ceiling would fail every run.
        runtimeMode:
          clampManagedRuntimeMode(environment?.serverConfig?.managedPolicy, input.runtimeMode) ??
          input.runtimeMode,
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not save the agent", String(squashAtomCommandFailure(result)));
      }
      return;
    }
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{agent ? `Edit ${agent.name}` : "New agent"}</DialogTitle>
        <DialogDescription>
          An agent is a standing role. It wakes on its triggers, and every run starts from its role,
          the files it reads first, and what it remembers.
        </DialogDescription>
      </DialogHeader>

      <DialogPanel>
        {/* Fieldsets default to min-width: min-content, which lets one wide control widen the form past the dialog. */}
        <fieldset disabled={saving} className="min-w-0 space-y-5">
          {!connected ? (
            <p className="text-sm text-destructive">Reconnect this environment before saving.</p>
          ) : null}

          <Field label="Name" htmlFor="agent-name">
            <Input
              id="agent-name"
              placeholder="e.g. merge-steward"
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </Field>

          <Field label="Role" htmlFor="agent-role">
            <Textarea
              id="agent-role"
              className="max-h-64 min-h-28 overflow-y-auto"
              placeholder="What this agent is responsible for, and how it works."
              value={draft.role}
              onChange={(event) => patch({ role: event.target.value })}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Project" htmlFor="agent-project">
              <Select
                value={draft.projectId}
                onValueChange={(projectId) =>
                  patch({
                    projectId: projectId ?? "",
                    modelKey: "",
                    baseRef: "main",
                    startFromOrigin: true,
                  })
                }
              >
                <SelectTrigger size="sm" id="agent-project">
                  <SelectValue placeholder="Select a project">{selectedProject?.title}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id} label={project.title}>
                      <span className="block truncate">{project.title}</span>
                      <span className="block max-w-72 truncate text-xs text-muted-foreground">
                        {project.workspaceRoot}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>

            <Field label="Model">
              <div>
                <ProviderModelPicker
                  environmentId={environmentId}
                  disabled={saving || !connected}
                  activeInstanceId={activeInstanceId}
                  model={activeModel}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  isComposerOwned={false}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onInstanceModelChange={(instanceId, model) =>
                    patch({ modelKey: `${instanceId}:${model}` })
                  }
                />
              </div>
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Works in" htmlFor="agent-workspace">
              <Select
                value={draft.workspaceMode}
                onValueChange={(value) => patch({ workspaceMode: value as AgentWorkspaceMode })}
              >
                <SelectTrigger size="sm" id="agent-workspace">
                  <SelectValue>{WORKSPACE_MODE_LABELS[draft.workspaceMode]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="worktree">{WORKSPACE_MODE_LABELS.worktree}</SelectItem>
                  <SelectItem value="root">{WORKSPACE_MODE_LABELS.root}</SelectItem>
                  <SelectItem value="existing_worktree">
                    {WORKSPACE_MODE_LABELS.existing_worktree}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </Field>

            <Field label="Permissions" htmlFor="agent-runtime-mode">
              <Select
                value={draft.runtimeMode}
                onValueChange={(value) => patch({ runtimeMode: value as RuntimeMode })}
              >
                <SelectTrigger size="sm" id="agent-runtime-mode">
                  <SelectValue>{runtimeModeConfig[draft.runtimeMode].label}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {runtimeModeOptions.map((mode) => (
                    <SelectItem key={mode} value={mode} label={runtimeModeConfig[mode].label}>
                      <span className="block">{runtimeModeConfig[mode].label}</span>
                      <span className="block max-w-72 text-xs text-muted-foreground">
                        {runtimeModeConfig[mode].description}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          </div>

          {draft.workspaceMode === "worktree" ? (
            <Field label="Base branch" htmlFor="agent-base-ref">
              <WorktreeBaseBranchPicker
                key={`${environmentId}:${draft.projectId}`}
                id="agent-base-ref"
                environmentId={environmentId}
                cwd={selectedProject?.workspaceRoot ?? null}
                value={draft.baseRef}
                onValueChange={(baseRef) => patch({ baseRef })}
                startFromOrigin={draft.startFromOrigin}
                onStartFromOriginChange={(startFromOrigin) => patch({ startFromOrigin })}
                disabled={saving || !connected}
              />
            </Field>
          ) : null}
          {draft.workspaceMode === "existing_worktree" ? (
            <Field label="Checkout path" htmlFor="agent-checkout">
              <Input
                id="agent-checkout"
                value={draft.existingWorktreePath}
                placeholder="/path/to/checkout"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    existingWorktreePath: resolvePastedPath(
                      current.existingWorktreePath,
                      event.target.value,
                    ),
                  }))
                }
              />
            </Field>
          ) : null}

          <Field label="Reads first" hint="one path per line, optional" htmlFor="agent-context">
            <Textarea
              id="agent-context"
              className="max-h-40 overflow-y-auto"
              placeholder={"docs/architecture.md\ndocs/release-checklist.md"}
              value={draft.contextText}
              onChange={(event) => patch({ contextText: event.target.value })}
            />
          </Field>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <Label>Wakes on</Label>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={draft.triggers.length >= 16}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    triggers: [...current.triggers, newTriggerDraft(newRowKey())],
                  }))
                }
              >
                <PlusIcon className="size-3" />
                Add trigger
              </Button>
            </div>
            {draft.triggers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Without a trigger this agent is saved but never runs.
              </p>
            ) : null}
            {draft.triggers.map((trigger) => (
              <TriggerFields
                key={trigger.key}
                trigger={trigger}
                onChange={(change) => patchTrigger(trigger.key, change)}
                onRemove={() =>
                  setDraft((current) => ({
                    ...current,
                    triggers: current.triggers.filter((entry) => entry.key !== trigger.key),
                  }))
                }
              />
            ))}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <Label>Hands off to</Label>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={draft.handoffs.length >= 16}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    handoffs: [...current.handoffs, newHandoffDraft(newRowKey())],
                  }))
                }
              >
                <PlusIcon className="size-3" />
                Add handoff
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Who this agent passes work to. These are the lines on the graph; agents do not act on
              them yet.
            </p>
            {draft.handoffs.map((handoff) => (
              <HandoffFields
                key={handoff.key}
                handoff={handoff}
                agents={otherAgents}
                onChange={(change) => patchHandoff(handoff.key, change)}
                onRemove={() =>
                  setDraft((current) => ({
                    ...current,
                    handoffs: current.handoffs.filter((entry) => entry.key !== handoff.key),
                  }))
                }
              />
            ))}
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="agent-enabled">Enabled</Label>
              <p id="agent-enabled-description" className="text-sm text-muted-foreground">
                A paused agent keeps its role and memory but does not wake.
              </p>
            </div>
            <Switch
              id="agent-enabled"
              aria-describedby="agent-enabled-description"
              checked={draft.enabled}
              onCheckedChange={(enabled) => patch({ enabled })}
            />
          </div>
        </fieldset>
      </DialogPanel>

      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
          Cancel
        </DialogClose>
        <Button
          size="sm"
          disabled={!canOperate || saving || !connected}
          onClick={() => void submit()}
        >
          {agent ? "Save agent" : "Create agent"}
        </Button>
      </DialogFooter>
    </>
  );
}

function HandoffFields({
  handoff,
  agents,
  onChange,
  onRemove,
}: {
  readonly handoff: HandoffDraft;
  readonly agents: ReadonlyArray<Agent>;
  readonly onChange: (change: Partial<HandoffDraft>) => void;
  readonly onRemove: () => void;
}) {
  const targetLabel =
    handoff.target === HANDOFF_TO_PERSON
      ? "A person"
      : (agents.find((agent) => agent.id === handoff.target)?.name ?? "A deleted agent");
  return (
    <div className="space-y-2 rounded-lg border border-border/70 p-3">
      <div className="flex items-center gap-2">
        <Select
          value={handoff.target}
          onValueChange={(target) => {
            if (target !== null) onChange({ target });
          }}
        >
          <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="Hands off to">
            <SelectValue>{targetLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={HANDOFF_TO_PERSON}>A person</SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={handoff.autonomy}
          onValueChange={(autonomy) => onChange({ autonomy: autonomy as AgentHandoffAutonomy })}
        >
          <SelectTrigger size="sm" className="w-48 shrink-0" aria-label="How it hands off">
            <SelectValue>{HANDOFF_AUTONOMY_LABELS[handoff.autonomy]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="auto">{HANDOFF_AUTONOMY_LABELS.auto}</SelectItem>
            <SelectItem value="ask">{HANDOFF_AUTONOMY_LABELS.ask}</SelectItem>
          </SelectPopup>
        </Select>
        <Button size="icon-sm" variant="ghost" aria-label="Remove handoff" onClick={onRemove}>
          <Trash2Icon className="size-4" />
        </Button>
      </div>
      <Input
        aria-label="When it hands off"
        placeholder="When? e.g. the change is ready for review (optional)"
        value={handoff.when}
        onChange={(event) => onChange({ when: event.target.value })}
      />
    </div>
  );
}

function TriggerFields({
  trigger,
  onChange,
  onRemove,
}: {
  readonly trigger: TriggerDraft;
  readonly onChange: (change: Partial<TriggerDraft>) => void;
  readonly onRemove: () => void;
}) {
  const id = `agent-trigger-${trigger.key}`;
  return (
    <div className="space-y-3 rounded-lg border border-border/70 p-3">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Trigger name"
          placeholder="e.g. Every weekday morning"
          value={trigger.label}
          onChange={(event) => onChange({ label: event.target.value })}
        />
        <Switch
          checked={trigger.enabled}
          aria-label="Trigger enabled"
          onCheckedChange={(enabled) => onChange({ enabled })}
        />
        <Button size="icon-sm" variant="ghost" aria-label="Remove trigger" onClick={onRemove}>
          <Trash2Icon className="size-4" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          aria-label="When it fires"
          value={[trigger.when]}
          onValueChange={(values) => {
            const when = values[0] as TriggerWhen | undefined;
            if (when !== undefined) onChange({ when });
          }}
        >
          <Toggle value="fixed">At a time</Toggle>
          <Toggle value="interval">Every interval</Toggle>
          <Toggle value="webhook">On webhook</Toggle>
          {/* One-time schedules are made elsewhere; a saved one stays selectable so it is kept. */}
          {trigger.stored?.type === "once" ? <Toggle value="once">Once</Toggle> : null}
        </ToggleGroup>

        {trigger.when === "fixed" ? (
          <>
            <Input
              type="time"
              nativeInput
              aria-label="Time of day"
              className="w-32"
              value={trigger.timeOfDay}
              onChange={(event) => onChange({ timeOfDay: event.target.value })}
            />
            <ToggleGroup
              multiple
              variant="outline"
              size="sm"
              aria-label="Days to run"
              value={[...trigger.weekdays].map(String)}
              onValueChange={(values) => {
                if (values.length > 0) onChange({ weekdays: new Set(values.map(Number)) });
              }}
            >
              {WEEKDAY_ORDER.map((day) => (
                <Toggle key={day} value={String(day)} aria-label={WEEKDAY_LABELS[day]}>
                  {WEEKDAY_SHORT[day]}
                </Toggle>
              ))}
            </ToggleGroup>
          </>
        ) : trigger.when === "interval" ? (
          <div className="flex items-center gap-2">
            <Input
              type="number"
              nativeInput
              min={1}
              step="any"
              aria-label="Interval in minutes"
              className="w-24"
              value={trigger.intervalMinutes}
              onChange={(event) => onChange({ intervalMinutes: event.target.value })}
            />
            <span className="text-xs text-muted-foreground">minutes</span>
          </div>
        ) : null}
      </div>

      {trigger.when === "webhook" ? (
        <p className="text-xs text-muted-foreground">
          {
            "Each request wakes the agent. The address appears once the agent is saved. Use {{body.path}}, {{headers.name}} or {{query.name}} below; only what you name reaches the agent."
          }
        </p>
      ) : null}

      <Textarea
        id={id}
        aria-label="What the agent does"
        className="max-h-40 overflow-y-auto"
        placeholder="What the agent does when this fires."
        value={trigger.instruction}
        onChange={(event) => onChange({ instruction: event.target.value })}
      />
    </div>
  );
}
