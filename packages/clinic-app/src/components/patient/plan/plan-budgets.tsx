/**
 * «Presupuesto» en la pestaña Plan (tablero 3): una tarjeta por presupuesto
 * vigente con su estado en palabras y una acción según ese estado —«Revisar y
 * enviar», «¿Qué respondió?», «Agendar»—; lo anulado o reemplazado queda en
 * «Anteriores». Al abrir la tarjeta se ve el presupuesto como lo recibe la
 * persona, con sus opciones; quien presupuesta (odontólogo, propietario)
 * arma el borrador y cambia precios, y recepción lo envía, anota la respuesta
 * y agenda (decisión 4).
 */
import {
  Badge,
  Button,
  ButtonGroup,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  Textarea,
} from "@odentia/ui"
import { ConfirmDialog, EmptyState, ErrorState, FormDrawer, LoadingState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError, apiFetchBytes } from "../../../lib/api"
import {
  type AdjustBudgetLineBody,
  addBudgetItemsApi,
  adjustBudgetLinesApi,
  BUDGET_ANSWERABLE_STATUSES,
  BUDGET_SENDABLE_STATUSES,
  type BudgetWithTotals,
  budgetNumberLabel,
  budgetOptionApi,
  budgetPdfUrl,
  cancelBudgetApi,
  createBudgetApi,
  deliverBudgetApi,
  fetchBudgets,
  optionLines,
  PLAN_QUERY_KEYS,
  removeBudgetItemsApi,
  reviseBudgetApi,
  updateBudgetApi,
  valueOption,
} from "../../../lib/budgets"
import { useMemberName, usePermission } from "../../../lib/crm"
import { useOrgEvents } from "../../../lib/org-events"
import type { PlanItem } from "../../../lib/patients"
import { fetchPromotions } from "../../../lib/promotions"
import { BudgetDraftEditor } from "./budget-draft-editor"
import {
  AMOUNT_PENDING,
  BudgetLinesList,
  BudgetTotals,
  budgetStatusTone,
  type Money,
  mutationMessage,
  SessionNote,
  treatmentSiteLabel,
  useBudgetFormat,
} from "./budget-parts"
import { BudgetResponse } from "./budget-response"
import { BudgetReviewDrawer } from "./budget-review"
import { BudgetSendButton } from "./budget-send"
import { appWords } from "../../../lib/product-words"
import { productUi } from "../../../product/product-ui"
import { openBookingAnywhere } from "../../agenda/schedule-host"

/** Lo que ya no es vigente: se ve en «Anteriores». */
const PAST = ["cancelado", "sustituido"]

/** Escrituras del presupuesto con sus invalidaciones (y la guarda de la atención, si la hay). */
function useBudgetWrites(patientId: string, guard?: { disabled?: boolean; beforeWrite?: () => Promise<void> }) {
  const queryClient = useQueryClient()
  return async <T,>(operation: () => Promise<T>): Promise<T> => {
    if (guard?.disabled) throw new Error("Espera a que termine el guardado de la atención.")
    await guard?.beforeWrite?.()
    const result = await operation()
    await Promise.all(PLAN_QUERY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key, patientId] })))
    return result
  }
}

/** Ítems que pueden entrar a un presupuesto nuevo: sin presupuesto vigente, o que no se aceptaron. */
export function quotableItems(items: PlanItem[], budgetsById: Map<string, BudgetWithTotals>): PlanItem[] {
  return items.filter((item) => {
    if (["realizado", "cancelado", "reemplazado"].includes(item.status)) return false
    if (item.priceCents == null) return false
    if (!item.budgetId) return true
    if (item.decision === "rechazado" || item.decision === "no_elegida") return true
    return budgetsById.get(item.budgetId)?.status === "cancelado"
  })
}

