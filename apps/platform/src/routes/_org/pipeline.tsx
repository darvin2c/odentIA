import {
  closestCenter, pointerWithin, DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor,
  useDndContext, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type KeyboardCoordinateGetter,
} from "@dnd-kit/core"
import { Badge, Button, Field, FieldLabel, Input, ScrollArea, Spinner } from "@odentia/ui"
import {
  DataRefreshMarker,
  DataTable,
  DataTableSkeleton,
  EmptyState,
  ErrorState,
  FilterBar,
  FormDrawer,
  PageHeader,
  PageShell,
  RowActions,
  type RowActionItem,
  useListSearch,
} from "@odentia/ui-patterns"
import { type InfiniteData, useInfiniteQuery, useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ArrowRight, CalendarClock, Check, Circle, Columns3, GripVertical, List, Undo2, UserRound } from "lucide-react"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { formatMoney as sharedFormatMoney } from "@odentia/clinical"
import { formatDueAt, isOverdue } from "../../components/crm/crm-helpers"
import { OpportunityDrawer } from "../../components/crm/opportunity-drawer"
import { apiFetch } from "../../lib/api"
import {
  type OpportunityListItem,
  type Pipeline,
  timeAgo,
  useMyUserId,
  useOrgMembers,
  usePermission,
} from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"
import { useOrgProfile } from "../../lib/org"

export const Route = createFileRoute("/_org/pipeline")({
  component: PipelinePage,
})

interface SummaryStage {
  stageId: string
  count: number
  amounts: Array<{ currency: string; amountCents: string }>
}

interface Summary {
  total: number
  stages: SummaryStage[]
}

const CARD_LIMIT = 30
const useBoardLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

