import { type QueryClient, useQuery } from "@tanstack/react-query"
import type { AgentSummary } from "./agent"
import { apiFetch } from "./api"

/** Eventos que dejan obsoleto lo que el agente hizo o le pasó al equipo; el layout los escucha una sola vez. */
export const AGENT_WORK_EVENTS = [
  "agent.proposal.created",
  "agent.proposal.decided",
  "agent.proposal.executed",
  "agent.handoff.created",
  "agent.run.recorded",
  "task.updated",
  "stream.reconnected",
]

const WORK_KEYS = ["agent-summary", "agent-activity", "agent-proposals", "agent-handoffs", "workspace-home", "workspace-waiting", "tasks"]

export function invalidateAgentWork(queryClient: QueryClient): void {
  for (const key of WORK_KEYS) void queryClient.invalidateQueries({ queryKey: [key] })
}

/** Resumen ligero del agente, legible también con `agent.decide` (recepción). */
export function useAgentSummary(enabled: boolean) {
  return useQuery({
    queryKey: ["agent-summary"],
    queryFn: () => apiFetch<{ data: AgentSummary }>("/api/agent/summary"),
    enabled,
    refetchInterval: 60_000,
  })
}
