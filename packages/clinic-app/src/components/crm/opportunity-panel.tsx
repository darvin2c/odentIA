import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@odentia/ui"
import { DetailDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, MoreHorizontal } from "lucide-react"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { budgetStatusLabel } from "../../lib/budgets"
import {
  CLOSE_REASON_LABEL,
  type OpportunityDetail,
  type Pipeline,
  TASK_AREA_LABEL,
  useMemberName,
  useMyUserId,
  usePermission,
} from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"
import { useOrgProfile } from "../../lib/org"
import { PersonLink } from "../person-link"
import { type CloseTarget, CloseOpportunityDialog } from "./close-opportunity-dialog"
import { dueWords, formatDueAt, isOverdue, moneyText } from "./crm-helpers"
import { OpportunityDrawer } from "./opportunity-drawer"
import { useCompleteTask } from "./complete-task"
import { TaskDrawer } from "./task-drawer"

/** Cómo se dice el paso o el resultado en la cabecera. */
export function momentBadge(detail: Pick<OpportunityDetail, "status" | "stageName">) {
  if (detail.status === "won") return <Badge variant="success">Ganada</Badge>
  if (detail.status === "lost") return <Badge variant="destructive">Perdida</Badge>
  return <Badge variant="soft">{detail.stageName}</Badge>
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.shape.message ?? error.message ?? fallback) : fallback
}

/**
 * La oportunidad abierta al lado de donde se trabaja (ADR 0028): valor,
 * siguiente cita, su tarea (una sola), lo que la hará avanzar sola, quién la
 * lleva y el historial con quién hizo cada cosa. Ganar y perder pasan por la
 * única forma de cerrar; moverla a mano es «Mover a…». Es un componente para
 * cualquier pantalla: el tablero hoy y la página de la persona después.
 */
