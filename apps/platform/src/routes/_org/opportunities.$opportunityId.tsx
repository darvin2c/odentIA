import { Badge, Button, Input } from "@odentia/ui"
import { EmptyState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import {
  type OpportunityDetail,
  type Pipeline,
  useOrgMembers,
  usePermission,
} from "../../lib/crm"
import { formatMoney } from "./pipeline"

export const Route = createFileRoute("/_org/opportunities/$opportunityId")({
  component: OpportunityDetailPage,
})

const ACTION_LABELS: Record<string, string> = {
  "opportunity.created": "Creada",
  "opportunity.updated": "Actualizada",
  "opportunity.moved": "Movida de etapa",
  "opportunity.won": "Ganada",
  "opportunity.lost": "Perdida",
  "opportunity.reopened": "Reabierta",
}

function OpportunityDetailPage() {
  const { opportunityId } = Route.useParams()
  const queryClient = useQueryClient()
  const members = useOrgMembers()
  const canWrite = usePermission("crm.write")
  const [closeOpen, setCloseOpen] = useState<"won" | "lost" | null>(null)

  const detailQuery = useQuery({
    queryKey: ["opportunity", opportunityId],
    queryFn: () => apiFetch<{ data: OpportunityDetail }>(`/api/opportunities/${opportunityId}`),
  })
  const pipelinesQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
  })

  const detail = detailQuery.data?.data
  const pipeline = pipelinesQuery.data?.data.find((p) => p.id === detail?.pipelineId)
  const memberName = (userId: string | null) =>
    members.find((m) => m.userId === userId)?.user.name ?? "—"
  const stageName = (stageId: string | null) =>
    pipeline?.stages.find((s) => s.id === stageId)?.name ?? "—"

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["opportunity", opportunityId] })
    void queryClient.invalidateQueries({ queryKey: ["pipeline-cards"] })
  }

  const moveMutation = useMutation({
    mutationFn: (stageId: string) =>
      apiFetch(`/api/opportunities/${opportunityId}/move`, {
        method: "POST",
        body: JSON.stringify({ stageId }),
      }),
    onSuccess: invalidate,
  })
  const closeMutation = useMutation({
    mutationFn: ({ outcome, reason }: { outcome: "won" | "lost"; reason: string }) =>
      apiFetch(`/api/opportunities/${opportunityId}/close`, {
        method: "POST",
        body: JSON.stringify({ outcome, reason }),
      }),
    onSuccess: () => {
      setCloseOpen(null)
      invalidate()
    },
  })
  const reopenMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/opportunities/${opportunityId}/reopen`, { method: "POST" }),
    onSuccess: invalidate,
  })
  const editMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/opportunities/${opportunityId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
  })

  if (detailQuery.isLoading) {
    return (
      <PageShell>
        <p className="text-sm text-muted-foreground">Cargando oportunidad…</p>
      </PageShell>
    )
  }
  if (!detail) {
    return (
      <PageShell>
        <EmptyState title="No encontrada" description="La oportunidad no existe." />
      </PageShell>
    )
  }

  const money = formatMoney(detail.amountCents, detail.currency)
  const isOpen = detail.status === "open"

  return (
    <PageShell className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title={detail.title}
        subtitle={`${detail.stageName} · ${detail.contactName}`}
        actions={
          canWrite && isOpen ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setCloseOpen("lost")}>
                Marcar perdida
              </Button>
              <Button size="sm" onClick={() => setCloseOpen("won")}>
                Marcar ganada
              </Button>
            </div>
          ) : canWrite && !isOpen ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => reopenMutation.mutate()}
              disabled={reopenMutation.isPending}
            >
              Reabrir
            </Button>
          ) : undefined
        }
      />
      <div className="grid gap-4 md:grid-cols-2">
        <section className="flex flex-col gap-2 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">Negociación</h2>
          <dl className="flex flex-col gap-1.5 text-sm">
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-muted-foreground">Contacto</dt>
              <dd>
                <Link
                  to="/contacts/$contactId"
                  params={{ contactId: detail.contactId }}
                  className="hover:underline"
                >
                  {detail.contactName}
                </Link>
              </dd>
            </div>
            {detail.patientId && (
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-muted-foreground">Paciente</dt>
                <dd>
                  <Link
                    to="/patients/$patientId"
                    params={{ patientId: detail.patientId }}
                    className="hover:underline"
                  >
                    {detail.patientName}
                  </Link>
                </dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-muted-foreground">Interés</dt>
              <dd>{detail.interestText ?? detail.serviceName ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-muted-foreground">Valor</dt>
              <dd>{money ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-muted-foreground">Asignado</dt>
              <dd>{memberName(detail.assignedUserId)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-muted-foreground">Próxima acción</dt>
              <dd>
                {detail.nextActionAt
                  ? new Date(detail.nextActionAt).toLocaleString("es-PE")
                  : "—"}
                {detail.nextActionNote ? ` · ${detail.nextActionNote}` : ""}
              </dd>
            </div>
            {detail.budgetId && (
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-muted-foreground">Presupuesto</dt>
                <dd>
                  {detail.budgetTitle} <Badge variant="secondary">{detail.budgetStatus}</Badge>
                </dd>
              </div>
            )}
            {!isOpen && (
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-muted-foreground">Motivo</dt>
                <dd>
                  <Badge variant={detail.status === "won" ? "default" : "secondary"}>
                    {detail.status === "won" ? "Ganada" : "Perdida"}
                  </Badge>{" "}
                  {detail.closeReason}
                </dd>
              </div>
            )}
          </dl>
          {canWrite && isOpen && pipeline && (
            <label className="mt-2 flex items-center gap-2 text-sm">
              Etapa
              <select
                className="rounded border p-1.5"
                value={detail.stageId}
                onChange={(e) => moveMutation.mutate(e.target.value)}
                disabled={moveMutation.isPending}
              >
                {pipeline.stages
                  .filter((s) => s.kind === "open")
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {canWrite && isOpen && detail.patientId && (
            <BudgetLinkRow
              patientId={detail.patientId}
              budgetId={detail.budgetId}
              onLink={(budgetId) => editMutation.mutate({ budgetId })}
              pending={editMutation.isPending}
            />
          )}
        </section>
        {canWrite && isOpen && (
          <section className="rounded-lg border p-4 md:col-span-2">
            <h2 className="mb-2 text-sm font-semibold">Editar seguimiento</h2>
            <form
              className="grid gap-3 md:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault()
                const form = new FormData(e.currentTarget)
                const amount = String(form.get("amount") ?? "").trim()
                const nextActionAt = String(form.get("nextActionAt") ?? "")
                editMutation.mutate({
                  title: String(form.get("title")),
                  interestText: String(form.get("interestText") ?? "").trim() || null,
                  amountCents: amount ? Math.round(Number(amount) * 100) : null,
                  currency:
                    String(form.get("currency") ?? "PEN").trim().toUpperCase() || "PEN",
                  assignedUserId: String(form.get("assignedUserId") ?? "") || null,
                  nextActionAt: nextActionAt
                    ? new Date(nextActionAt).toISOString()
                    : null,
                  nextActionNote: String(form.get("nextActionNote") ?? "").trim() || null,
                })
              }}
            >
              <label className="flex flex-col gap-1 text-sm">
                Título
                <Input name="title" required maxLength={200} defaultValue={detail.title} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Interés
                <Input
                  name="interestText"
                  maxLength={500}
                  defaultValue={detail.interestText ?? ""}
                />
              </label>
              <div className="flex gap-2">
                <label className="flex flex-1 flex-col gap-1 text-sm">
                  Valor
                  <Input
                    name="amount"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={
                      detail.amountCents !== null ? detail.amountCents / 100 : ""
                    }
                  />
                </label>
                <label className="flex w-24 flex-col gap-1 text-sm">
                  Moneda
                  <Input name="currency" maxLength={3} defaultValue={detail.currency} />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-sm">
                Asignado
                <select
                  name="assignedUserId"
                  className="rounded border p-2"
                  defaultValue={detail.assignedUserId ?? ""}
                >
                  <option value="">Sin asignar</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.user.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Próxima acción
                <Input
                  name="nextActionAt"
                  type="datetime-local"
                  defaultValue={detail.nextActionAt ? detail.nextActionAt.slice(0, 16) : ""}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Nota de seguimiento
                <Input
                  name="nextActionNote"
                  maxLength={500}
                  defaultValue={detail.nextActionNote ?? ""}
                />
              </label>
              <div className="flex items-end">
                <Button type="submit" disabled={editMutation.isPending}>
                  Guardar
                </Button>
              </div>
              {editMutation.error && (
                <p className="text-sm text-red-600 md:col-span-3">
                  {(editMutation.error as Error).message}
                </p>
              )}
            </form>
          </section>
        )}
        <section className="flex flex-col gap-2 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">Historial</h2>
          {detail.history.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin movimientos registrados.</p>
          )}
          <ol className="flex flex-col gap-1.5 text-sm">
            {detail.history.map((h) => (
              <li key={h.id} className="flex flex-col gap-0.5 border-b pb-1.5 last:border-0">
                <span className="font-medium">{ACTION_LABELS[h.action] ?? h.action}</span>
                {(h.fromStageId ?? h.toStageId) && (
                  <span className="text-xs text-muted-foreground">
                    {stageName(h.fromStageId)} → {stageName(h.toStageId)}
                  </span>
                )}
                {h.note && <span className="text-xs">{h.note}</span>}
                <span className="text-xs text-muted-foreground">
                  {new Date(h.createdAt).toLocaleString("es-PE")}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
      {closeOpen && (
        <CloseDialog
          outcome={closeOpen}
          pending={closeMutation.isPending}
          error={closeMutation.error?.message ?? null}
          onClose={() => setCloseOpen(null)}
          onConfirm={(reason) => closeMutation.mutate({ outcome: closeOpen, reason })}
        />
      )}
    </PageShell>
  )
}

function BudgetLinkRow({
  patientId,
  budgetId,
  onLink,
  pending,
}: {
  patientId: string
  budgetId: string | null
  onLink: (budgetId: string | null) => void
  pending: boolean
}) {
  const budgetsQuery = useQuery({
    queryKey: ["patient-budgets", patientId],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; title: string; status: string }> }>(
        `/api/patients/${patientId}/budgets`,
      ),
  })
  const budgets = budgetsQuery.data?.data ?? []
  return (
    <label className="mt-2 flex items-center gap-2 text-sm">
      Presupuesto
      <select
        className="rounded border p-1.5"
        value={budgetId ?? ""}
        onChange={(e) => onLink(e.target.value || null)}
        disabled={pending || budgetsQuery.isLoading}
      >
        <option value="">Sin vincular</option>
        {budgets.map((b) => (
          <option key={b.id} value={b.id}>
            {b.title} · {b.status}
          </option>
        ))}
      </select>
    </label>
  )
}

function CloseDialog({
  outcome,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  outcome: "won" | "lost"
  pending: boolean
  error: string | null
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        className="flex w-full max-w-md flex-col gap-3 rounded-lg bg-card p-4 shadow-lg"
        onSubmit={(e) => {
          e.preventDefault()
          onConfirm(String(new FormData(e.currentTarget).get("reason") ?? ""))
        }}
      >
        <h2 className="text-base font-semibold">
          {outcome === "won" ? "Marcar como ganada" : "Marcar como perdida"}
        </h2>
        <label className="flex flex-col gap-1 text-sm">
          Motivo (obligatorio)
          <Input
            name="reason"
            required
            maxLength={500}
            placeholder={
              outcome === "won" ? "Aceptó el plan de tratamiento…" : "Eligió otra clínica…"
            }
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={pending}>
            Confirmar
          </Button>
        </div>
      </form>
    </div>
  )
}
