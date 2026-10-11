import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Spinner,
} from "@odentia/ui"
import { DataRefreshMarker, EmptyState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { MoreHorizontal } from "lucide-react"
import { useState } from "react"
import { formatDueAt, isOverdue } from "../../components/crm/crm-helpers"
import { OpportunityDrawer } from "../../components/crm/opportunity-drawer"
import { apiFetch } from "../../lib/api"
import {
  type OpportunityDetail,
  type Pipeline,
  useOrgMembers,
  usePermission,
} from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"
import { useOrgProfile } from "../../lib/org"
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
  // Formato de la clínica para el importe histórico (moneda congelada del registro).
  const profile = useOrgProfile()
  const orgLocale = profile.data?.locale
  const [closeOpen, setCloseOpen] = useState<"won" | "lost" | null>(null)
  const [editOpen, setEditOpen] = useState(false)

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
    void queryClient.invalidateQueries({ queryKey: ["opportunities"] })
    void queryClient.invalidateQueries({ queryKey: ["pipeline-cards"] })
    void queryClient.invalidateQueries({ queryKey: ["pipeline-list"] })
    void queryClient.invalidateQueries({ queryKey: ["opportunity-summary"] })
    void queryClient.invalidateQueries({ queryKey: ["contact-opportunities"] })
    void queryClient.invalidateQueries({ queryKey: ["tasks"] })
  }

  useOrgEvents(
    [
      "message.created",
      "conversation.updated",
      "opportunity.updated",
      "task.updated",
      "contact.updated",
      "stream.reconnected",
    ],
    invalidate,
  )

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

  // Sin ficha aún no hay estructura que anticipar; con ficha en caché el
  // refetch (post-guardado o por eventos) nunca la retira ni oculta el error.
  if (detailQuery.isPending && !detail) {
    return (
      <PageShell>
        <p className="text-sm text-muted-foreground">Cargando oportunidad…</p>
      </PageShell>
    )
  }
  if (!detail) {
    if (detailQuery.isError) {
      return (
        <PageShell>
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-sm text-destructive">
              {detailQuery.error instanceof Error
                ? detailQuery.error.message
                : "La oportunidad no se pudo cargar."}
            </p>
            <div>
              <Button type="button" variant="outline" onClick={() => void detailQuery.refetch()}>
                Reintentar
              </Button>
            </div>
          </div>
        </PageShell>
      )
    }
    return (
      <PageShell>
        <EmptyState title="No encontrada" description="La oportunidad no existe." />
      </PageShell>
    )
  }

  const money = formatMoney(detail.amountCents, detail.currency, orgLocale)
  const isOpen = detail.status === "open"

  return (
    <PageShell className="flex min-h-0 flex-1 flex-col gap-4">
      {detailQuery.isFetching && !detailQuery.isPending ? <DataRefreshMarker /> : null}
      {detailQuery.isError ? (
        <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">
          No se pudo actualizar la ficha; se conservan los datos cargados.{" "}
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => void detailQuery.refetch()}
          >
            Reintentar solo la ficha
          </Button>
        </p>
      ) : null}
      <PageHeader
        title={detail.title}
        subtitle={`${detail.stageName} · ${detail.contactName}`}
        actions={
          canWrite && isOpen ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setCloseOpen("won")}>
                Marcar ganada
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="outline" size="icon-sm" aria-label="Más acciones" />}
                >
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setEditOpen(true)}>Editar</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setCloseOpen("lost")}>
                    Marcar perdida
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : canWrite && !isOpen ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => reopenMutation.mutate()}
                disabled={reopenMutation.isPending}
              >
                {reopenMutation.isPending ? (
                  <>
                    <Spinner className="size-6" aria-hidden />
                    Reabrir
                  </>
                ) : (
                  "Reabrir"
                )}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="outline" size="icon-sm" aria-label="Más acciones" />}
                >
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setEditOpen(true)}>Ver detalle</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : undefined
        }
      />
      {reopenMutation.error ? (
        <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">
          No se pudo reabrir la oportunidad:{" "}
          {reopenMutation.error instanceof Error
            ? reopenMutation.error.message
            : "error desconocido"}
        </p>
      ) : null}
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <section className="flex min-w-0 flex-col gap-2 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">Negociación</h2>
          <dl className="flex min-w-0 flex-col gap-1.5 text-sm [&>div]:flex [&>div]:gap-2 [&_dd]:min-w-0 [&_dd]:flex-1 [&_dd]:break-words">
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
            {detail.conversationId && (
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-muted-foreground">Origen</dt>
                <dd>
                  <Link
                    to="/inbox"
                    search={{ conversation: detail.conversationId }}
                    className="hover:underline"
                  >
                    Abrir hilo de origen
                  </Link>
                </dd>
              </div>
            )}
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
              <dd>{money ?? (profile.isPending ? "…" : "—")}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-muted-foreground">Asignado</dt>
              <dd>{memberName(detail.assignedUserId)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-muted-foreground">Próxima acción</dt>
              <dd className={detail.nextActionAt && isOverdue(detail.nextActionAt) ? "font-medium text-destructive" : undefined}>
                {detail.nextActionAt ? (
                  <>
                    {isOverdue(detail.nextActionAt) ? "Vencida · " : ""}
                    {formatDueAt(detail.nextActionAt)}
                  </>
                ) : (
                  "—"
                )}
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
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Etapa: {detail.stageName}</span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="outline" size="sm" disabled={moveMutation.isPending} />
                  }
                >
                  Cambiar etapa
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {pipeline.stages
                    .filter((s) => s.kind === "open")
                    .map((s) => (
                      <DropdownMenuItem
                        key={s.id}
                        disabled={s.id === detail.stageId || moveMutation.isPending}
                        onClick={() => {
                          if (s.id !== detail.stageId) moveMutation.mutate(s.id)
                        }}
                      >
                        {s.name}
                        {s.id === detail.stageId ? " · actual" : ""}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
          {moveMutation.error ? (
            <p role="alert" className="text-sm text-destructive">
              No se pudo mover de etapa:{" "}
              {moveMutation.error instanceof Error
                ? moveMutation.error.message
                : "error desconocido"}
            </p>
          ) : null}
          {canWrite && isOpen && detail.patientId && (
            <BudgetLinkRow
              patientId={detail.patientId}
              budgetId={detail.budgetId}
              onLink={(budgetId) => editMutation.mutate({ budgetId })}
              pending={editMutation.isPending}
              linkError={
                editMutation.error instanceof Error ? editMutation.error.message : null
              }
            />
          )}
        </section>
        <section className="flex min-w-0 flex-col gap-2 rounded-lg border p-4">
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
      <OpportunityDrawer
        open={editOpen}
        contactId={detail.contactId}
        conversationId={detail.conversationId ?? undefined}
        opportunityId={opportunityId}
        onClose={() => setEditOpen(false)}
        onSaved={invalidate}
      />
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
  linkError,
}: {
  patientId: string
  budgetId: string | null
  onLink: (budgetId: string | null) => void
  pending: boolean
  linkError: string | null
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
    <div className="mt-2 flex min-w-0 flex-col gap-1">
      <label className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        Presupuesto
        <select
          aria-label="Presupuesto vinculado"
          className="min-w-0 max-w-full rounded border p-1.5"
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
      {budgetsQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudieron cargar los presupuestos.{" "}
          <Button type="button" variant="link" size="sm" onClick={() => void budgetsQuery.refetch()}>
            Reintentar
          </Button>
        </p>
      ) : null}
      {linkError ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudo vincular el presupuesto: {linkError}
        </p>
      ) : null}
    </div>
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
        {error && <p className="text-sm text-destructive">{error}</p>}
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