function PipelinePage() {
  const queryClient = useQueryClient()
  const myUserId = useMyUserId()
  const members = useOrgMembers()
  // Formato de la clínica para los importes (moneda congelada de cada registro).
  const profile = useOrgProfile()
  const orgLocale = profile.data?.locale
  const canWrite = usePermission("crm.write")
  const listSearch = useListSearch()
  // Filtros y selección persistentes en la URL: no se pierde el caso al
  // navegar a la ficha y volver.
  const q = listSearch.get("q") ?? ""
  const embudo = listSearch.get("embudo")
  const vista = listSearch.get("vista") === "lista" ? "lista" : "tablero"
  const onlyMine = listSearch.get("asignado") === "mias"
  const onlyDue = listSearch.get("seguimiento") === "pendiente"
  // Fetching real de tarjetas visibles (tablero por etapa y vista lista):
  // alimenta el indicador de búsqueda sin reglas nuevas de debounce.
  const boardFetching = useIsFetching({ queryKey: ["pipeline-cards"] })
  const listFetching = useIsFetching({ queryKey: ["pipeline-list"] })
  const [createOpen, setCreateOpen] = useState(false)
  const [closeTarget, setCloseTarget] = useState<{ opp: OpportunityListItem; outcome: "won" | "lost" } | null>(
    null,
  )
  const [moveError, setMoveError] = useState<string | null>(null)
  const [moveFeedback, setMoveFeedback] = useState<MoveFeedback | null>(null)

  const pipelinesQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
  })
  const pipelines = useMemo(() => pipelinesQuery.data?.data ?? [], [pipelinesQuery.data])
  const pipeline =
    pipelines.find((p) => p.id === embudo) ??
    pipelines.find((p) => p.isDefault) ??
    pipelines[0] ??
    null
  const stages = useMemo(() => pipeline?.stages ?? [], [pipeline])

  function pipelineParams(withStage?: string): URLSearchParams {
    const params = new URLSearchParams()
    if (pipeline) params.set("pipelineId", pipeline.id)
    if (withStage) params.set("stageId", withStage)
    if (q.trim()) params.set("q", q.trim())
    if (onlyMine) params.set("assignedUserId", myUserId)
    if (onlyDue) params.set("nextActionDue", "true")
    return params
  }

  // Totales completos del servidor con los mismos filtros (C07): nunca se
  // confunde la muestra cargada con el total.
  const summaryQuery = useQuery({
    queryKey: ["opportunity-summary", pipeline?.id, q, onlyMine, onlyDue],
    queryFn: () =>
      apiFetch<{ data: Summary }>(`/api/opportunities/summary?${pipelineParams()}`),
    enabled: Boolean(pipeline),
    retry: false,
  })
  const summary = summaryQuery.data?.data ?? null
  const summaryByStage = useMemo(() => {
    const map: Record<string, SummaryStage> = {}
    for (const entry of summary?.stages ?? []) map[entry.stageId] = entry
    return map
  }, [summary])
  type CardPages = InfiniteData<{ data: OpportunityListItem[]; nextCursor: string | null }, string | null>

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["pipeline-cards"] })
    void queryClient.invalidateQueries({ queryKey: ["pipeline-list"] })
    void queryClient.invalidateQueries({ queryKey: ["opportunity-summary"] })
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
    () => {
      // El refetch del evento propio no debe deshacer la respuesta optimista.
      if (!queryClient.isMutating({ mutationKey: ["pipeline-move"] })) invalidate()
      void queryClient.invalidateQueries({ queryKey: ["pipelines"] })
    },
  )

  const moveMutation = useMutation({
    mutationKey: ["pipeline-move"],
    mutationFn: ({ opportunity, stage }: { opportunity: OpportunityListItem; stage: Pipeline["stages"][number] }) =>
      apiFetch(`/api/opportunities/${opportunity.id}/move`, {
        method: "POST",
        body: JSON.stringify({ stageId: stage.id }),
      }),
    onMutate: ({ opportunity, stage }) => {
      setMoveError(null)
      setMoveFeedback(null)
      const fromKey = ["pipeline-cards", opportunity.pipelineId, opportunity.stageId, q, onlyMine, onlyDue]
      const toKey = ["pipeline-cards", opportunity.pipelineId, stage.id, q, onlyMine, onlyDue]
      const summaryKey = ["opportunity-summary", opportunity.pipelineId, q, onlyMine, onlyDue]
      // Cancelar es síncrono; mover la caché en este mismo turno evita un
      // frame con la tarjeta otra vez en origen al desmontar el overlay.
      for (const queryKey of [fromKey, toKey, summaryKey]) void queryClient.cancelQueries({ queryKey, exact: true })
      const from = queryClient.getQueryData<CardPages>(fromKey)
      const to = queryClient.getQueryData<CardPages>(toKey)
      const previousSummary = queryClient.getQueryData<{ data: Summary }>(summaryKey)
      const withoutCard = (data: CardPages): CardPages => ({
        ...data, pages: data.pages.map((page) => ({ ...page, data: page.data.filter((row) => row.id !== opportunity.id) })),
      })
      if (from) queryClient.setQueryData(fromKey, withoutCard(from))
      if (to) {
        const updated = withoutCard(to)
        queryClient.setQueryData(toKey, {
          ...updated,
          pages: updated.pages.map((page, index) => index === 0
            ? { ...page, data: [{ ...opportunity, stageId: stage.id, stageName: stage.name, stageKind: stage.kind }, ...page.data] }
            : page),
        })
      }
      if (previousSummary) queryClient.setQueryData(summaryKey, {
        data: {
          ...previousSummary.data,
          stages: [
            ...previousSummary.data.stages,
            ...(previousSummary.data.stages.some((entry) => entry.stageId === stage.id) ? [] : [{ stageId: stage.id, count: 0, amounts: [] }]),
          ].map((entry) => {
            const delta = entry.stageId === opportunity.stageId ? -1 : entry.stageId === stage.id ? 1 : 0
            if (!delta) return entry
            const amounts = new Map(entry.amounts.map((amount) => [amount.currency, BigInt(amount.amountCents)]))
            if (opportunity.amountCents !== null) {
              amounts.set(opportunity.currency, (amounts.get(opportunity.currency) ?? 0n) + BigInt(delta * opportunity.amountCents))
            }
            return { ...entry, count: entry.count + delta, amounts: [...amounts].map(([currency, cents]) => ({ currency, amountCents: String(cents) })) }
          }),
        },
      })
      return { fromKey, toKey, summaryKey, from, to, previousSummary }
    },
    onSuccess: (_, { opportunity, stage }) => setMoveFeedback({ id: opportunity.id, kind: "saved", stageName: stage.name }),
    onError: (err: Error, { opportunity }, previous) => {
      if (previous) {
        queryClient.setQueryData(previous.fromKey, previous.from)
        queryClient.setQueryData(previous.toKey, previous.to)
        queryClient.setQueryData(previous.summaryKey, previous.previousSummary)
      }
      setMoveError(err.message)
      setMoveFeedback({ id: opportunity.id, kind: "returned", stageName: opportunity.stageName })
    },
    onSettled: () => Promise.all([
      ["pipeline-cards"], ["pipeline-list"], ["opportunity-summary"], ["opportunities"], ["crm-opportunities"], ["crm-context"],
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  })

  const closeMutation = useMutation({
    mutationFn: ({ oppId, outcome, reason }: { oppId: string; outcome: "won" | "lost"; reason: string }) =>
      apiFetch(`/api/opportunities/${oppId}/close`, {
        method: "POST",
        body: JSON.stringify({ outcome, reason }),
      }),
    onSuccess: () => {
      setCloseTarget(null)
      setMoveError(null)
      invalidate()
    },
  })
  const reopenMutation = useMutation({
    mutationFn: (opportunityId: string) =>
      apiFetch(`/api/opportunities/${opportunityId}/reopen`, { method: "POST" }),
    onSuccess: () => {
      setMoveError(null)
      invalidate()
    },
    onError: (err: Error) => setMoveError(err.message),
  })

  /** Movimiento accesible y por arrastre: a etapa terminal siempre con motivo. */
  function requestMove(opp: OpportunityListItem, targetStageId: string) {
    if (moveMutation.isPending || reopenMutation.isPending || opp.status !== "open" || targetStageId === opp.stageId) return
    const target = stages.find((s) => s.id === targetStageId)
    if (!target) return
    if (target.kind === "won" || target.kind === "lost") {
      closeMutation.reset()
      setCloseTarget({ opp, outcome: target.kind })
      return
    }
    moveMutation.mutate({ opportunity: opp, stage: target })
  }

  function handleDragEnd(event: DragEndEvent) {
    const card = event.active.data.current?.card as OpportunityListItem | undefined
    if (card && event.over) requestMove(card, String(event.over.id))
  }
  const memberName = (userId: string | null) =>
    members.find((m) => m.userId === userId)?.user.name ?? "Sin asignar"

  if (pipelinesQuery.isLoading) {
    return (
      <PageShell>
        <p className="text-sm text-muted-foreground">Cargando tablero…</p>
      </PageShell>
    )
  }

  if (!pipeline) {
    return (
      <PageShell>
        <EmptyState title="Sin pipeline" description="No hay pipeline configurado." />
      </PageShell>
    )
  }

  const totalAmounts = sumAmounts(summary?.stages ?? [], orgLocale)

  return (
    <PageShell fill className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="Oportunidades"
        subtitle={
          summary
            ? `${vista === "lista" ? "Lista" : "Tablero"} · ${pipeline.name} · ${summary.total} oportunidad${summary.total === 1 ? "" : "es"}${totalAmounts ? ` · ${totalAmounts}` : ""}`
            : `${vista === "lista" ? "Lista" : "Tablero"} · ${pipeline.name}`
        }
        actions={
          canWrite ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              Nueva oportunidad
            </Button>
          ) : undefined
        }
      />
      {/* Una sola barra: embudo, vista, búsqueda y filtros comparten el mismo
          contenedor responsive. Limpiar conserva embudo y vista. */}
      <div className="flex items-center gap-2 rounded-xl bg-card p-2">
      <FilterBar
        className="min-w-0 flex-1 rounded-none bg-transparent p-1"
        filters={[
          // El embudo solo se elige si hay más de uno: con uno solo el filtro no cambia nada.
          ...(pipelines.length > 1
            ? [
                {
                  key: "embudo",
                  label: "Embudo",
                  type: "select" as const,
                  options: pipelines.map((p) => ({
                    value: p.id,
                    label: `${p.name}${p.isDefault ? " · principal" : ""}`,
                  })),
                },
              ]
            : []),
          {
            key: "asignado",
            label: "Responsable",
            type: "select",
            options: [
              { value: "todas", label: "Todas" },
              { value: "mias", label: "Solo asignadas a mí" },
            ],
          },
          {
            key: "seguimiento",
            label: "Seguimiento",
            type: "select",
            options: [
              { value: "todos", label: "Todos" },
              { value: "pendiente", label: "Seguimiento pendiente" },
            ],
          },
        ]}
        sortOptions={[]}
        searchPlaceholder="Buscar por título o interés…"
        searchPending={boardFetching + listFetching > 0}
        resetKeys={["q", "asignado", "seguimiento"]}
      />
        <div role="group" aria-label="Vista de oportunidades" className="flex shrink-0 gap-0.5 rounded-lg bg-muted/70 p-1">
          <Button variant="ghost" size="icon" aria-label="Vista tablero" aria-pressed={vista === "tablero"} className={vista === "tablero" ? "bg-background shadow-sm" : "text-muted-foreground"} onClick={() => listSearch.setParam("vista", undefined)}><Columns3 className="size-4" /></Button>
          <Button variant="ghost" size="icon" aria-label="Vista lista" aria-pressed={vista === "lista"} className={vista === "lista" ? "bg-background shadow-sm" : "text-muted-foreground"} onClick={() => listSearch.setParam("vista", "lista")}><List className="size-4" /></Button>
        </div>
      </div>
      {summaryQuery.isError ? (
        <ErrorState
          error={
            summaryQuery.error instanceof Error ? summaryQuery.error : String(summaryQuery.error)
          }
          onRetry={() => void summaryQuery.refetch()}
        />
      ) : null}
      {moveError ? (
        <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">
          No se pudo actualizar la oportunidad: {moveError} La tarjeta regresó a su etapa anterior.
        </p>
      ) : null}
      {vista === "lista" ? (
        <PipelineListView
          pipelineId={pipeline.id}
          stages={stages}
          params={pipelineParams()}
          queryKey={["pipeline-list", pipeline.id, q, onlyMine, onlyDue]}
          memberName={memberName}
          canMove={canWrite}
          onMoveRequest={requestMove}
          onReopenRequest={(opp) => reopenMutation.mutate(opp.id)}
          movePending={moveMutation.isPending || reopenMutation.isPending}
        />
      ) : (
        <BoardColumns
          pipelineId={pipeline.id}
          stages={stages}
          q={q}
          onlyMine={onlyMine}
          onlyDue={onlyDue}
          paramsFor={(stageId) => pipelineParams(stageId)}
          summaryByStage={summaryByStage}
          memberName={memberName}
          canMove={canWrite}
          onMoveRequest={requestMove}
          onReopenRequest={(opp) => reopenMutation.mutate(opp.id)}
          movePending={moveMutation.isPending || reopenMutation.isPending}
          onDragEnd={handleDragEnd}
          pendingId={moveMutation.isPending ? moveMutation.variables.opportunity.id : null}
          feedback={moveFeedback}
        />
      )}
      <OpportunityDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={invalidate}
      />
      <CloseWithReasonDialog
        target={closeTarget}
        pending={closeMutation.isPending}
        error={closeMutation.error instanceof Error ? closeMutation.error.message : null}
        onClose={() => {
          if (!closeMutation.isPending) {
            closeMutation.reset()
            setCloseTarget(null)
          }
        }}
        onConfirm={(reason) =>
          closeTarget &&
          closeMutation.mutate({ oppId: closeTarget.opp.id, outcome: closeTarget.outcome, reason })
        }
      />
    </PageShell>
  )
}