export function OpportunityPanel({ opportunityId, onClose }: { opportunityId: string | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("crm.write")
  const canTasks = usePermission("tasks.write")
  const myUserId = useMyUserId()
  const memberName = useMemberName()
  const profile = useOrgProfile()
  const [closing, setClosing] = useState<CloseTarget | null>(null)
  const [editing, setEditing] = useState(false)
  const [taskOpen, setTaskOpen] = useState<{ taskId?: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const detailQuery = useQuery({
    queryKey: ["opportunity", opportunityId],
    queryFn: () => apiFetch<{ data: OpportunityDetail }>(`/api/opportunities/${opportunityId}`),
    enabled: opportunityId !== null,
  })
  const detail = detailQuery.data?.data ?? null
  const pipelinesQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
    enabled: opportunityId !== null && canWrite,
  })
  const stages = pipelinesQuery.data?.data.find((pipe) => pipe.id === detail?.pipelineId)?.stages ?? []

  function invalidate() {
    for (const key of ["opportunity", "pipeline-cards", "pipeline-list", "opportunity-summary", "contact-opportunities", "crm-context", "tasks", "workspace-home"]) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }
  useOrgEvents(["opportunity.updated", "task.updated", "appointment.updated", "stream.reconnected"], () => {
    if (opportunityId) void queryClient.invalidateQueries({ queryKey: ["opportunity", opportunityId] })
  })

  const take = useMutation({
    mutationFn: () => apiFetch(`/api/opportunities/${opportunityId}`, { method: "PATCH", body: JSON.stringify({ assignedUserId: myUserId }) }),
    onSuccess: () => {
      setActionError(null)
      invalidate()
    },
    onError: (error) => setActionError(errorText(error, "No se pudo tomar la oportunidad.")),
  })
  const move = useMutation({
    mutationFn: (stageId: string) => apiFetch(`/api/opportunities/${opportunityId}/move`, { method: "POST", body: JSON.stringify({ stageId }) }),
    onSuccess: () => {
      setActionError(null)
      invalidate()
    },
    onError: (error) => setActionError(errorText(error, "No se pudo mover la oportunidad.")),
  })
  const reopen = useMutation({
    mutationFn: () => apiFetch(`/api/opportunities/${opportunityId}/reopen`, { method: "POST" }),
    onSuccess: () => {
      setActionError(null)
      invalidate()
    },
    onError: (error) => setActionError(errorText(error, "No se pudo reabrir la oportunidad.")),
  })
  const completion = useCompleteTask(invalidate)

  const open = detail?.status === "open"
  const task = detail?.nextTask ?? null
  const money = detail ? moneyText(detail.amountCents, detail.currency, profile.data?.locale) : null
  const busy = take.isPending || move.isPending || reopen.isPending
  const taskOwner = task
    ? task.assigneeUserId
      ? memberName(task.assigneeUserId)
      : task.area && task.area in TASK_AREA_LABEL
        ? TASK_AREA_LABEL[task.area as keyof typeof TASK_AREA_LABEL]
        : "Recepción"
    : null

  return (
    <>
      <DetailDrawer
        open={opportunityId !== null}
        onClose={onClose}
        size="lg"
        title={detail ? `${detail.contactName} · «${detail.title}»` : "Oportunidad"}
        isLoading={detailQuery.isPending}
        error={detailQuery.isError ? errorText(detailQuery.error, "No se pudo cargar la oportunidad.") : null}
        headerContent={detail ? <div className="flex flex-wrap items-center gap-2">{momentBadge(detail)}</div> : undefined}
        actions={
          detail && canWrite ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" variant="outline" aria-label="Más acciones" />}>
                <MoreHorizontal aria-hidden />
                Más
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {open
                  ? stages
                      .filter((stage) => stage.moment !== "decidio" && stage.id !== detail.stageId)
                      .map((stage) => (
                        <DropdownMenuItem key={stage.id} disabled={busy} onClick={() => move.mutate(stage.id)}>
                          Mover a {stage.name}
                        </DropdownMenuItem>
                      ))
                  : null}
                {open ? <DropdownMenuSeparator /> : null}
                {open ? <DropdownMenuItem onClick={() => setEditing(true)}>Editar</DropdownMenuItem> : null}
                {!open ? (
                  <DropdownMenuItem disabled={busy} onClick={() => reopen.mutate()}>
                    Reabrir
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      >
        {detail ? (
          <div className="flex flex-col gap-5">
            {actionError || completion.error ? (
              <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">
                {actionError ?? completion.error}
              </p>
            ) : null}
            
            <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-2.5 text-sm">
              <dt className="text-muted-foreground">Persona</dt>
              <dd className="min-w-0">
                <PersonLink patientId={detail.patientId} contactId={detail.contactId}>
                  {detail.patientName ?? detail.contactName}
                </PersonLink>
                {detail.patientName && detail.patientName !== detail.contactName ? (
                  <span className="text-muted-foreground"> · escribe {detail.contactName}</span>
                ) : null}
              </dd>
              <dt className="text-muted-foreground">Valor</dt>
              <dd>
                {money ?? (profile.isPending ? "…" : "Sin valor")}
                {money && detail.amountFromPriceList ? <span className="text-muted-foreground"> · de la lista de precios</span> : null}
                {money && detail.amountFromBudget ? <span className="text-muted-foreground"> · del presupuesto</span> : null}
              </dd>
              {detail.nextAppointment ? (
                <>
                  <dt className="text-muted-foreground">Siguiente</dt>
                  <dd>{detail.nextAppointment.text}</dd>
                </>
              ) : null}
              {open ? (
                <>
                  <dt className="text-muted-foreground">Tarea</dt>
                  <dd className="flex flex-col items-start gap-1">
                    {task ? (
                      <>
                        <span className={isOverdue(task.dueAt) ? "font-medium text-destructive" : undefined}>
                          {task.title}
                          {task.dueAt ? ` · ${isOverdue(task.dueAt) ? "venció " : ""}${dueWords(task.dueAt)}` : ""}
                        </span>
                        <span className="text-muted-foreground">{taskOwner}</span>
                        {canTasks ? (
                          <span className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={completion.pendingId === task.id}
                              onClick={() => void completion.complete(task.id)}
                            >
                              <Check aria-hidden />
                              Hecha
                            </Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setTaskOpen({ taskId: task.id })}>
                              Cambiar
                            </Button>
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">Sin tarea</span>
                    )}
                  </dd>
                </>
              ) : null}
              {detail.after ? (
                <>
                  <dt className="text-muted-foreground">Después</dt>
                  <dd>{detail.after}</dd>
                </>
              ) : null}
              {!open ? (
                <>
                  <dt className="text-muted-foreground">Por qué</dt>
                  <dd>
                    {detail.why ?? (detail.closeReason ? CLOSE_REASON_LABEL[detail.closeReason] : "—")}
                    {detail.closeNote ? <span className="text-muted-foreground"> · {detail.closeNote}</span> : null}
                  </dd>
                </>
              ) : detail.why ? (
                <>
                  <dt className="text-muted-foreground">Por qué está aquí</dt>
                  <dd>{detail.why}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Responsable</dt>
              <dd className="flex flex-wrap items-center gap-2">
                {detail.assignedUserId ? (
                  memberName(detail.assignedUserId)
                ) : (
                  <>
                    <span>Recepción · sin persona asignada</span>
                    {canWrite && open ? (
                      <Button type="button" size="sm" variant="link" className="h-auto p-0" disabled={busy} onClick={() => take.mutate()}>
                        Tomar
                      </Button>
                    ) : null}
                  </>
                )}
              </dd>
              {detail.budgetId ? (
                <>
                  <dt className="text-muted-foreground">Presupuesto</dt>
                  <dd>
                    {detail.budgetNumber ? `N.º ${detail.budgetNumber} · ` : ""}
                    {detail.budgetTitle} · {detail.budgetStatus ? budgetStatusLabel(detail.budgetStatus) : ""}
                  </dd>
                </>
              ) : null}
              {detail.interestText ? (
                <>
                  <dt className="text-muted-foreground">Lo que pidió</dt>
                  <dd>{detail.interestText}</dd>
                </>
              ) : null}
            </dl>
            {open && (canWrite || canTasks) ? (
              <div className="flex flex-wrap gap-2">
                {canTasks && !task ? (
                  <Button type="button" variant="outline" onClick={() => setTaskOpen({})}>
                    Nueva tarea
                  </Button>
                ) : null}
                {canWrite ? (
                  <>
                    <Button type="button" onClick={() => setClosing({ id: detail.id, title: detail.title, outcome: "won" })}>
                      Ganada
                    </Button>
                    <Button type="button" variant="outline" onClick={() => setClosing({ id: detail.id, title: detail.title, outcome: "lost" })}>
                      Perdida
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
            <section aria-labelledby="opp-historial" className="flex flex-col gap-2">
              <h3 id="opp-historial" className="text-sm font-semibold">
                Historial
              </h3>
              <ol className="flex flex-col gap-2 text-sm">
                {[...detail.history].reverse().map((item) => (
                  <li key={item.id} className="flex flex-col gap-0.5 border-b pb-2 last:border-0">
                    <span>{item.what}</span>
                    <span className="text-xs text-muted-foreground">
                      {item.who} · {formatDueAt(item.createdAt)}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        ) : null}
      </DetailDrawer>
      <CloseOpportunityDialog
        target={closing}
        onClose={() => setClosing(null)}
        onClosed={() => {
          setClosing(null)
          invalidate()
        }}
      />
      {detail ? (
        <OpportunityDrawer
          open={editing}
          opportunityId={detail.id}
          contactId={detail.contactId}
          onClose={() => setEditing(false)}
          onSaved={invalidate}
        />
      ) : null}
      {detail ? (
        <TaskDrawer
          open={taskOpen !== null}
          taskId={taskOpen?.taskId}
          contactId={detail.contactId}
          opportunityId={detail.id}
          onClose={() => setTaskOpen(null)}
          onSaved={invalidate}
        />
      ) : null}
    </>
  )
}

