import {
  closestCenter, pointerWithin, DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor,
  useDndContext, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type KeyboardCoordinateGetter,
} from "@dnd-kit/core"
import { Badge, Button, ScrollArea, Spinner } from "@odentia/ui"
import {
  DataRefreshMarker,
  DataTable,
  DataTableSkeleton,
  EmptyState,
  ErrorState,
  ExpandableText,
  FilterBar,
  PageHeader,
  PageShell,
  RowActions,
  type RowActionItem,
  useListSearch,
} from "@odentia/ui-patterns"
import { type InfiniteData, useInfiniteQuery, useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { ArrowRight, CalendarClock, Check, Circle, Columns3, GripVertical, List, Undo2, UserRound } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { type CloseTarget, CloseOpportunityDialog } from "../../components/crm/close-opportunity-dialog"
import { dueWords, isOverdue, moneyText } from "../../components/crm/crm-helpers"
import { OpportunityDrawer } from "../../components/crm/opportunity-drawer"
import { OpportunityPanel } from "../../components/crm/opportunity-panel"
import { apiFetch } from "../../lib/api"
import {
  type OpportunityListItem,
  type Pipeline,
  type Stage,
  TASK_AREA_LABEL,
  useMemberName,
  useMyUserId,
  usePermission,
} from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"
import { useOrgProfile } from "../../lib/org"

export const Route = createFileRoute("/_org/pipeline")({
  /** `oportunidad` abre una oportunidad al lado del tablero (enlaces de avisos, Tareas y la ruta antigua). */
  validateSearch: (search: Record<string, unknown>): { oportunidad?: string } => ({
    ...search,
    oportunidad: typeof search.oportunidad === "string" ? search.oportunidad : undefined,
  }),
  component: PipelinePage,
})

interface SummaryStage {
  stageId: string
  count: number
  amounts: Array<{ currency: string; amountCents: string }>
}

interface Summary {
  total: number
  open: number
  openAmounts: Array<{ currency: string; amountCents: string }>
  stages: SummaryStage[]
}

const CARD_LIMIT = 30
const useBoardLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

/** Colores de cada paso: la columna se reconoce sin leer su nombre. */
const MOMENT_ACCENT: Record<Stage["moment"], string> = {
  interesado: "bg-sky-500",
  evaluacion_agendada: "bg-violet-500",
  presupuesto_enviado: "bg-amber-500",
  decidio: "bg-emerald-500",
}

/**
 * El tablero de ventas (ADR 0028): cuatro pasos fijos por los que la
 * oportunidad avanza sola; cada tarjeta dice por qué está donde está. Muestra
 * lo abierto y lo cerrado de los últimos 30 días, y su total suma solo lo
 * abierto. Arrastrar o «Mover a…» corrige lo que no pasó por la aplicación;
 * cerrar pide siempre su motivo.
 */
function PipelinePage() {
  const queryClient = useQueryClient()
  const myUserId = useMyUserId()
  const memberName = useMemberName()
  const profile = useOrgProfile()
  const orgLocale = profile.data?.locale
  const canWrite = usePermission("crm.write")
  const listSearch = useListSearch()
  const q = listSearch.get("q") ?? ""
  const embudo = listSearch.get("embudo")
  const vista = listSearch.get("vista") === "lista" ? "lista" : "tablero"
  const responsable = listSearch.get("asignado") ?? "todas"
  const onlyDue = listSearch.get("tarea") === "vencida"
  const openId = listSearch.get("oportunidad") ?? null
  const boardFetching = useIsFetching({ queryKey: ["pipeline-cards"] })
  const listFetching = useIsFetching({ queryKey: ["pipeline-list"] })
  const [createOpen, setCreateOpen] = useState(false)
  const [closeTarget, setCloseTarget] = useState<CloseTarget | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [moveFeedback, setMoveFeedback] = useState<MoveFeedback | null>(null)

  const pipelinesQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
  })
  const pipelines = useMemo(() => pipelinesQuery.data?.data ?? [], [pipelinesQuery.data])
  const pipeline = pipelines.find((p) => p.id === embudo) ?? pipelines.find((p) => p.isDefault) ?? pipelines[0] ?? null
  const stages = useMemo(() => pipeline?.stages ?? [], [pipeline])
  const filterKey = [q, responsable, onlyDue] as const

  function pipelineParams(withStage?: string): URLSearchParams {
    const params = new URLSearchParams({ recent: "true" })
    if (pipeline) params.set("pipelineId", pipeline.id)
    if (withStage) params.set("stageId", withStage)
    if (q.trim()) params.set("q", q.trim())
    if (responsable === "mias") params.set("assignedUserId", myUserId)
    if (responsable === "recepcion") params.set("assignedUserId", "none")
    if (onlyDue) params.set("taskDue", "true")
    return params
  }

  // Totales completos del servidor con los mismos filtros: nunca se confunde la muestra cargada con el total.
  const summaryQuery = useQuery({
    queryKey: ["opportunity-summary", pipeline?.id, ...filterKey],
    queryFn: () => apiFetch<{ data: Summary }>(`/api/opportunities/summary?${pipelineParams()}`),
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
    for (const key of ["pipeline-cards", "pipeline-list", "opportunity-summary", "opportunity"]) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }

  useOrgEvents(
    ["message.created", "conversation.updated", "opportunity.updated", "task.updated", "contact.updated", "appointment.updated", "stream.reconnected"],
    () => {
      // El refetch del evento propio no debe deshacer la respuesta optimista.
      if (!queryClient.isMutating({ mutationKey: ["pipeline-move"] })) invalidate()
      void queryClient.invalidateQueries({ queryKey: ["pipelines"] })
    },
  )

  const moveMutation = useMutation({
    mutationKey: ["pipeline-move"],
    mutationFn: ({ opportunity, stage }: { opportunity: OpportunityListItem; stage: Stage }) =>
      apiFetch(`/api/opportunities/${opportunity.id}/move`, { method: "POST", body: JSON.stringify({ stageId: stage.id }) }),
    onMutate: ({ opportunity, stage }) => {
      setMoveError(null)
      setMoveFeedback(null)
      const fromKey = ["pipeline-cards", opportunity.pipelineId, opportunity.stageId, ...filterKey]
      const toKey = ["pipeline-cards", opportunity.pipelineId, stage.id, ...filterKey]
      const summaryKey = ["opportunity-summary", opportunity.pipelineId, ...filterKey]
      for (const queryKey of [fromKey, toKey, summaryKey]) void queryClient.cancelQueries({ queryKey, exact: true })
      const from = queryClient.getQueryData<CardPages>(fromKey)
      const to = queryClient.getQueryData<CardPages>(toKey)
      const previousSummary = queryClient.getQueryData<{ data: Summary }>(summaryKey)
      const withoutCard = (data: CardPages): CardPages => ({
        ...data,
        pages: data.pages.map((page) => ({ ...page, data: page.data.filter((row) => row.id !== opportunity.id) })),
      })
      if (from) queryClient.setQueryData(fromKey, withoutCard(from))
      if (to) {
        const updated = withoutCard(to)
        queryClient.setQueryData(toKey, {
          ...updated,
          pages: updated.pages.map((page, index) =>
            index === 0
              ? { ...page, data: [{ ...opportunity, stageId: stage.id, stageName: stage.name, moment: stage.moment, why: null }, ...page.data] }
              : page,
          ),
        })
      }
      if (previousSummary) {
        queryClient.setQueryData(summaryKey, {
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
      }
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
    onSettled: () =>
      Promise.all(
        [["pipeline-cards"], ["pipeline-list"], ["opportunity-summary"], ["opportunity"], ["crm-opportunities"], ["crm-context"]].map(
          (queryKey) => queryClient.invalidateQueries({ queryKey }),
        ),
      ),
  })

  const reopenMutation = useMutation({
    mutationFn: (opportunityId: string) => apiFetch(`/api/opportunities/${opportunityId}/reopen`, { method: "POST" }),
    onSuccess: () => {
      setMoveError(null)
      invalidate()
    },
    onError: (err: Error) => setMoveError(err.message),
  })

  /** Mover por arrastre o por «Mover a…»: a «Decidió» siempre se pasa por cerrar con motivo. */
  function requestMove(opp: OpportunityListItem, targetStageId: string) {
    if (moveMutation.isPending || reopenMutation.isPending || opp.status !== "open" || targetStageId === opp.stageId) return
    const target = stages.find((s) => s.id === targetStageId)
    if (!target) return
    if (target.moment === "decidio") {
      setCloseTarget({ id: opp.id, title: opp.title, outcome: null })
      return
    }
    moveMutation.mutate({ opportunity: opp, stage: target })
  }
  const actions: CardActions = {
    canMove: canWrite,
    movePending: moveMutation.isPending || reopenMutation.isPending,
    onMoveRequest: requestMove,
    onClose: (opp, outcome) => setCloseTarget({ id: opp.id, title: opp.title, outcome }),
    onReopen: (opp) => reopenMutation.mutate(opp.id),
    onOpen: (opp) => listSearch.setParam("oportunidad", opp.id),
  }

  if (pipelinesQuery.isLoading) {
    return (
      <PageShell>
        <DataTableSkeleton label="Cargando el tablero…" />
      </PageShell>
    )
  }
  if (!pipeline) {
    return (
      <PageShell>
        <ErrorState error="No se pudo cargar el tablero de ventas." onRetry={() => void pipelinesQuery.refetch()} />
      </PageShell>
    )
  }

  const openAmount = sumAmounts(summary?.openAmounts ?? [], orgLocale)
  const subtitle = summary
    ? `${summary.open} ${summary.open === 1 ? "abierta" : "abiertas"}${openAmount ? ` · ${openAmount}` : ""}`
    : pipelines.length > 1
      ? pipeline.name
      : undefined

  return (
    <PageShell fill className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="Oportunidades"
        subtitle={pipelines.length > 1 && summary ? `${pipeline.name} · ${subtitle}` : subtitle}
        actions={
          canWrite ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              Nueva oportunidad
            </Button>
          ) : undefined
        }
      />
      <div className="flex items-center gap-2 rounded-xl bg-card p-2">
        <FilterBar
          className="min-w-0 flex-1 rounded-none bg-transparent p-1"
          filters={[
            // El embudo solo se elige si hay más de uno: con uno solo no cambia nada.
            ...(pipelines.length > 1
              ? [{ key: "embudo", label: "Embudo", type: "select" as const, options: pipelines.map((p) => ({ value: p.id, label: p.name })) }]
              : []),
            {
              key: "asignado",
              label: "Quién la lleva",
              type: "select",
              options: [
                { value: "todas", label: "Todas" },
                { value: "mias", label: "Las mías" },
                { value: "recepcion", label: "Recepción, sin tomar" },
              ],
            },
            {
              key: "tarea",
              label: "Tarea",
              type: "select",
              options: [
                { value: "todas", label: "Todas" },
                { value: "vencida", label: "Con la tarea vencida" },
              ],
            },
          ]}
          sortOptions={[]}
          searchPlaceholder="Buscar por persona o interés…" searchLabel="Buscar en oportunidades"
          searchPending={boardFetching + listFetching > 0}
          resetKeys={["q", "asignado", "tarea"]}
        />
        <div role="group" aria-label="Vista de oportunidades" className="flex shrink-0 gap-0.5 rounded-lg bg-muted/70 p-1">
          <Button variant="ghost" size="icon" aria-label="Vista tablero" aria-pressed={vista === "tablero"} className={vista === "tablero" ? "bg-background shadow-sm" : "text-muted-foreground"} onClick={() => listSearch.setParam("vista", undefined)}>
            <Columns3 className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Vista lista" aria-pressed={vista === "lista"} className={vista === "lista" ? "bg-background shadow-sm" : "text-muted-foreground"} onClick={() => listSearch.setParam("vista", "lista")}>
            <List className="size-4" />
          </Button>
        </div>
      </div>
      {summaryQuery.isError ? (
        <ErrorState error={summaryQuery.error instanceof Error ? summaryQuery.error : String(summaryQuery.error)} onRetry={() => void summaryQuery.refetch()} />
      ) : null}
      {moveError ? (
        <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">
          No se pudo actualizar la oportunidad: {moveError} La tarjeta regresó a su paso anterior.
        </p>
      ) : null}
      {vista === "lista" ? (
        <PipelineListView
          stages={stages}
          params={pipelineParams()}
          queryKey={["pipeline-list", pipeline.id, ...filterKey]}
          memberName={memberName}
          actions={actions}
        />
      ) : (
        <BoardColumns
          pipelineId={pipeline.id}
          stages={stages}
          filterKey={filterKey}
          paramsFor={(stageId) => pipelineParams(stageId)}
          summaryByStage={summaryByStage}
          memberName={memberName}
          actions={actions}
          pendingId={moveMutation.isPending ? moveMutation.variables.opportunity.id : null}
          feedback={moveFeedback}
        />
      )}
      <OpportunityDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={(detail) => {
          invalidate()
          listSearch.setParam("oportunidad", detail.id)
        }}
      />
      <CloseOpportunityDialog
        target={closeTarget}
        onClose={() => setCloseTarget(null)}
        onClosed={() => {
          setCloseTarget(null)
          setMoveError(null)
          invalidate()
        }}
      />
      <OpportunityPanel opportunityId={openId} onClose={() => listSearch.setParam("oportunidad", undefined)} />
    </PageShell>
  )
}

function sumAmounts(amounts: Array<{ currency: string; amountCents: string }>, locale: string | undefined): string | null {
  if (!locale || amounts.length === 0) return null
  const parts: string[] = []
  for (const entry of amounts) {
    const cents = Number(entry.amountCents)
    if (!Number.isFinite(cents)) continue
    const text = moneyText(cents, entry.currency, locale)
    if (text === null) return null
    parts.push(text)
  }
  return parts.length ? parts.join(" + ") : null
}

interface MoveFeedback {
  id: string
  kind: "saved" | "returned"
  stageName: string
}

interface CardActions {
  canMove: boolean
  movePending: boolean
  onMoveRequest: (opp: OpportunityListItem, stageId: string) => void
  onClose: (opp: OpportunityListItem, outcome: "won" | "lost") => void
  onReopen: (opp: OpportunityListItem) => void
  onOpen: (opp: OpportunityListItem) => void
}

/** «Mover a…»: la vía con teclado del arrastre, y cerrar con su motivo. */
function opportunityActionItems(card: OpportunityListItem, stages: Stage[], actions: CardActions): RowActionItem[] {
  const open: RowActionItem = { key: "abrir", label: "Abrir", onSelect: () => actions.onOpen(card) }
  if (!actions.canMove) return [open]
  if (card.status !== "open") {
    return [open, { key: "reabrir", label: "Reabrir", disabled: actions.movePending, onSelect: () => actions.onReopen(card) }]
  }
  const items: RowActionItem[] = [open]
  for (const stage of stages) {
    if (stage.moment === "decidio" || stage.id === card.stageId) continue
    items.push({ key: `mover-${stage.id}`, label: `Mover a ${stage.name}`, disabled: actions.movePending, onSelect: () => actions.onMoveRequest(card, stage.id) })
  }
  items.push({ key: "ganada", label: "Ganada", disabled: actions.movePending, onSelect: () => actions.onClose(card, "won") })
  items.push({ key: "perdida", label: "Perdida", disabled: actions.movePending, onSelect: () => actions.onClose(card, "lost") })
  return items
}

function BoardColumns(props: {
  pipelineId: string
  stages: Stage[]
  filterKey: readonly unknown[]
  paramsFor: (stageId: string) => URLSearchParams
  summaryByStage: Record<string, SummaryStage>
  memberName: (userId: string) => string
  actions: CardActions
  pendingId: string | null
  feedback: MoveFeedback | null
}) {
  const { stages, actions } = props
  const profile = useOrgProfile()
  const orgLocale = profile.data?.locale
  const [dragged, setDragged] = useState<OpportunityListItem | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [dropAccepted, setDropAccepted] = useState(false)
  const keyboardCoordinates = useCallback<KeyboardCoordinateGetter>((event, { currentCoordinates, context }) => {
    const direction = event.code === "ArrowRight" || event.code === "ArrowDown" ? 1 : event.code === "ArrowLeft" || event.code === "ArrowUp" ? -1 : 0
    if (!direction) return
    event.preventDefault()
    const currentId = context.over?.id ?? context.active?.data.current?.card.stageId
    const index = stages.findIndex((stage) => stage.id === currentId)
    const target = stages[index + direction]
    const rect = target && context.droppableRects.get(target.id)
    if (!rect || !context.collisionRect) return
    return { x: currentCoordinates.x + rect.left - context.collisionRect.left + (rect.width - context.collisionRect.width) / 2, y: currentCoordinates.y }
  }, [stages])
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates, scrollBehavior: "auto" }),
  )
  const stageName = (id: string | number) => stages.find((stage) => stage.id === id)?.name ?? "el paso"
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) => (args.pointerCoordinates ? pointerWithin(args) : closestCenter(args))}
      onDragStart={({ active }) => {
        setDropAccepted(false)
        setReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches)
        setDragged(active.data.current?.card ?? null)
      }}
      onDragCancel={() => {
        setDropAccepted(false)
        setDragged(null)
      }}
      onDragEnd={(event: DragEndEvent) => {
        const source = event.active.data.current?.card as OpportunityListItem | undefined
        const target = stages.find((stage) => stage.id === event.over?.id)
        // Solo una entrega aceptada a un paso abierto permanece en destino;
        // «Decidió» pide antes el motivo y la tarjeta vuelve mientras tanto.
        setDropAccepted(Boolean(source && target && target.moment !== "decidio" && target.id !== source.stageId && actions.canMove && !actions.movePending))
        setDragged(null)
        if (source && event.over) actions.onMoveRequest(source, String(event.over.id))
      }}
      accessibility={{
        screenReaderInstructions: {
          draggable: "Pulsa espacio para levantar la oportunidad, flechas para elegir el paso y espacio para soltar. Escape cancela. También puedes usar «Mover a…» en sus acciones.",
        },
        announcements: {
          onDragStart: ({ active }) => `Has levantado ${active.data.current?.card.title ?? "la oportunidad"}. Elige un paso.`,
          onDragOver: ({ over }) => (over ? `Destino: ${stageName(over.id)}.` : "Fuera del tablero. Soltar cancelará el movimiento."),
          onDragEnd: ({ over }) => (over ? `Has soltado en ${stageName(over.id)}. Espera la confirmación; cerrar pide su motivo.` : "Movimiento cancelado."),
          onDragCancel: () => "Movimiento cancelado. La oportunidad conserva su paso.",
        },
      }}
    >
      <p role="status" className="sr-only">
        {props.pendingId
          ? "Guardando movimiento."
          : props.feedback
            ? props.feedback.kind === "saved"
              ? `Movimiento guardado en ${props.feedback.stageName}.`
              : `La tarjeta regresó a ${props.feedback.stageName}.`
            : ""}
      </p>
      <ScrollArea horizontal aria-label="Tablero de oportunidades" className="min-h-0 flex-1 rounded-2xl [&_[data-slot=scroll-area-viewport]]:overscroll-contain">
        <div className="flex min-h-full w-max min-w-full items-stretch gap-4 pb-3">
          {stages.map((stage) => (
            <StageLoader
              key={stage.id}
              stage={stage}
              stages={stages}
              pipelineId={props.pipelineId}
              filterKey={props.filterKey}
              params={props.paramsFor(stage.id)}
              total={props.summaryByStage[stage.id]?.count}
              amount={stage.moment === "decidio" ? null : sumAmounts(props.summaryByStage[stage.id]?.amounts ?? [], orgLocale)}
              memberName={props.memberName}
              actions={actions}
              pendingId={props.pendingId}
              feedback={props.feedback}
            />
          ))}
        </div>
      </ScrollArea>
      <DragOverlay transition={reducedMotion ? "none" : undefined} dropAnimation={reducedMotion || dropAccepted ? null : { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }}>
        {dragged && (
          <div aria-hidden className="pointer-events-none cursor-grabbing rounded-2xl border border-primary/30 bg-card p-4 shadow-2xl ring-4 ring-primary/10 motion-safe:rotate-2">
            <CardContents card={dragged} memberName={props.memberName} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}

/** Una columna con su propia paginación por cursor: cada paso recorre su `nextCursor` con «Cargar más». */
function StageLoader({
  stage, stages, pipelineId, filterKey, params, total, amount, memberName, actions, pendingId, feedback,
}: {
  stage: Stage
  stages: Stage[]
  pipelineId: string
  filterKey: readonly unknown[]
  params: URLSearchParams
  total: number | undefined
  amount: string | null
  memberName: (userId: string) => string
  actions: CardActions
  pendingId: string | null
  feedback: MoveFeedback | null
}) {
  const cardsQuery = useInfiniteQuery({
    queryKey: ["pipeline-cards", pipelineId, stage.id, ...filterKey],
    queryFn: ({ pageParam }: { pageParam: string | null }) => {
      const search = new URLSearchParams(params)
      search.set("limit", String(CARD_LIMIT))
      if (pageParam) search.set("cursor", pageParam)
      return apiFetch<{ data: OpportunityListItem[]; nextCursor: string | null }>(`/api/opportunities?${search}`)
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })
  const cards = useMemo(() => cardsQuery.data?.pages.flatMap((page) => page.data) ?? [], [cardsQuery.data])
  const { active } = useDndContext()
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, disabled: !actions.canMove || cardsQuery.isLoading || actions.movePending })
  const incoming = isOver && active?.data.current?.card.stageId !== stage.id
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
        element.animate(
          arriving
            ? [{ opacity: 0.4, transform: "scale(0.97)" }, { opacity: 1, transform: "scale(1)" }]
            : [{ transform: `translateY(${previous! - top}px)` }, { transform: "translateY(0)" }],
          { duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
        )
      }
    }
    positions.current = next
  }, [cards, incoming, pendingId, feedback])
  const decided = stage.moment === "decidio"
  return (
    <section
      ref={setNodeRef}
      aria-label={`Paso ${stage.name}`}
      className={`flex w-[min(19rem,82vw)] min-w-0 shrink-0 flex-col rounded-2xl border p-2 transition-colors duration-200 motion-reduce:transition-none lg:w-[19rem] ${
        incoming ? "border-primary/50 bg-primary/5 ring-2 ring-primary/10" : "border-transparent bg-muted/45"
      }`}
    >
      <header className="sticky top-0 z-10 flex shrink-0 items-start justify-between gap-3 rounded-t-xl bg-muted px-2 pb-4 pt-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${MOMENT_ACCENT[stage.moment]}`} />
            <span className="truncate">{stage.name}</span>
            <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">{total ?? cards.length}</span>
          </h2>
          <p className="mt-1.5 pl-4.5 text-xs tabular-nums text-muted-foreground">{decided ? "Últimos 30 días" : (amount ?? "Sin valor estimado")}</p>
        </div>
      </header>
      <div ref={listRef} className="relative flex min-h-32 flex-1 flex-col gap-3 px-0.5 pb-1">
        {incoming && (
          <div
            className="flex shrink-0 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/40 bg-background/65 p-4 text-center text-sm text-primary motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
            style={{ minHeight: Math.min(active?.rect.current.initial?.height ?? 128, 220) }}
          >
            <ArrowRight aria-hidden className="size-5" />
            <span className="font-medium">Soltar en {stage.name}</span>
            {decided && <span className="text-xs text-muted-foreground">Después eliges si se ganó o se perdió, con su motivo</span>}
          </div>
        )}
        {cardsQuery.isFetching && !cardsQuery.isLoading && !cardsQuery.isFetchingNextPage ? <DataRefreshMarker /> : null}
        {cardsQuery.isLoading && cards.length === 0 ? (
          <div aria-label="Cargando oportunidades" className="flex flex-col gap-3">
            {[0, 1, 2].map((row) => (
              <div key={row} className="h-32 rounded-xl bg-background/70 p-4 motion-safe:animate-pulse">
                <div className="h-3 w-3/4 rounded bg-muted" />
                <div className="mt-3 h-2.5 w-1/2 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : cardsQuery.isError && cards.length === 0 ? (
          <div role="alert" className="rounded-xl bg-background p-4 text-sm">
            <p>No se pudo cargar este paso.</p>
            <Button variant="link" size="sm" onClick={() => void cardsQuery.refetch()}>
              Reintentar
            </Button>
          </div>
        ) : !cards.length && !incoming ? (
          <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/80 px-4 text-center">
            <Circle aria-hidden className="size-5 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              {active ? "Arrastra la tarjeta aquí" : decided ? "Nada decidido en los últimos 30 días" : "Ninguna oportunidad en este paso"}
            </p>
          </div>
        ) : null}
        {cardsQuery.isError && cards.length > 0 ? (
          <div role="alert" className="rounded-xl bg-background p-4 text-sm">
            <p>No se pudo actualizar este paso; se conservan las tarjetas cargadas.</p>
            <Button variant="link" size="sm" onClick={() => void cardsQuery.refetch()}>
              Reintentar solo este paso
            </Button>
          </div>
        ) : null}
        {cards.map((card) => (
          <DraggableCard
            key={card.id}
            card={card}
            stages={stages}
            memberName={memberName}
            actions={actions}
            saving={pendingId === card.id}
            feedback={feedback?.id === card.id ? feedback : null}
          />
        ))}
        {cardsQuery.hasNextPage && (
          <Button type="button" variant="ghost" size="sm" disabled={cardsQuery.isFetchingNextPage} onClick={() => void cardsQuery.fetchNextPage()}>
            {cardsQuery.isFetchingNextPage ? <Spinner className="size-6" aria-hidden /> : null}
            Cargar más · {cards.length} visibles
          </Button>
        )}
      </div>
    </section>
  )
}

function DraggableCard({
  card, stages, memberName, actions, saving, feedback,
}: {
  card: OpportunityListItem
  stages: Stage[]
  memberName: (userId: string) => string
  actions: CardActions
  saving: boolean
  feedback: MoveFeedback | null
}) {
  const draggable = actions.canMove && card.status === "open" && !actions.movePending
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: card.id, data: { card }, disabled: !draggable })
  return (
    <article
      ref={setNodeRef}
      aria-label={`${card.contactName} · ${card.title}`}
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
        memberName={memberName}
        title={
          <Button
            type="button"
            variant="link"
            className="h-auto min-h-0 whitespace-normal p-0 text-left font-semibold leading-snug text-foreground hover:text-primary"
            onClick={() => actions.onOpen(card)}
          >
            {card.contactName} · {card.title}
          </Button>
        }
        actions={
          <div className="-mr-2 -mt-1 flex shrink-0 items-center">
            {actions.canMove && card.status === "open" && (
              <Button
                ref={setActivatorNodeRef}
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={!draggable}
                aria-label={`Arrastrar ${card.title}`}
                title="Arrastrar a otro paso · espacio y flechas con teclado"
                className="touch-none cursor-grab text-muted-foreground/60 active:cursor-grabbing"
                {...attributes}
                {...listeners}
              >
                <GripVertical aria-hidden className="size-4" />
              </Button>
            )}
            <RowActions label={`Acciones de ${card.title}`} items={opportunityActionItems(card, stages, actions)} />
          </div>
        }
        saving={saving}
        feedback={feedback}
      />
    </article>
  )
}