function sumAmounts(stages: SummaryStage[], locale: string | undefined): string | null {
  if (!locale) return null
  const totals = new Map<string, number>()
  for (const stage of stages) {
    for (const entry of stage.amounts) {
      const cents = Number(entry.amountCents)
      if (!Number.isFinite(cents)) continue
      totals.set(entry.currency, (totals.get(entry.currency) ?? 0) + cents)
    }
  }
  if (totals.size === 0) return null
  const parts: string[] = []
  for (const [currency, cents] of totals) {
    const text = formatMoney(cents, currency, locale)
    if (text === null) return null
    parts.push(text)
  }
  return parts.join(" + ")
}

interface MoveFeedback {
  id: string
  kind: "saved" | "returned"
  stageName: string
}

interface BoardShared {
  pipelineId: string
  q: string
  onlyMine: boolean
  onlyDue: boolean
  memberName: (userId: string | null) => string
  canMove: boolean
  onMoveRequest: (opp: OpportunityListItem, stageId: string) => void
  onReopenRequest: (opp: OpportunityListItem) => void
  movePending: boolean
  feedback: MoveFeedback | null
}

/**
 * Acciones de estado de una tarjeta: la vía accesible al cambio de etapa.
 * Cerrada solo ofrece reabrir (explícito); abierta ofrece moverse a otras
 * etapas abiertas o cerrarse con motivo (lo pide el diálogo, nunca en silencio).
 */