export function PlanBudgets({
  patientId,
  planItems,
  focusBudgetId,
  respondBudgetId,
  scheduleItemIds,
  onSchedule,
}: {
  patientId: string
  /** Tratamientos del plan (solo para quien lee la clínica): los que pueden entrar al borrador. */
  planItems: PlanItem[] | null
  /** Abre esta tarjeta (enlace, «Te espera», «Qué sigue»). */
  focusBudgetId?: string
  /** Abre «¿Qué respondió?» de este presupuesto. */
  respondBudgetId?: string
  /** Lo aceptado sin cita (de «Qué sigue»): la tarjeta ofrece «Agendar». */
  scheduleItemIds: string[]
  onSchedule: (planItemIds: string[], serviceId?: string | null) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const canWrite = usePermission("budgets.write")
  const canCatalog = usePermission("catalog.read")
  const format = useBudgetFormat()
  const budgetsQuery = useQuery({
    queryKey: ["budgets", patientId],
    queryFn: () => fetchBudgets(patientId),
  })
  const promotionsQuery = useQuery({
    queryKey: ["promotions", "vigentes"],
    queryFn: () => fetchPromotions({ scope: "vigentes" }),
    enabled: canWrite && canCatalog,
  })
  useOrgEvents(["budget.updated", "encounter.finalized", "patient.account.updated"], () => {
    for (const key of PLAN_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [key, patientId] })
  })
  const budgets = useMemo(() => budgetsQuery.data?.data ?? [], [budgetsQuery.data])
  const budgetsById = useMemo(() => new Map(budgets.map((b) => [b.id, b])), [budgets])
  const current = budgets
    .filter((budget) => !PAST.includes(budget.status))
    .sort((a, b) => order(a) - order(b) || b.budgetNumber - a.budgetNumber)
  const past = budgets.filter((budget) => PAST.includes(budget.status)).sort((a, b) => b.budgetNumber - a.budgetNumber)
  const quotable = planItems ? quotableItems(planItems, budgetsById) : []
  const draft = current.find((budget) => budget.status === "borrador" && !budget.supersedesBudgetId) ?? null
  const runWrite = useBudgetWrites(patientId)
  const [prepareError, setPrepareError] = useState<string | null>(null)
  const prepare = useMutation({
    mutationFn: () => runWrite(() => createBudgetApi(patientId, { itemIds: quotable.map((item) => item.id) })),
    onSuccess: () => setPrepareError(null),
    onError: (err) => setPrepareError(mutationMessage(err)),
  })

  if (budgetsQuery.isPending) return <LoadingState message="Cargando presupuestos…" />
  if (budgetsQuery.isError)
    return (
      <ErrorState
        error={budgetsQuery.error instanceof ApiError ? budgetsQuery.error.shape : null}
        onRetry={() => void budgetsQuery.refetch()}
      />
    )

  const canPrepare = canWrite && quotable.length > 0
  // latidIA (decisión 15 del issue 229): lo indicado ya queda aceptado y el presupuesto es opcional.
  const budgetRequired = productUi().plan.budgetRequired
  return (
    <div className="flex flex-col gap-3">
      {current.length === 0 ? (
        <EmptyState
          title={budgetRequired ? "Todavía no tiene presupuesto" : "Sin presupuesto"}
          description={
            !budgetRequired
              ? "No hace falta para agendar ni para atender."
              : canPrepare
                ? "Se arma solo al firmar la atención con lo indicado. También puedes prepararlo ahora con lo que ya está en el plan."
                : `Se arma solo al firmar la atención con lo que el ${appWords().clinician.one} indicó.`
          }
          actionLabel={canPrepare ? "Preparar presupuesto" : undefined}
          onAction={canPrepare && !prepare.isPending ? () => prepare.mutate() : undefined}
        />
      ) : (
        current.map((budget) => (
          <BudgetCard
            key={budget.id}
            patientId={patientId}
            budget={budget}
            money={format.money}
            day={format.day}
            locale={format.locale}
            localePending={format.localePending}
            onRetryLocale={format.retryLocale}
            promotions={promotionsQuery.data?.data ?? []}
            promotionsFailed={promotionsQuery.isError}
            onRetryPromotions={() => void promotionsQuery.refetch()}
            addable={budget === draft ? quotableForDraft(budget, planItems ?? [], quotable) : []}
            defaultOpen={budget.id === focusBudgetId || budget.id === respondBudgetId}
            respond={budget.id === respondBudgetId}
            scheduleItemIds={scheduleItemIds.filter((id) => budget.items.some((line) => line.planItemId === id))}
            onSchedule={onSchedule}
            runWrite={runWrite}
          />
        ))
      )}
      {current.length > 0 && canPrepare && !draft ? (
        <div>
          <Button type="button" size="sm" variant="outline" disabled={prepare.isPending} onClick={() => prepare.mutate()}>
            Preparar presupuesto con lo pendiente ({quotable.length})
          </Button>
        </div>
      ) : null}
      {prepareError ? (
        <p role="alert" className="text-sm text-destructive">
          {prepareError}
        </p>
      ) : null}
      {past.length > 0 ? (
        <Collapsible className="flex flex-col gap-2">
          <CollapsibleTrigger
            render={
              <Button type="button" variant="link" className="group h-auto self-start p-0">
                Anteriores ({past.length})
                <ChevronDown
                  aria-hidden
                  className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none"
                />
              </Button>
            }
          />
          <CollapsibleContent className="flex flex-col gap-2">
            {past.map((budget) => (
              <BudgetCard
                key={budget.id}
                patientId={patientId}
                budget={budget}
                money={format.money}
                day={format.day}
                locale={format.locale}
                localePending={format.localePending}
                onRetryLocale={format.retryLocale}
                promotions={[]}
                promotionsFailed={false}
                onRetryPromotions={() => {}}
                addable={[]}
                defaultOpen={budget.id === focusBudgetId}
                respond={false}
                scheduleItemIds={[]}
                onSchedule={onSchedule}
                runWrite={runWrite}
              />
            ))}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  )
}

/** Primero lo que espera algo de la clínica: por enviar, lo que espera respuesta, lo decidido. */
function order(budget: BudgetWithTotals): number {
  if (budget.status === "borrador") return 0
  if (budget.awaitsAnswer) return 1
  return 2
}

/** En el borrador puede entrar lo cotizable y, en otra opción, lo que ya está en él. */
function quotableForDraft(budget: BudgetWithTotals, items: PlanItem[], quotable: PlanItem[]): PlanItem[] {
  const inBudget = items.filter((item) => item.budgetId === budget.id)
  return [...quotable, ...inBudget]
}

function BudgetCard({
  patientId,
  budget,
  money,
  day,
  locale,
  localePending,
  onRetryLocale,
  promotions,
  promotionsFailed,
  onRetryPromotions,
  addable,
  defaultOpen,
  respond,
  scheduleItemIds,
  onSchedule,
  runWrite,
}: {
  patientId: string
  budget: BudgetWithTotals
  money: Money
  day: (iso: string | null | undefined) => string
  locale: string | undefined
  localePending: boolean
  onRetryLocale: () => void
  promotions: Awaited<ReturnType<typeof fetchPromotions>>["data"]
  promotionsFailed: boolean
  onRetryPromotions: () => void
  /** Tratamientos que pueden entrar al borrador (en alguna de sus opciones). */
  addable: PlanItem[]
  defaultOpen: boolean
  respond: boolean
  scheduleItemIds: string[]
  onSchedule: (planItemIds: string[], serviceId?: string | null) => void
  runWrite: <T>(operation: () => Promise<T>) => Promise<T>
}): React.JSX.Element {
  const cardRef = useRef<HTMLElement | null>(null)
  const canWrite = usePermission("budgets.write")
  const canSend = usePermission("budgets.send")
  const memberName = useMemberName()
  const [open, setOpen] = useState(defaultOpen)
  // Un enlace (o «Qué sigue») abre la tarjeta y la trae a la vista.
  useEffect(() => {
    if (!defaultOpen) return
    setOpen(true)
    cardRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })
  }, [defaultOpen])
  const isDraft = budget.status === "borrador"
  const editable = isDraft && canWrite
  const value = valueOption(budget)
  const [optionId, setOptionId] = useState<string | null>(null)
  const option = budget.options.find((row) => row.id === optionId) ?? value ?? budget.options[0] ?? null
  const lines = option ? optionLines(budget, option.id) : budget.items
  const several = budget.options.length > 1
  const [actionError, setActionError] = useState<string | null>(null)
  const [printing, setPrinting] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [reviseOpen, setReviseOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)

  const optionMutation = useMutation({
    mutationFn: (input: { action: "duplicate" | "recommend" | "remove"; optionId: string }) =>
      runWrite(() => budgetOptionApi(patientId, budget.id, input.optionId, input.action)),
    onSuccess: (result, input) => {
      setActionError(null)
      if (input.action === "duplicate") setOptionId(result.data.options.at(-1)?.id ?? null)
      if (input.action === "remove") setOptionId(null)
    },
    onError: (err) => setActionError(mutationMessage(err)),
  })
  const cancelMutation = useMutation({
    mutationFn: () => runWrite(() => cancelBudgetApi(patientId, budget.id)),
    onSuccess: () => setCancelOpen(false),
    onError: (err) => {
      setActionError(mutationMessage(err))
      setCancelOpen(false)
    },
  })

  /** La pestaña se abre dentro del clic (después, el navegador la bloquea). */
  const openPrintWindow = (): Window | null => {
    const win = window.open("", "_blank")
    if (win) win.opener = null
    return win
  }
  const openPdfBytes = (win: Window | null, bytes: ArrayBuffer) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
    if (win && !win.closed) win.location.href = url
    else window.open(url, "_blank", "noopener")
  }
  /**
   * Imprimir y entregar: primero se guarda lo escrito, luego el PDF real se
   * genera ANTES de entregar; si falla, no se marca entregado.
   */
  const deliverPrint = async (pendingLines: AdjustBudgetLineBody[] = []) => {
    if (printing) return
    const win = openPrintWindow()
    setPrinting(true)
    setActionError(null)
    try {
      if (pendingLines.length > 0) await runWrite(() => adjustBudgetLinesApi(patientId, budget.id, { lines: pendingLines }))
      await apiFetchBytes(budgetPdfUrl(patientId, budget.id))
      if (isDraft) await runWrite(() => deliverBudgetApi(patientId, budget.id))
      openPdfBytes(win, await apiFetchBytes(budgetPdfUrl(patientId, budget.id)))
    } catch (err) {
      if (win && !win.closed) win.close()
      setActionError(mutationMessage(err))
    } finally {
      setPrinting(false)
    }
  }

  const accepted = budget.acceptedCents != null && budget.acceptedCents > 0 && ["aceptado", "parcial"].includes(budget.status)
  const summary = [
    `N.º ${budget.budgetNumber}${budget.revisionNumber && budget.revisionNumber > 1 ? ` · revisión ${budget.revisionNumber}` : ""}`,
    day(budget.presentedAt ?? budget.createdAt),
    several
      ? `${budget.options.length} opciones`
      : budget.totalCents == null
        ? AMOUNT_PENDING
        : money(budget.totalCents, budget.currency),
  ].join(" · ")
  const stateLine = accepted ? `${budget.stateText} · ${money(budget.acceptedCents, budget.currency)}` : budget.stateText
  const answerable = BUDGET_ANSWERABLE_STATUSES.includes(budget.status)

  // La acción principal según el estado (tablero 3, «Un solo nombre para cada estado»).
  const primary = isDraft ? (
    canSend || canWrite ? (
      <Button type="button" size="sm" onClick={() => setReviewOpen(true)}>
        Revisar y enviar
      </Button>
    ) : null
  ) : answerable && budget.awaitsAnswer ? (
    <Button type="button" size="sm" variant={open ? "outline" : "default"} onClick={() => setOpen(true)}>
      ¿Qué respondió?
    </Button>
  ) : scheduleItemIds.length > 0 ? (
    <Button
      type="button"
      size="sm"
      onClick={() =>
        onSchedule(
          scheduleItemIds,
          budget.items.find((line) => scheduleItemIds.includes(line.planItemId) && line.serviceId)?.serviceId ?? null,
        )
      }
    >
      Reservar cita
    </Button>
  ) : null

  return (
    <section
      ref={cardRef}
      aria-label={`${budgetNumberLabel(budget.budgetNumber)} · ${budget.stateText}`}
      className="flex flex-col gap-4 rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-medium">{summary}</span>
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={budgetStatusTone(budget.status)}>{stateLine}</Badge>
            {budget.createdBy ? (
              <span className="text-xs text-muted-foreground">Preparó {memberName(budget.createdBy)}</span>
            ) : null}
            {budget.seenInPortalAt ? (
              <span className="text-xs text-muted-foreground">Lo vio en el portal el {day(budget.seenInPortalAt)}</span>
            ) : null}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {primary}
          <Button type="button" size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Ocultar" : "Ver"}
          </Button>
        </div>
      </div>

      {open ? (
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex min-w-0 flex-[1_1_28rem] flex-col gap-4">
            {budget.notes ? <p className="text-sm">{budget.notes}</p> : null}
            {several || editable ? (
              <div className="flex flex-col gap-2">
                {several ? (
                  <ButtonGroup aria-label="Opciones del presupuesto" className="flex-wrap">
                    {budget.options.map((row) => (
                      <Button
                        key={row.id}
                        type="button"
                        size="sm"
                        variant={row.id === option?.id ? "default" : "outline"}
                        aria-pressed={row.id === option?.id}
                        onClick={() => setOptionId(row.id)}
                      >
                        {row.label}
                        {row.isRecommended ? " · recomendada" : ""}
                        {row.decision === "elegida" ? " · elegida" : row.decision === "no_elegida" ? " · no elegida" : ""}
                        {` · ${row.totalCents == null ? "…" : money(row.totalCents, budget.currency)}`}
                      </Button>
                    ))}
                  </ButtonGroup>
                ) : null}
                {editable && option ? (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    {budget.options.length < 3 ? (
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0"
                        disabled={optionMutation.isPending || budget.supersedesBudgetId != null}
                        onClick={() => optionMutation.mutate({ action: "duplicate", optionId: option.id })}
                      >
                        Duplicar como otra opción
                      </Button>
                    ) : null}
                    {several && !option.isRecommended ? (
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0"
                        disabled={optionMutation.isPending}
                        onClick={() => optionMutation.mutate({ action: "recommend", optionId: option.id })}
                      >
                        Marcar como recomendada
                      </Button>
                    ) : null}
                    {several ? (
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0 text-destructive"
                        disabled={optionMutation.isPending}
                        onClick={() => optionMutation.mutate({ action: "remove", optionId: option.id })}
                      >
                        Quitar la {option.label.toLowerCase()}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {several ? (
                  <p className="text-xs text-muted-foreground">
                    Cada opción tiene su propio total: nunca se suman. La persona elige una; mientras decide, vale la
                    recomendada.
                  </p>
                ) : null}
              </div>
            ) : null}

            {!locale ? (
              localePending ? (
                <LoadingState />
              ) : (
                <ErrorState
                  title="Falta el formato de moneda de la clínica"
                  message="Sin el país y la moneda de la clínica no se pueden mostrar ni editar importes."
                  onRetry={onRetryLocale}
                />
              )
            ) : editable && option ? (
              <BudgetDraftEditor
                key={option.id}
                budget={budget}
                option={option}
                lines={lines}
                promotions={promotions}
                promotionsFailed={promotionsFailed}
                onRetryPromotions={onRetryPromotions}
                locale={locale}
                money={money}
                disabled={printing || optionMutation.isPending}
                delivering={printing}
                saveLines={(patch) => runWrite(() => adjustBudgetLinesApi(patientId, budget.id, { lines: patch }))}
                addable={
                  budget.supersedesBudgetId
                    ? []
                    : addable.filter((item) => !lines.some((line) => line.planItemId === item.id))
                }
                addItems={(itemIds) => runWrite(() => addBudgetItemsApi(patientId, budget.id, itemIds, option.id))}
                removeItems={(itemIds) =>
                  runWrite(() => removeBudgetItemsApi(patientId, budget.id, itemIds, several ? option.id : null))
                }
                onDeliver={(pending) => void deliverPrint(pending)}
                actionAlert={
                  actionError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {actionError}
                    </p>
                  ) : null
                }
                sendAction={
                  canSend
                    ? (beforeSend) => <BudgetSendButton patientId={patientId} budgetId={budget.id} beforeSend={beforeSend} reviewable />
                    : undefined
                }
                secondaryActions={
                  <>
                    <Button type="button" variant="outline" disabled={printing} onClick={() => setEditOpen(true)}>
                      Título y notas
                    </Button>
                    <Button type="button" variant="outline" disabled={printing} onClick={() => setCancelOpen(true)}>
                      Anular presupuesto
                    </Button>
                  </>
                }
              />
            ) : (
              <>
                <BudgetLinesList
                  lines={lines}
                  money={money}
                  showAnswers={!isDraft}
                  label={several && option ? `Tratamientos de la ${option.label.toLowerCase()}` : undefined}
                />
                {option ? (
                  <BudgetTotals
                    option={option}
                    lines={lines}
                    currency={budget.currency}
                    money={money}
                    className="sm:max-w-sm sm:self-end"
                  />
                ) : null}
                <SessionNote lines={lines} money={money} />
                {actionError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {actionError}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-start gap-2 border-t pt-4">
                  {canSend && BUDGET_SENDABLE_STATUSES.includes(budget.status) ? (
                    <BudgetSendButton
                      patientId={patientId}
                      budgetId={budget.id}
                      variant={isDraft ? "default" : "outline"}
                    />
                  ) : null}
                  {canSend ? (
                    <SubmitButton variant="outline" pending={printing} onClick={() => void deliverPrint()}>
                      {isDraft ? "Imprimir y entregar" : "Imprimir"}
                    </SubmitButton>
                  ) : null}
                  <Button type="button" variant="outline" onClick={() => setReviewOpen(true)}>
                    Lo que se le explicó
                  </Button>
                  {canWrite && ["presentado", "aceptado", "parcial", "pospuesto"].includes(budget.status) ? (
                    <Button type="button" variant="outline" onClick={() => setReviseOpen(true)}>
                      Crear revisión
                    </Button>
                  ) : null}
                  {canWrite && budget.status === "presentado" ? (
                    <Button type="button" variant="outline" onClick={() => setCancelOpen(true)}>
                      Anular presupuesto
                    </Button>
                  ) : null}
                </div>
              </>
            )}
            {isDraft ? (
              <p className="text-xs text-muted-foreground">
                Sale por WhatsApp si la persona lo tiene; si no, por correo. Al enviarlo o imprimirlo queda entregado,
                y aquí mismo se anota qué respondió.
              </p>
            ) : null}
          </div>

          {!isDraft && (BUDGET_ANSWERABLE_STATUSES.includes(budget.status) || budget.decidedAt != null) ? (
            <BudgetResponse
              patientId={patientId}
              budget={budget}
              money={money}
              formatDay={(iso) => day(iso)}
              runWrite={runWrite}
              openOnMount={respond}
              className="flex-[1_1_20rem] xl:max-w-sm"
            />
          ) : null}
        </div>
      ) : null}

      {reviewOpen ? (
        <BudgetReviewDrawer patientId={patientId} budgetId={budget.id} onClose={() => setReviewOpen(false)} />
      ) : null}
      {editOpen ? (
        <EditBudgetDrawer
          budget={budget}
          onClose={() => setEditOpen(false)}
          onSubmit={(body) => runWrite(() => updateBudgetApi(patientId, budget.id, body))}
        />
      ) : null}
      {reviseOpen ? (
        <ReviseBudgetDrawer
          budget={budget}
          onClose={() => setReviseOpen(false)}
          onSubmit={(itemIds, reason) =>
            runWrite(() =>
              reviseBudgetApi(patientId, budget.id, { itemIds, reason, title: budget.title, notes: budget.notes ?? null }),
            )
          }
        />
      ) : null}
      <ConfirmDialog
        open={cancelOpen}
        title="Anular presupuesto"
        description="Queda como «Anulado» y conserva sus líneas. Sus tratamientos vuelven a quedar sin presupuesto, para uno nuevo. Si ya se lo enviaste, su enlace deja de servir."
        confirmLabel="Anular presupuesto"
        variant="destructive"
        pending={cancelMutation.isPending}
        onConfirm={() => cancelMutation.mutate()}
        onClose={() => {
          if (!cancelMutation.isPending) setCancelOpen(false)
        }}
      />
    </section>
  )
}

function EditBudgetDrawer({
  budget,
  onClose,
  onSubmit,
}: {
  budget: BudgetWithTotals
  onClose: () => void
  onSubmit: (body: { title?: string; notes?: string | null }) => Promise<unknown>
}): React.JSX.Element {
  const uid = useId()
  const [title, setTitle] = useState(budget.title)
  const [notes, setNotes] = useState(budget.notes ?? "")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  return (
    <FormDrawer
      open
      title="Título y notas del presupuesto"
      description="Salen en la hoja que recibe la persona."
      error={error}
      isSubmitting={pending}
      isDirty={title !== budget.title || notes !== (budget.notes ?? "")}
      submitLabel="Guardar"
      onClose={() => {
        if (!pending) onClose()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        const nextTitle = title.trim()
        if (!nextTitle) {
          setError("Escribe un título para el presupuesto.")
          return
        }
        setPending(true)
        onSubmit({
          ...(nextTitle === budget.title ? {} : { title: nextTitle }),
          notes: notes.trim() === "" ? null : notes.trim(),
        })
          .then(onClose)
          .catch((err: unknown) => setError(mutationMessage(err)))
          .finally(() => setPending(false))
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${uid}-title`}>Título</FieldLabel>
          <Input id={`${uid}-title`} value={title} maxLength={200} onChange={(e) => setTitle(e.currentTarget.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${uid}-notes`}>Notas</FieldLabel>
          <Textarea
            id={`${uid}-notes`}
            value={notes}
            rows={3}
            maxLength={4000}
            onChange={(e) => setNotes(e.currentTarget.value)}
          />
        </Field>
      </FieldGroup>
    </FormDrawer>
  )
}

function ReviseBudgetDrawer({
  budget,
  onClose,
  onSubmit,
}: {
  budget: BudgetWithTotals
  onClose: () => void
  onSubmit: (itemIds: string[], reason: string) => Promise<unknown>
}): React.JSX.Element {
  const uid = useId()
  const value = valueOption(budget)
  const lines = value ? optionLines(budget, value.id) : budget.items
  const [itemIds, setItemIds] = useState(() => lines.map((line) => line.planItemId))
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  return (
    <FormDrawer
      open
      title="Crear revisión del presupuesto"
      description="La revisión conserva el número y lo versiona: el anterior queda «Reemplazado». No se puede retirar una línea ya hecha, con cargo o con pago aplicado."
      error={error}
      isSubmitting={pending}
      submitLabel="Crear revisión"
      onClose={() => {
        if (!pending) onClose()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        if (itemIds.length === 0) {
          setError("Elige al menos un tratamiento para la revisión.")
          return
        }
        if (!reason.trim()) {
          setError("Indica el motivo de la revisión.")
          return
        }
        setPending(true)
        onSubmit(itemIds, reason.trim())
          .then(onClose)
          .catch((err: unknown) => setError(mutationMessage(err)))
          .finally(() => setPending(false))
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Tratamientos de la revisión</legend>
        {lines.map((line) => (
          <FieldLabel key={line.id} className="flex items-start gap-2 text-sm font-normal">
            <Checkbox
              checked={itemIds.includes(line.planItemId)}
              aria-label={line.title}
              onCheckedChange={() =>
                setItemIds((current) =>
                  current.includes(line.planItemId)
                    ? current.filter((id) => id !== line.planItemId)
                    : [...current, line.planItemId],
                )
              }
            />
            <span>
              {line.title}
              {treatmentSiteLabel(line) ? ` · ${treatmentSiteLabel(line)}` : ""}
            </span>
          </FieldLabel>
        ))}
      </fieldset>
      <Field>
        <FieldLabel htmlFor={`${uid}-reason`}>Motivo de la revisión</FieldLabel>
        <Textarea id={`${uid}-reason`} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </FormDrawer>
  )
}

/** Abre «Nueva cita» al lado, con la persona, el servicio y lo aceptado ya puestos: nadie sale de la ficha. */
export function useScheduleAccepted(patient: { id: string; name: string }) {
  return (planItemIds: string[], serviceId?: string | null) => {
    openBookingAnywhere({ patient, lockedPatient: true, planItemIds, ...(serviceId ? { serviceId } : {}) })
  }
}