/** La tarjeta: quién y qué, por qué está donde está, su tarea y su valor. */
function CardContents({
  card, memberName, title, actions, saving = false, feedback = null,
}: {
  card: OpportunityListItem
  memberName: (userId: string) => string
  title?: React.ReactNode
  actions?: React.ReactNode
  saving?: boolean
  feedback?: MoveFeedback | null
}) {
  const profile = useOrgProfile()
  const money = moneyText(card.amountCents, card.currency, profile.data?.locale)
  const task = card.nextTask
  const overdue = task ? isOverdue(task.dueAt) : false
  const owner = card.assignedUserId ? memberName(card.assignedUserId) : "Recepción"
  const taskOwner = task
    ? task.assigneeUserId
      ? memberName(task.assigneeUserId)
      : TASK_AREA_LABEL[(task.area ?? "recepcion") as keyof typeof TASK_AREA_LABEL] ?? "Recepción"
    : null
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 break-words text-sm font-semibold leading-snug">{title ?? `${card.contactName} · ${card.title}`}</h3>
        {saving ? (
          <span className="flex h-8 w-16 shrink-0 items-center justify-end" aria-label="Guardando movimiento">
            <Spinner className="size-4 text-[var(--identity-accent)]" aria-hidden />
          </span>
        ) : (
          actions
        )}
      </div>
      {card.why ? <p className="text-xs text-muted-foreground">{card.why}</p> : null}
      {task ? (
        <p className={`flex items-start gap-1.5 text-xs ${overdue ? "font-medium text-warning" : "text-muted-foreground"}`}>
          <CalendarClock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            {task.title}
            {task.dueAt ? ` · ${overdue ? "venció " : "vence "}${dueWords(task.dueAt)}` : ""} · {taskOwner}
          </span>
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        {card.status === "won" ? (
          <Badge variant="success">Ganada</Badge>
        ) : card.status === "lost" ? (
          <Badge variant="destructive">Perdida</Badge>
        ) : (
          <span className="text-sm font-semibold tabular-nums tracking-tight">
            {money ?? (profile.isPending ? "…" : <span className="text-xs font-normal text-muted-foreground">Sin valor</span>)}
          </span>
        )}
        <span
          title={`Responsable: ${owner}`}
          aria-label={`Responsable: ${owner}`}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground ring-2 ring-card"
        >
          {card.assignedUserId ? owner.split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("") : <UserRound aria-hidden className="size-3.5" />}
        </span>
      </div>
      {(saving || feedback) && (
        <p className={`flex items-center gap-1.5 text-xs font-medium ${feedback?.kind === "returned" ? "text-warning" : saving ? "text-primary" : "text-success"}`}>
          {saving ? (
            <>
              <Spinner aria-hidden className="size-3 text-[var(--identity-accent)]" /> Guardando en {card.stageName}…
            </>
          ) : feedback?.kind === "returned" ? (
            <>
              <Undo2 aria-hidden className="size-3" /> Volvió a {feedback.stageName}
            </>
          ) : (
            <>
              <Check aria-hidden className="size-3" /> Guardada en {feedback?.stageName}
            </>
          )}
        </p>
      )}
    </div>
  )
}

function PipelineListView({
  stages, params, queryKey, memberName, actions,
}: {
  stages: Stage[]
  params: URLSearchParams
  queryKey: unknown[]
  memberName: (userId: string) => string
  actions: CardActions
}) {
  const profile = useOrgProfile()
  const orgLocale = profile.data?.locale
  const listQuery = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }: { pageParam: string | null }) => {
      const search = new URLSearchParams(params)
      search.set("limit", String(CARD_LIMIT))
      if (pageParam) search.set("cursor", pageParam)
      return apiFetch<{ data: OpportunityListItem[]; nextCursor: string | null }>(`/api/opportunities?${search}`)
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })
  const rows = useMemo(() => listQuery.data?.pages.flatMap((p) => p.data) ?? [], [listQuery.data])
  const columns = useMemo<ColumnDef<OpportunityListItem>[]>(
    () => [
      {
        id: "oportunidad",
        header: "Oportunidad",
        meta: { view: { role: "title" } },
        cell: ({ row }) => (
          <div className="min-w-0 max-w-sm md:min-w-48">
            <ExpandableText text={`${row.original.contactName} · ${row.original.title}`} label="oportunidad" className="font-medium" />
            <Button type="button" variant="link" className="min-h-11 px-0" onClick={() => actions.onOpen(row.original)}>Abrir oportunidad</Button>
          </div>
        ),
      },
      {
        id: "paso",
        header: "Paso",
        meta: { view: { primary: true } },
        cell: ({ row }) =>
          row.original.status === "won" ? (
            <Badge variant="success">Ganada</Badge>
          ) : row.original.status === "lost" ? (
            <Badge variant="destructive">Perdida</Badge>
          ) : (
            <Badge variant="secondary">{row.original.stageName}</Badge>
          ),
      },
      { id: "porque", header: "Por qué está aquí", cell: ({ row }) => <ExpandableText text={row.original.why ?? "—"} label="motivo de la etapa" /> },
      {
        id: "tarea",
        header: "Tarea",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const task = row.original.nextTask
          if (!task) return "—"
          const overdue = isOverdue(task.dueAt)
          return (
            <div className={overdue ? "font-medium text-destructive" : undefined}>
              <ExpandableText text={task.title} label="próxima tarea" />
              {task.dueAt ? <span>{overdue ? "Venció " : ""}{dueWords(task.dueAt)}</span> : null}
            </div>
          )
        },
      },
      { id: "valor", header: "Valor", cell: ({ row }) => <span className="whitespace-nowrap">{moneyText(row.original.amountCents, row.original.currency, orgLocale) ?? "—"}</span> },
      { id: "responsable", header: "Quién la lleva", cell: ({ row }) => (row.original.assignedUserId ? memberName(row.original.assignedUserId) : "Recepción") },
      {
        id: "acciones",
        header: "Acciones",
        meta: { view: { role: "actions" } },
        cell: ({ row }) => <RowActions label={`Acciones de ${row.original.title}`} items={opportunityActionItems(row.original, stages, actions)} />,
      },
    ],
    [stages, memberName, actions, orgLocale],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  if (listQuery.isLoading && rows.length === 0) return <DataTableSkeleton />
  if (listQuery.isError && rows.length === 0) {
    return <ErrorState error={listQuery.error instanceof Error ? listQuery.error : String(listQuery.error)} onRetry={() => void listQuery.refetch()} />
  }
  if (rows.length === 0) {
    return <EmptyState title="Sin oportunidades" description="No hay oportunidades abiertas ni decididas en los últimos 30 días con estos filtros." />
  }
  return (
    <div className="flex flex-col gap-2">
      <DataTable className="[&_td]:whitespace-normal [&_td]:[overflow-wrap:anywhere]" table={table} isFetching={listQuery.isFetching && !listQuery.isFetchingNextPage} />
      {listQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudo actualizar la lista; se conservan las oportunidades cargadas.{" "}
          <Button type="button" variant="link" size="sm" onClick={() => void listQuery.refetch()}>
            Reintentar solo la lista
          </Button>
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted-foreground" role="status">
          Mostrando {rows.length} oportunidad{rows.length === 1 ? "" : "es"}
        </p>
        {listQuery.hasNextPage ? (
          <Button type="button" variant="outline" size="sm" disabled={listQuery.isFetchingNextPage} onClick={() => void listQuery.fetchNextPage()}>
            {listQuery.isFetchingNextPage ? <Spinner className="size-6" aria-hidden /> : null}
            Cargar más
          </Button>
        ) : null}
      </div>
    </div>
  )
}