function opportunityActionItems(
  card: OpportunityListItem,
  stages: Pipeline["stages"],
  actions: {
    onMoveRequest: (opp: OpportunityListItem, stageId: string) => void
    onReopenRequest: (opp: OpportunityListItem) => void
    disabled?: boolean
  },
): RowActionItem[] {
  if (card.status !== "open") {
    return [
      {
        key: "reabrir",
        label: "Reabrir oportunidad",
        disabled: actions.disabled,
        onSelect: () => actions.onReopenRequest(card),
      },
    ]
  }
  const items: RowActionItem[] = []
  for (const stage of stages) {
    if (stage.kind !== "open" || stage.id === card.stageId) continue
    items.push({
      key: `mover-${stage.id}`,
      label: `Mover a ${stage.name}`,
      disabled: actions.disabled,
      onSelect: () => actions.onMoveRequest(card, stage.id),
    })
  }
  for (const stage of stages) {
    if (stage.kind !== "won" && stage.kind !== "lost") continue
    items.push({
      key: `cerrar-${stage.id}`,
      label: `Cerrar: ${stage.name} (pide motivo)`,
      disabled: actions.disabled,
      onSelect: () => actions.onMoveRequest(card, stage.id),
    })
  }
  return items
}

function BoardColumns(
  props: BoardShared & {
    stages: Pipeline["stages"]
    summaryByStage: Record<string, SummaryStage>
    paramsFor: (stageId: string) => URLSearchParams
    onDragEnd: (event: DragEndEvent) => void
    pendingId: string | null
    feedback: MoveFeedback | null
  },
) {
  const { stages } = props
  const profile = useOrgProfile()
  const orgLocale = profile.data?.locale
  const [dragged, setDragged] = useState<OpportunityListItem | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [dropAccepted, setDropAccepted] = useState(false)
  const keyboardCoordinates = useCallback<KeyboardCoordinateGetter>((event, { currentCoordinates, context }) => {
    const direction = event.code === "ArrowRight" || event.code === "ArrowDown" ? 1
      : event.code === "ArrowLeft" || event.code === "ArrowUp" ? -1 : 0
    if (!direction) return
    event.preventDefault()
    const currentId = context.over?.id ?? context.active?.data.current?.card.stageId
    const index = stages.findIndex((stage) => stage.id === currentId)
    const target = stages[index + direction]
    const rect = target && context.droppableRects.get(target.id)
    if (!rect || !context.collisionRect) return
    return {
      x: currentCoordinates.x + rect.left - context.collisionRect.left + (rect.width - context.collisionRect.width) / 2,
      y: currentCoordinates.y,
    }
  }, [stages])
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates, scrollBehavior: "auto" }),
  )
  const stageName = (id: string | number) => stages.find((stage) => stage.id === id)?.name ?? "la etapa"
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) => args.pointerCoordinates ? pointerWithin(args) : closestCenter(args)}
      onDragStart={({ active }) => {
        setDropAccepted(false)
        setReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches)
        setDragged(active.data.current?.card ?? null)
      }}
      onDragCancel={() => { setDropAccepted(false); setDragged(null) }}
      onDragEnd={(event) => {
        const source = event.active.data.current?.card as OpportunityListItem | undefined
        const target = stages.find((stage) => stage.id === event.over?.id)
        // Solo una entrega aceptada a etapa abierta permanece en destino.
        // Cancelar, soltar fuera o cerrar sin motivo todavía devuelve al origen.
        setDropAccepted(Boolean(source && target && target.kind === "open" && target.id !== source.stageId && props.canMove && !props.movePending))
        setDragged(null)
        props.onDragEnd(event)
      }}
      accessibility={{
        screenReaderInstructions: { draggable: "Pulsa espacio para levantar la oportunidad, flechas para elegir etapa y espacio para soltar. Escape cancela. También puedes usar el menú de acciones." },
        announcements: {
          onDragStart: ({ active }) => `Has levantado ${active.data.current?.card.title ?? "la oportunidad"}. Elige una etapa.`,
          onDragOver: ({ over }) => over ? `Destino: ${stageName(over.id)}.` : "Fuera del tablero. Soltar cancelará el movimiento.",
          onDragEnd: ({ over }) => over ? `Has soltado en ${stageName(over.id)}. Espera la confirmación de guardado; cerrar requiere motivo.` : "Movimiento cancelado.",
          onDragCancel: () => "Movimiento cancelado. La oportunidad conserva su etapa.",
        },
      }}
    >
      <p role="status" className="sr-only">
        {props.pendingId ? "Guardando movimiento." : props.feedback
          ? props.feedback.kind === "saved" ? `Movimiento guardado en ${props.feedback.stageName}.` : `La tarjeta regresó a ${props.feedback.stageName}.`
          : ""}
      </p>
      <ScrollArea horizontal aria-label="Tablero de oportunidades" className="min-h-0 flex-1 rounded-2xl [&_[data-slot=scroll-area-viewport]]:overscroll-contain">
        <div className="flex min-h-full w-max min-w-full items-stretch gap-4 pb-3">
          {stages.map((stage, index) => (
            <StageLoader
              key={stage.id}
              stage={stage}
              stageIndex={index}
              stages={stages}
              pipelineId={props.pipelineId}
              q={props.q}
              onlyMine={props.onlyMine}
              onlyDue={props.onlyDue}
              params={props.paramsFor(stage.id)}
              total={props.summaryByStage[stage.id]?.count}
              amount={sumAmounts(props.summaryByStage[stage.id] ? [props.summaryByStage[stage.id]] : [], orgLocale)}
              memberName={props.memberName}
              canMove={props.canMove}
              onMoveRequest={props.onMoveRequest}
              onReopenRequest={props.onReopenRequest}
              movePending={props.movePending}
              pendingId={props.pendingId}
              feedback={props.feedback}
            />
          ))}
        </div>
      </ScrollArea>
      <DragOverlay transition={reducedMotion ? "none" : undefined} dropAnimation={reducedMotion || dropAccepted ? null : { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }}>
        {dragged && <div aria-hidden className="pointer-events-none cursor-grabbing rounded-2xl border border-primary/30 bg-card p-4 shadow-2xl ring-4 ring-primary/10 motion-safe:rotate-2">
          <CardContents card={dragged} assignee={props.memberName(dragged.assignedUserId)} />
        </div>}
      </DragOverlay>
    </DndContext>
  )
}

