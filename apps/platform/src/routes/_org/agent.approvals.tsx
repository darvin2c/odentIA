import { Badge, Field, FieldLabel, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { EmptyState, PageHeader, PageShell, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { ACTION_LABEL } from "../../lib/agent"
import { usePermission } from "../../lib/crm"

export const Route = createFileRoute("/_org/agent/approvals")({
  component: AgentApprovalsPage,
})

interface Proposal {
  id: string
  action: string
  status: string
  payload: Record<string, unknown>
  reason: string | null
  result: Record<string, unknown> | null
  error: string | null
  createdAt: string
}

interface Handoff {
  id: string
  reason: string
  summary: string
  priority: string
  assigneeUserId: string | null
  taskId: string | null
  createdAt: string
}


const STATUS_LABEL: Record<string, string> = {
  propuesta: "Pendiente",
  aprobada: "Aprobada",
  rechazada: "Rechazada",
  ejecutada: "Ejecutada",
  fallida: "Fallida",
  expirada: "Expirada",
}

function payloadSummary(payload: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof payload["startsAt"] === "string") {
    const date = new Date(payload["startsAt"])
    if (!Number.isNaN(date.getTime())) parts.push(date.toLocaleString("es-PE"))
  }
  if (typeof payload["appointmentId"] === "string") parts.push(`cita ${String(payload["appointmentId"]).slice(0, 8)}…`)
  return parts.join(" · ")
}

function AgentApprovalsPage() {
  const queryClient = useQueryClient()
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")
  const [statusFilter, setStatusFilter] = useState("propuesta")
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({})

  const proposalsQuery = useQuery({
    queryKey: ["agent-proposals", statusFilter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (statusFilter) params.set("status", statusFilter)
      return apiFetch<{ data: Proposal[] }>(`/api/agent/proposals?${params}`)
    },
    enabled: canRead,
  })
  const handoffsQuery = useQuery({
    queryKey: ["agent-handoffs"],
    queryFn: () => apiFetch<{ data: Handoff[] }>("/api/agent/handoffs?limit=30"),
    enabled: canRead,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["agent-proposals"] })
    void queryClient.invalidateQueries({ queryKey: ["agent-handoffs"] })
  }

  const decideMutation = useMutation({
    mutationFn: (input: { id: string; decision: "aprobada" | "rechazada"; reason?: string }) =>
      apiFetch(`/api/agent/proposals/${input.id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: input.decision, reason: input.reason }),
      }),
    onSuccess: () => invalidate(),
  })

  const executeMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/agent/proposals/${id}/execute`, { method: "POST" }),
    onSuccess: () => invalidate(),
  })

  if (!canRead) {
    return (
      <PageShell>
        <EmptyState title="Sin acceso" description="No tienes acceso a las aprobaciones del agente." />
      </PageShell>
    )
  }

  const proposals = proposalsQuery.data?.data ?? []
  const handoffs = handoffsQuery.data?.data ?? []
  const error =
    decideMutation.error instanceof ApiError
      ? (decideMutation.error.shape.message ?? "No pudimos decidir")
      : decideMutation.error ?? executeMutation.error
        ? "No pudimos procesar la propuesta"
        : null

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader title="Aprobaciones del agente" subtitle="Actos sensibles pendientes y derivaciones a humano" />
      <div className="flex items-center gap-2">
        <Field className="w-56">
          <FieldLabel htmlFor="filtro-estado">Estado</FieldLabel>
          <Select
            value={statusFilter || "todos"}
            onValueChange={(value) => setStatusFilter(value === "todos" ? "" : (value ?? ""))}
          >
            <SelectTrigger id="filtro-estado" aria-label="Estado">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos</SelectItem>
              <SelectItem value="propuesta">Pendientes</SelectItem>
              <SelectItem value="aprobada">Aprobadas</SelectItem>
              <SelectItem value="ejecutada">Ejecutadas</SelectItem>
              <SelectItem value="rechazada">Rechazadas</SelectItem>
              <SelectItem value="fallida">Fallidas</SelectItem>
              <SelectItem value="expirada">Expiradas</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{String(error)}</p> : null}
      {proposals.length === 0 ? (
        <EmptyState title="Sin propuestas" description="No hay propuestas del agente en este estado." />
      ) : (
        <ul className="flex flex-col gap-3">
          {proposals.map((proposal) => (
            <li key={proposal.id} className="flex flex-col gap-2 rounded-md bg-card p-6">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={proposal.status === "propuesta" ? "default" : "secondary"}>
                  {STATUS_LABEL[proposal.status] ?? proposal.status}
                </Badge>
                <span className="font-medium">{ACTION_LABEL[proposal.action] ?? proposal.action}</span>
                <span className="text-sm text-muted-foreground">{payloadSummary(proposal.payload)}</span>
              </div>
              {proposal.reason ? <p className="text-sm">{proposal.reason}</p> : null}
              {proposal.error ? <p className="text-sm text-destructive">{proposal.error}</p> : null}
              {proposal.result && typeof proposal.result["appointmentId"] === "string" ? (
                <p className="text-sm text-muted-foreground">
                  Cita: {String(proposal.result["appointmentId"]).slice(0, 8)}…
                  {typeof proposal.result["startsAt"] === "string" ? ` · ${proposal.result["startsAt"]}` : ""}
                </p>
              ) : null}
              {canWrite && proposal.status === "propuesta" ? (
                <div className="flex flex-col gap-2">
                  <Field>
                    <FieldLabel htmlFor={`rechazo-${proposal.id}`}>Motivo (obligatorio para rechazar)</FieldLabel>
                    <Input
                      id={`rechazo-${proposal.id}`}
                      value={rejectReason[proposal.id] ?? ""}
                      onChange={(e) => setRejectReason({ ...rejectReason, [proposal.id]: e.target.value })}
                      placeholder="Por qué se rechaza…"
                    />
                  </Field>
                  <div className="flex gap-2">
                    <SubmitButton
                      type="button"
                      size="sm"
                      onClick={() => decideMutation.mutate({ id: proposal.id, decision: "aprobada" })}
                      pending={decideMutation.isPending}
                    >
                      Aprobar y ejecutar
                    </SubmitButton>
                    <SubmitButton
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        decideMutation.mutate({
                          id: proposal.id,
                          decision: "rechazada",
                          reason: rejectReason[proposal.id],
                        })
                      }
                      pending={decideMutation.isPending}
                      disabled={!(rejectReason[proposal.id] ?? "").trim()}
                    >
                      Rechazar
                    </SubmitButton>
                  </div>
                </div>
              ) : null}
              {canWrite && proposal.status === "aprobada" ? (
                <div>
                  <SubmitButton
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => executeMutation.mutate(proposal.id)}
                    pending={executeMutation.isPending}
                  >
                    Ejecutar ahora
                  </SubmitButton>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-md bg-card p-6">
        <div className="font-heading text-base font-medium">Derivaciones recientes</div>
        {handoffs.length === 0 ? (
          <p className="pt-2 text-sm text-muted-foreground">Sin derivaciones registradas.</p>
        ) : (
          <ul className="flex flex-col gap-2 pt-3">
            {handoffs.map((handoff) => (
              <li key={handoff.id} className="flex flex-col gap-1 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={handoff.priority === "alta" ? "destructive" : "secondary"}>
                    {handoff.priority}
                  </Badge>
                  <span className="font-medium">{handoff.reason}</span>
                </div>
                <p className="whitespace-pre-wrap text-muted-foreground">{handoff.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PageShell>
  )
}
