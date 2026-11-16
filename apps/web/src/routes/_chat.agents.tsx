import { AgentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { AgentsPage } from "../components/agents/AgentsPage";

function AgentsRoute() {
  const { agent, view } = Route.useSearch();
  return <AgentsPage agentId={agent} view={view ?? "graph"} />;
}

export const Route = createFileRoute("/_chat/agents")({
  // The graph is the default view, so only the list is written into the address.
  validateSearch: (raw: Record<string, unknown>): { agent?: AgentId; view?: "list" } => ({
    ...(typeof raw.agent === "string" && raw.agent.trim().length > 0
      ? { agent: AgentId.make(raw.agent.trim().slice(0, 200)) }
      : {}),
    ...(raw.view === "list" ? { view: "list" as const } : {}),
  }),
  component: AgentsRoute,
});