/**
 * Una columna con su propia paginación por cursor (C07): cada etapa recorre
 * su `nextCursor` con "Cargar más" en vez de truncar en 100.
 */
function StageLoader({
  stage,
  stageIndex,
  amount,
  pendingId,
  feedback,
  stages,
  pipelineId,
  q,
  onlyMine,
  onlyDue,
  params,
  total,
  memberName,
  canMove,
  onMoveRequest,
  onReopenRequest,
  movePending,
}: BoardShared & {
  stage: Pipeline["stages"][number]
  stages: Pipeline["stages"]
  params: URLSearchParams
  total: number | undefined
  stageIndex: number
  amount: string | null
  pendingId: string | null
}) {
  const cardsQuery = useInfiniteQuery({
    queryKey: ["pipeline-cards", pipelineId, stage.id, q, onlyMine, onlyDue],
    queryFn: ({ pageParam }: { pageParam: string | null }) => {
      const search = new URLSearchParams(params)
      search.set("limit", String(CARD_LIMIT))
      if (pageParam) search.set("cursor", pageParam)
      return apiFetch<{ data: OpportunityListItem[]; nextCursor: string | null }>(
        `/api/opportunities?${search}`,
      )
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })
  const cards = useMemo(
    () => cardsQuery.data?.pages.flatMap((page) => page.data) ?? [],
    [cardsQuery.data],
  )
  return (
    <StageColumn
      stageId={stage.id}
      name={stage.name}
      kind={stage.kind}
      stageIndex={stageIndex}
      amount={amount}
      pendingId={pendingId}
      feedback={feedback}
      cards={cards}
      total={total}
      isLoading={cardsQuery.isLoading && cards.length === 0}
      isRefreshing={cardsQuery.isFetching && !cardsQuery.isLoading && !cardsQuery.isFetchingNextPage}
      isError={cardsQuery.isError}
      hasCards={cards.length > 0}
      onRetry={() => void cardsQuery.refetch()}
      hasNextPage={cardsQuery.hasNextPage}
      isFetchingNextPage={cardsQuery.isFetchingNextPage}
      onLoadMore={() => void cardsQuery.fetchNextPage()}
      memberName={memberName}
      stages={stages}
      canMove={canMove}
      onMoveRequest={onMoveRequest}
      onReopenRequest={onReopenRequest}
      movePending={movePending}
    />
  )
}

/**
 * Cierre con motivo obligatorio (C04/C05): el arrastre a una etapa terminal
 * nunca mueve en silencio; pide el motivo y muestra el error sin mover la
 * tarjeta.
 */
function CloseWithReasonDialog({
  target,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  target: { opp: OpportunityListItem; outcome: "won" | "lost" } | null
  pending: boolean
  error: string | null
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState("")
  useEffect(() => {
    if (target) setReason("")
  }, [target])
  return (
    <FormDrawer
      open={target !== null}
      onClose={() => {
        if (!pending) onClose()
      }}
      title={
        target?.outcome === "won"
          ? `Cerrar como ganada: ${target?.opp.title ?? ""}`
          : `Cerrar como perdida: ${target?.opp.title ?? ""}`
      }
      description="El motivo es obligatorio y queda en el historial de la oportunidad."
      onSubmit={(event) => {
        event.preventDefault()
        if (target && reason.trim()) onConfirm(reason.trim())
      }}
      isSubmitting={pending}
      error={error}
      submitLabel="Cerrar con motivo"
      cancelLabel="Cancelar"
      submitDisabled={!reason.trim()}
    >
      <Field>
        <FieldLabel htmlFor="pipeline-close-reason">Motivo (obligatorio)</FieldLabel>
        <Input
          id="pipeline-close-reason"
          value={reason}
          maxLength={500}
          placeholder={
            target?.outcome === "won" ? "Aceptó el plan de tratamiento…" : "Eligió otra clínica…"
          }
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
    </FormDrawer>
  )
}

function StageColumn({
  stageId, name, kind, stageIndex, amount, cards, total, isLoading, isRefreshing, isError,
  hasCards, onRetry, hasNextPage, isFetchingNextPage, onLoadMore, memberName, stages,
  canMove, onMoveRequest, onReopenRequest, movePending, pendingId, feedback,
}: {
  stageId: string
  name: string
  kind: string
  stageIndex: number
  amount: string | null
  cards: OpportunityListItem[]
  total: number | undefined
  isLoading: boolean
  isRefreshing: boolean
  isError: boolean
  hasCards: boolean
  onRetry: () => void
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
  memberName: (userId: string | null) => string
  stages: Pipeline["stages"]
  canMove: boolean
  onMoveRequest: (opp: OpportunityListItem, stageId: string) => void
  onReopenRequest: (opp: OpportunityListItem) => void
  movePending: boolean
  pendingId: string | null
  feedback: MoveFeedback | null
}) {
  const { active } = useDndContext()
  const { setNodeRef, isOver } = useDroppable({ id: stageId, disabled: !canMove || isLoading || isError || movePending })
  const incoming = isOver && active?.data.current?.card.stageId !== stageId
  const listRef = useRef<HTMLDivElement>(null)
  const positions = useRef(new Map<string, number>())
  // FLIP local: anima solo el espacio que cambió, sin librería ni estado paralelo.
  useBoardLayoutEffect(() => {
    const next = new Map<string, number>()
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    for (const element of listRef.current?.querySelectorAll<HTMLElement>("[data-opportunity-id]") ?? []) {
      const id = element.dataset.opportunityId!
      const top = element.offsetTop
      next.set(id, top)
      const previous = positions.current.get(id)
      const arriving = previous === undefined && (pendingId === id || (feedback?.id === id && feedback.kind === "returned"))
      if (!reduce && (arriving || (previous !== undefined && previous !== top))) {
        element.getAnimations().forEach((animation) => animation.cancel())
        element.animate(arriving
          ? [{ opacity: 0.4, transform: "scale(0.97)" }, { opacity: 1, transform: "scale(1)" }]
          : [{ transform: `translateY(${previous! - top}px)` }, { transform: "translateY(0)" }], {
          duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        })
      }
    }
    positions.current = next
  }, [cards, incoming, pendingId, feedback])
  const accent = kind === "won" ? "bg-emerald-500" : kind === "lost" ? "bg-rose-400"
    : ["bg-sky-500", "bg-violet-500", "bg-amber-500"][stageIndex % 3]
  return (
    <section
      ref={setNodeRef}
      aria-label={`Etapa ${name}`}
      className={`flex w-[min(19rem,82vw)] min-w-0 shrink-0 flex-col rounded-2xl border p-2 transition-colors duration-200 motion-reduce:transition-none lg:w-[19rem] ${
        incoming ? "border-primary/50 bg-primary/5 ring-2 ring-primary/10" : "border-transparent bg-muted/45"
      }`}
    >
      <header className="sticky top-0 z-10 flex shrink-0 items-start justify-between gap-3 rounded-t-xl bg-muted px-2 pb-4 pt-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${accent}`} />
            <span className="truncate">{name}</span>
            <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">{total ?? cards.length}</span>
          </h2>
          <p className="mt-1.5 pl-4.5 text-xs tabular-nums text-muted-foreground">{amount ?? "Sin importe estimado"}</p>
        </div>
        {kind === "won" && <Check aria-hidden className="size-4 text-success" />}
      </header>
      <div ref={listRef} className="relative flex min-h-32 flex-1 flex-col gap-3 px-0.5 pb-1">
        {incoming && <div
          className="flex shrink-0 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/40 bg-background/65 p-4 text-center text-sm text-primary motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
          style={{ minHeight: Math.min(active?.rect.current.initial?.height ?? 128, 220) }}
        >
          <ArrowRight aria-hidden className="size-5" />
          <span className="font-medium">Soltar en {name}</span>
          {kind !== "open" && <span className="text-xs text-muted-foreground">Después indica el motivo del cierre</span>}
        </div>}
        {isRefreshing ? <DataRefreshMarker /> : null}
        {isLoading ? <div aria-label="Cargando oportunidades" className="flex flex-col gap-3">
          {[0, 1, 2].map((row) => <div key={row} className="h-36 rounded-xl bg-background/70 p-4 motion-safe:animate-pulse"><div className="h-3 w-3/4 rounded bg-muted" /><div className="mt-3 h-2.5 w-1/2 rounded bg-muted" /><div className="mt-8 h-3 w-1/3 rounded bg-muted" /></div>)}
        </div> : isError && !hasCards ? <div role="alert" className="rounded-xl bg-background p-4 text-sm">
          <p>No se pudo cargar esta etapa.</p><Button variant="link" size="sm" onClick={onRetry}>Reintentar</Button>
        </div> : !cards.length && !incoming ? <div className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/80 px-4 text-center">
          <Circle aria-hidden className="size-5 text-muted-foreground/40" />
          <p className="text-xs text-muted-foreground">{active ? "Arrastra la tarjeta aquí" : "Todavía no hay oportunidades"}</p>
        </div> : null}
        {isError && hasCards ? <div role="alert" className="rounded-xl bg-background p-4 text-sm">
          <p>No se pudo actualizar esta etapa; se conservan las tarjetas cargadas.</p><Button variant="link" size="sm" onClick={onRetry}>Reintentar solo la etapa</Button>
        </div> : null}
        {cards.map((card) => <DraggableCard
          key={card.id} card={card} memberName={memberName} stages={stages} canMove={canMove}
          onMoveRequest={onMoveRequest} onReopenRequest={onReopenRequest}
          movePending={movePending} saving={pendingId === card.id}
          feedback={feedback?.id === card.id ? feedback : null}
        />)}
        {hasNextPage && <Button type="button" variant="ghost" size="sm" disabled={isFetchingNextPage} onClick={onLoadMore}>
          {isFetchingNextPage ? (
            <>
              <Spinner className="size-6" aria-hidden />
              Cargar más · {cards.length} visibles
            </>
          ) : (
            `Cargar más · ${cards.length} visibles`
          )}
        </Button>}
      </div>
    </section>
  )
}

/**
 * Importe histórico con la moneda congelada del registro y el formato de la
 * clínica. Sin locale (perfil aún cargando) devuelve null: cada superficie
 * muestra su estado neutro en vez de inventar un precio.
 */
export function formatMoney(amountCents: number | null, currency: string, locale?: string): string | null {
  if (amountCents === null || !locale) return null
  try {
    return sharedFormatMoney(amountCents, currency, locale)
  } catch {
    return null
  }
}

function DraggableCard({
  card, memberName, stages, canMove, onMoveRequest, onReopenRequest, movePending, saving, feedback,
}: {
  card: OpportunityListItem
  memberName: (userId: string | null) => string
  stages: Pipeline["stages"]
  canMove: boolean
  onMoveRequest: (opp: OpportunityListItem, stageId: string) => void
  onReopenRequest: (opp: OpportunityListItem) => void
  movePending: boolean
  saving: boolean
  feedback: MoveFeedback | null
}) {
  const draggable = canMove && card.status === "open" && !movePending
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: card.id, data: { card }, disabled: !draggable,
  })
  const actions = canMove
    ? opportunityActionItems(card, stages, { onMoveRequest, onReopenRequest, disabled: movePending })
    : []
  return (
    <article
      ref={setNodeRef}
      aria-label={card.title}
      data-opportunity-id={card.id}
      aria-busy={saving}
      onMouseDown={(event) => {
        if (!(event.target as HTMLElement).closest("a,button,input")) listeners?.onMouseDown?.(event)
      }}
      onTouchStart={(event) => {
        if (!(event.target as HTMLElement).closest("a,button,input")) listeners?.onTouchStart?.(event)
      }}
      className={`group relative shrink-0 rounded-xl border bg-card p-4 text-sm transition-[opacity,box-shadow,border-color] duration-200 motion-reduce:transition-none ${
        isDragging ? "border-dashed border-primary/40 opacity-25" : "border-border/50 shadow-sm hover:border-primary/25 hover:shadow-md"
      } ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${saving ? "ring-2 ring-primary/20" : ""}`}
    >
      <CardContents
        card={card}
        assignee={memberName(card.assignedUserId)}
        title={<Link to="/opportunities/$opportunityId" params={{ opportunityId: card.id }} className="rounded-sm font-semibold leading-snug text-foreground outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring">{card.title}</Link>}
        actions={<div className="-mr-2 -mt-1 flex shrink-0 items-center">
          {canMove && card.status === "open" && <button
            ref={setActivatorNodeRef}
            type="button"
            disabled={!draggable}
            aria-label={`Arrastrar ${card.title}`}
            title="Arrastrar a otra etapa · espacio y flechas con teclado"
            className="touch-none cursor-grab rounded-md p-1.5 text-muted-foreground/60 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-wait motion-reduce:transition-none"
            {...attributes} {...listeners}
          ><GripVertical aria-hidden className="size-4" /></button>}
          {actions.length > 0 && <RowActions label={`Acciones de ${card.title}`} items={actions} />}
        </div>}
        saving={saving}
        feedback={feedback}
      />
    </article>
  )
}

function CardContents({ card, assignee, title, actions, saving = false, feedback = null }: {
  card: OpportunityListItem
  assignee: string
  title?: React.ReactNode
  actions?: React.ReactNode
  saving?: boolean
  feedback?: MoveFeedback | null
}) {
  const profile = useOrgProfile()
  const money = formatMoney(card.amountCents, card.currency, profile.data?.locale)
  const overdue = isOverdue(card.nextActionAt)
  return <div className="flex min-w-0 flex-col gap-3">
    <div className="flex items-start justify-between gap-2">
      <h3 className="min-w-0 break-words text-sm font-semibold leading-snug">{title ?? card.title}</h3>
      {saving ? <span className="flex h-8 w-16 shrink-0 items-center justify-end" aria-label="Guardando movimiento"><Spinner className="size-4 text-[var(--identity-accent)]" aria-hidden /></span> : actions}
    </div>
    <div className="min-w-0 space-y-1">
      <p className="truncate text-xs text-muted-foreground" title={card.contactName}>{card.contactName}</p>
      {card.patientName && <p className="flex items-center gap-1.5 text-xs"><UserRound aria-hidden className="size-3 shrink-0 text-muted-foreground" /><span className="truncate">{card.patientName}</span></p>}
      {card.interestText && <p className="line-clamp-1 text-xs text-muted-foreground">{card.interestText}</p>}
    </div>
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm font-semibold tabular-nums tracking-tight">{money ?? (profile.isPending ? "…" : <span className="text-xs font-normal text-muted-foreground">Sin importe</span>)}</span>
      <span title={`Responsable: ${assignee}`} aria-label={`Responsable: ${assignee}`} className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground ring-2 ring-card">
        {card.assignedUserId ? assignee.split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("") : <UserRound aria-hidden className="size-3.5" />}
      </span>
    </div>
    {card.nextActionAt && <div className={`flex items-start gap-2 border-t border-border/50 pt-3 text-xs ${overdue ? "text-warning" : "text-muted-foreground"}`}>
      <CalendarClock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0"><p className="font-medium">{overdue ? "Vencido · " : ""}{formatDueAt(card.nextActionAt)}</p>{card.nextActionNote && <p className="mt-1 line-clamp-1 text-muted-foreground" title={card.nextActionNote}>{card.nextActionNote}</p>}</div>
    </div>}
    {(saving || feedback) && <p className={`flex items-center gap-1.5 text-xs font-medium ${feedback?.kind === "returned" ? "text-warning" : saving ? "text-primary" : "text-success"}`}>
      {saving ? <><Spinner aria-hidden className="size-3 text-[var(--identity-accent)]" /> Guardando en {card.stageName}…</>
        : feedback?.kind === "returned" ? <><Undo2 aria-hidden className="size-3" /> Volvió a {feedback.stageName}</>
        : <><Check aria-hidden className="size-3" /> Guardada en {feedback?.stageName}</>}
    </p>}
  </div>
}

function PipelineListView({
  pipelineId,
  stages,
  params,
  queryKey,
  memberName,
  canMove,
  onMoveRequest,
  onReopenRequest,
  movePending,
}: {
  pipelineId: string
  stages: Pipeline["stages"]
  params: URLSearchParams
  queryKey: unknown[]
  memberName: (userId: string | null) => string
  canMove: boolean
  onMoveRequest: (opp: OpportunityListItem, stageId: string) => void
  onReopenRequest: (opp: OpportunityListItem) => void
  movePending: boolean
}) {
  const profile = useOrgProfile()
  const orgLocale = profile.data?.locale
  const listQuery = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }: { pageParam: string | null }) => {
      const search = new URLSearchParams(params)
      search.set("limit", String(CARD_LIMIT))
      if (pageParam) search.set("cursor", pageParam)
      return apiFetch<{ data: OpportunityListItem[]; nextCursor: string | null }>(
        `/api/opportunities?${search}`,
      )
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(pipelineId),
  })
  const rows = useMemo(
    () => listQuery.data?.pages.flatMap((p) => p.data) ?? [],
    [listQuery.data],
  )
  const stageName = (stageId: string) => stages.find((s) => s.id === stageId)?.name ?? "—"

  const columns = useMemo<ColumnDef<OpportunityListItem>[]>(
    () => [
      {
        accessorKey: "title",
        header: "Título",
        meta: { view: { role: "title" } },
        cell: ({ row }) => (
          <Link
            to="/opportunities/$opportunityId"
            params={{ opportunityId: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.title}
          </Link>
        ),
      },
      {
        accessorKey: "stageId",
        header: "Etapa",
        meta: { view: { primary: true } },
        cell: ({ row }) => <Badge variant="secondary">{stageName(row.original.stageId)}</Badge>,
      },
      { accessorKey: "contactName", header: "Persona", meta: { view: { primary: true } } },
      {
        id: "paciente",
        header: "Paciente",
        meta: { view: { primary: true } },
        cell: ({ row }) => row.original.patientName ?? "—",
      },
      {
        id: "valor",
        header: "Valor",
        cell: ({ row }) => formatMoney(row.original.amountCents, row.original.currency, orgLocale) ?? "—",
      },
      {
        id: "responsable",
        header: "Responsable",
        cell: ({ row }) => memberName(row.original.assignedUserId),
      },
      {
        id: "accion",
        header: "Próxima acción",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          if (!row.original.nextActionAt) return "—"
          const overdue = isOverdue(row.original.nextActionAt)
          return (
            <span className={overdue ? "font-medium text-destructive" : undefined}>
              {overdue ? "Vencida · " : ""}
              {formatDueAt(row.original.nextActionAt)}
              {row.original.nextActionNote ? ` · ${row.original.nextActionNote}` : ""}
            </span>
          )
        },
      },
      {
        id: "edad",
        header: "Edad",
        cell: ({ row }) => timeAgo(row.original.createdAt),
      },
      ...(canMove
        ? [
            {
              id: "acciones",
              header: "Acciones",
              meta: { view: { role: "actions" } },
              cell: ({ row }: { row: { original: OpportunityListItem } }) => {
                const card = row.original
                return (
                  <RowActions
                    label={`Acciones de ${card.title}`}
                    items={opportunityActionItems(card, stages, {
                      onMoveRequest,
                      onReopenRequest,
                      disabled: movePending,
                    })}
                  />
                )
              },
            } as ColumnDef<OpportunityListItem>,
          ]
        : []),
    ],
    [stages, memberName, canMove, onMoveRequest, onReopenRequest, movePending, orgLocale],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })

  if (listQuery.isLoading && rows.length === 0) return <DataTableSkeleton />
  if (listQuery.isError && rows.length === 0) {
    return (
      <ErrorState
        error={listQuery.error instanceof Error ? listQuery.error : String(listQuery.error)}
        onRetry={() => void listQuery.refetch()}
      />
    )
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Sin oportunidades"
        description="No hay oportunidades que coincidan con los filtros aplicados."
      />
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <DataTable
        table={table}
        isFetching={listQuery.isFetching && !listQuery.isFetchingNextPage}
      />
      {listQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudo actualizar la lista; se conservan las oportunidades cargadas.{" "}
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => void listQuery.refetch()}
          >
            Reintentar solo la lista
          </Button>
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted-foreground" role="status">
          Mostrando {rows.length} oportunidad{rows.length === 1 ? "" : "es"}
        </p>
        {listQuery.hasNextPage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={listQuery.isFetchingNextPage}
            onClick={() => void listQuery.fetchNextPage()}
          >
            {listQuery.isFetchingNextPage ? (
              <>
                <Spinner className="size-6" aria-hidden />
                Cargar más
              </>
            ) : (
              "Cargar más"
            )}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
