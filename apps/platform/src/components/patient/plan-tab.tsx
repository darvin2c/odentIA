import {
  formatMoney,
  formatMoneyAmount,
  formatMoneyInput,
  isMinor,
  parseMoney,
  sumAcceptedCents,
} from "@odentia/clinical"
import {
  Badge,
  Button,
  ButtonGroup,
  Checkbox,
  cn,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Skeleton,
  Textarea,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  SubmitButton,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Check } from "lucide-react"
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError, apiFetch, apiFetchBytes } from "../../lib/api"
import {
  type AdjustBudgetLineBody,
  addBudgetItemsApi,
  BUDGET_ANSWERABLE_STATUSES,
  type BudgetLine,
  type BudgetWithTotals,
  adjustBudgetLinesApi,
  budgetAnswerLabel,
  budgetNumberLabel,
  budgetPdfUrl,
  budgetStatusLabel,
  cancelBudgetApi,
  createBudgetApi,
  decideBudgetApi,
  deliverBudgetApi,
  fetchBudgetDetail,
  fetchBudgets,
  fetchTreatmentPlanDetail,
  fetchTreatmentPlans,
  removeBudgetItemsApi,
  reviseBudgetApi,
  updateBudgetApi,
} from "../../lib/budgets"
import {
  createOptionGroupApi,
  fetchResponsibilities,
  setItemAlternativeApi,
} from "../../lib/clinical-journey"
import { useMemberName, usePermission } from "../../lib/crm"
import { label as glossaryLabel } from "../../lib/glossary"
import { useOrgProfile } from "../../lib/org"
import { useOrgEvents } from "../../lib/org-events"
import type { PatientFull, PlanItem, TreatmentPlanWithStatus } from "../../lib/patients"
import { fetchPromotions, type Promotion } from "../../lib/promotions"
import { SendFinancialDocument } from "../finance-documents/SendFinancialDocument"
import { ChoiceSelect } from "../ui/choice-select"

/**
 * Importe con la moneda y el formato de la clínica. `plain` es el mismo importe
 * sin símbolo, para las cifras de una lista cuyo total ya dice la moneda.
 */
type Money = ((cents: number | null, currency: string) => string) & {
  plain: (cents: number | null, currency: string) => string
}

function mutationMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.shape.message) return err.shape.message
    if (err.shape.code) return `No se pudo guardar (${err.shape.code}). Inténtalo de nuevo.`
  }
  return err instanceof Error ? err.message : "No se pudo guardar. Inténtalo de nuevo."
}

/** Fecha corta con el formato y la zona horaria de la clínica. */
function formatDate(
  iso: string | null | undefined,
  locale: string | undefined,
  timeZone: string | undefined,
): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone,
  })
}

/** Sitio clínico resumido de un ítem o línea (nunca inventa piezas). */
export function treatmentSiteLabel(site: {
  scope: string | null
  toothNumber: number | null
  surfaces: string[]
  quadrant: number | null
  arch: string | null
}): string {
  if (site.scope === "tooth" && site.toothNumber != null) return `Pieza ${site.toothNumber}`
  if (site.scope === "surfaces" && site.toothNumber != null) {
    const extra = site.surfaces.length > 0 ? ` (${site.surfaces.join(", ")})` : ""
    return `Pieza ${site.toothNumber}${extra}`
  }
  if (site.scope === "quadrant" && site.quadrant != null) return `Cuadrante ${site.quadrant}`
  if (site.scope === "arch" && site.arch === "upper") return "Arcada superior"
  if (site.scope === "arch" && site.arch === "lower") return "Arcada inferior"
  return "General"
}

function planStatusBadge(status: TreatmentPlanWithStatus["status"]): React.JSX.Element {
  const variant =
    status === "En curso" ? "default" : status === "Completado" ? "success" : "secondary"
  return <Badge variant={variant}>{status}</Badge>
}

export function PlanTab({
  patientId,
  disabled = false,
  beforeWrite,
  onPendingChange,
  initialPlanId,
  initialBudgetId,
}: {
  patientId: string
  disabled?: boolean
  beforeWrite?: () => Promise<void>
  onPendingChange?: (pending: boolean) => void
  /** Apertura directa desde enlace ?tab=plan&planId=:id (la ruta valida el uuid). */
  initialPlanId?: string
  /** Apertura directa desde enlace ?tab=plan&budgetId=:id (la ruta valida el uuid). */
  initialBudgetId?: string
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")
  // Presupuestos con permiso propio: el odontólogo prepara, ajusta e imprime
  // los de su plan sin caja; caja decide desde la cuenta sin clínica. Sin
  // `budgets.read` el plan muestra decisiones sin importes ni propuestas.
  const canBudgets = usePermission("budgets.read")
  const canBudgetsWrite = usePermission("budgets.write")
  const canDecide = usePermission("budgets.decide")
  // Las promociones vigentes salen del catálogo: misma regla que su ruta.
  const canCatalog = usePermission("catalog.read")
  const memberName = useMemberName()
  const profile = useOrgProfile()
  const locale = profile.data?.locale
  const timeZone = profile.data?.timezone
  const money: Money = Object.assign(
    (cents: number | null, currency: string) =>
      cents == null || !locale ? "…" : formatMoney(cents, currency, locale),
    {
      plain: (cents: number | null, currency: string) =>
        cents == null || !locale ? "…" : formatMoneyAmount(cents, currency, locale),
    },
  )
  const uid = useId()

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [selectedBudgetId, setSelectedBudgetId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [prepareOpen, setPrepareOpen] = useState(false)
  const [prepareError, setPrepareError] = useState<string | null>(null)

  const [editOpen, setEditOpen] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const [printing, setPrinting] = useState(false)
  const [cancellingBudget, setCancellingBudget] = useState<BudgetWithTotals | null>(null)

  const [reviseOpen, setReviseOpen] = useState(false)
  const [reviseIds, setReviseIds] = useState<string[]>([])
  const [reviseReason, setReviseReason] = useState("")
  const [reviseError, setReviseError] = useState<string | null>(null)

  const [groupOpen, setGroupOpen] = useState(false)
  const [groupTitle, setGroupTitle] = useState("")
  const [groupError, setGroupError] = useState<string | null>(null)
  const [alternativeError, setAlternativeError] = useState<string | null>(null)

  const plansQuery = useQuery({
    queryKey: ["treatment-plans", patientId],
    queryFn: () => fetchTreatmentPlans(patientId),
    enabled: canRead,
  })
  const budgetsQuery = useQuery({
    queryKey: ["budgets", patientId],
    queryFn: () => fetchBudgets(patientId),
    enabled: canRead && canBudgets,
  })
  const planDetailQuery = useQuery({
    queryKey: ["treatment-plan", patientId, selectedPlanId],
    queryFn: () => fetchTreatmentPlanDetail(patientId, selectedPlanId as string),
    enabled: canRead && selectedPlanId != null,
  })
  const patientQuery = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled: canRead,
  })
  const budgetDetailQuery = useQuery({
    queryKey: ["budget", patientId, selectedBudgetId],
    queryFn: () => fetchBudgetDetail(patientId, selectedBudgetId as string),
    enabled: canRead && canBudgets && selectedBudgetId != null,
  })
  const promotionsQuery = useQuery({
    queryKey: ["promotions", "vigentes"],
    queryFn: () => fetchPromotions({ scope: "vigentes" }),
    enabled: canRead && canBudgetsWrite && canCatalog,
  })
  useOrgEvents(["budget.updated", "encounter.finalized", "patient.account.updated"], () => {
    void queryClient.invalidateQueries({ queryKey: ["budgets", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["budget", patientId] })
  })
  const plans = useMemo(() => plansQuery.data?.data ?? [], [plansQuery.data])
  const budgets = useMemo(() => budgetsQuery.data?.data ?? [], [budgetsQuery.data])
  const budgetsById = useMemo(() => new Map(budgets.map((b) => [b.id, b])), [budgets])

  // Enlace directo: una sola aplicación por valor para no reabrir tras "Volver".
  const appliedInitial = useRef<{ plan?: string; budget?: string }>({})
  useEffect(() => {
    if (
      initialPlanId &&
      initialPlanId !== appliedInitial.current.plan &&
      plans.some((p) => p.plan.id === initialPlanId)
    ) {
      appliedInitial.current.plan = initialPlanId
      setSelectedPlanId(initialPlanId)
    }
  }, [initialPlanId, plans])
  useEffect(() => {
    if (initialBudgetId && initialBudgetId !== appliedInitial.current.budget) {
      const found = budgets.find((b) => b.id === initialBudgetId)
      if (found) {
        appliedInitial.current.budget = initialBudgetId
        setSelectedPlanId(found.planId)
        setSelectedBudgetId(initialBudgetId)
      }
    }
  }, [initialBudgetId, budgets])

  const planDetail = planDetailQuery.data?.data ?? null
  const optionGroups = planDetail?.optionGroups ?? []
  const planItems: PlanItem[] = useMemo(() => planDetail?.items ?? [], [planDetail])
  const planBudgets = useMemo(
    () =>
      budgets
        .filter((b) => b.planId === selectedPlanId)
        .sort((a, b) => a.budgetNumber - b.budgetNumber),
    [budgets, selectedPlanId],
  )
  const selectedBudget: BudgetWithTotals | null =
    budgetDetailQuery.data?.data ?? budgets.find((b) => b.id === selectedBudgetId) ?? null
  const contextMismatch =
    initialPlanId != null && selectedBudget != null && selectedBudget.planId !== initialPlanId
  const invalidatePlans = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["treatment-plans", patientId] }),
      queryClient.invalidateQueries({ queryKey: ["treatment-plan", patientId] }),
      queryClient.invalidateQueries({ queryKey: ["budgets", patientId] }),
      queryClient.invalidateQueries({ queryKey: ["budget", patientId] }),
      queryClient.invalidateQueries({ queryKey: ["plan-items", patientId] }),
      queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] }),
    ])

  const writeBudget = async <T,>(operation: () => Promise<T>): Promise<T> => {
    if (disabled) throw new Error("Espera a que termine el guardado de la atención.")
    onPendingChange?.(true)
    try {
      await beforeWrite?.()
      const result = await operation()
      await invalidatePlans()
      return result
    } finally {
      onPendingChange?.(false)
    }
  }

  /** Ítems elegibles para un nuevo documento: sin presupuesto vigente, con presupuesto cancelado o rechazados. */
  const eligibleItems = useMemo(
    () =>
      planItems.filter((item) => {
        if (!item.budgetId) return true
        if (item.decision === "rechazado") return true
        const budget = budgetsById.get(item.budgetId)
        return budget?.status === "cancelado"
      }),
    [planItems, budgetsById],
  )

  const createBudgetMutation = useMutation({
    mutationFn: (body: {
      planId: string
      itemIds: string[]
      title: string | null
      notes: string | null
    }) => writeBudget(() => createBudgetApi(patientId, body)),
    onSuccess: (result) => {
      setPrepareOpen(false)
      setPrepareError(null)
      setSelectedBudgetId(result.data.id)
    },
    onError: (err) => setPrepareError(mutationMessage(err)),
  })

  const updateMutation = useMutation({
    mutationFn: (body: { title?: string; notes?: string | null }) =>
      writeBudget(() => updateBudgetApi(patientId, selectedBudget!.id, body)),
    onSuccess: () => {
      setEditOpen(false)
      setEditError(null)
    },
    onError: (err) => setEditError(mutationMessage(err)),
  })

  // Precio, motivo, promoción y visitas previstas: el editor del borrador
  // muestra el error junto a lo que se estaba cambiando.
  const adjustMutation = useMutation({
    mutationFn: (lines: AdjustBudgetLineBody[]) =>
      writeBudget(() => adjustBudgetLinesApi(patientId, selectedBudget!.id, { lines })),
    onSuccess: () => setActionError(null),
  })

  // Incluir en el borrador otro tratamiento del plan (casillas de los tableros).
  const addItemsMutation = useMutation({
    mutationFn: (itemIds: string[]) =>
      writeBudget(() => addBudgetItemsApi(patientId, selectedBudget!.id, itemIds)),
    onSuccess: () => setActionError(null),
  })

  /**
   * La pestaña se abre dentro del clic (después, el navegador la bloquea) y sin
   * `noopener` en la llamada, porque con él no se obtiene la ventana a la que
   * luego se le entrega el documento; el vínculo con esta página se corta aquí.
   */
  const openPrintWindow = (): Window | null => {
    const win = window.open("", "_blank")
    if (win) win.opener = null
    return win
  }

  const openPdfBytes = (win: Window | null, bytes: ArrayBuffer) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
    if (win && !win.closed) {
      win.location.href = url
    } else {
      window.open(url, "_blank", "noopener")
    }
  }

  /**
   * Imprimir y entregar: primero se guarda lo escrito en el borrador, luego el
   * PDF real se genera ANTES de transicionar; si la generación falla no se
   * marca entregado. La ventana recibe el documento ya entregado.
   */
  const handleDeliverPrint = async (pendingLines: AdjustBudgetLineBody[] = []) => {
    if (!selectedBudget || writeBlocked || printing) return
    const budgetId = selectedBudget.id
    const win = openPrintWindow()
    setPrinting(true)
    setActionError(null)
    try {
      if (pendingLines.length > 0) {
        await writeBudget(() => adjustBudgetLinesApi(patientId, budgetId, { lines: pendingLines }))
      }
      await apiFetchBytes(budgetPdfUrl(patientId, budgetId))
      await writeBudget(() => deliverBudgetApi(patientId, budgetId))
      const bytes = await apiFetchBytes(budgetPdfUrl(patientId, budgetId))
      openPdfBytes(win, bytes)
    } catch (err) {
      if (win && !win.closed) win.close()
      // El servidor explica qué impide entregar (p. ej. una promoción que ya
      // no está vigente): su mensaje se muestra tal cual.
      setActionError(mutationMessage(err))
    } finally {
      setPrinting(false)
    }
  }

  /** Reimprimir un presupuesto ya entregado con el documento del servidor. */
  const handleReprint = async () => {
    if (!selectedBudget || writeBlocked || printing) return
    const win = openPrintWindow()
    setPrinting(true)
    setActionError(null)
    try {
      const bytes = await apiFetchBytes(budgetPdfUrl(patientId, selectedBudget.id))
      openPdfBytes(win, bytes)
    } catch (err) {
      if (win && !win.closed) win.close()
      setActionError(mutationMessage(err))
    } finally {
      setPrinting(false)
    }
  }

  const cancelMutation = useMutation({
    mutationFn: (budgetId: string) => writeBudget(() => cancelBudgetApi(patientId, budgetId)),
    onSuccess: () => {
      setCancellingBudget(null)
      setActionError(null)
    },
    onError: (err) => {
      setActionError(mutationMessage(err))
      setCancellingBudget(null)
    },
  })

  const reviseMutation = useMutation({
    mutationFn: () =>
      writeBudget(() =>
        reviseBudgetApi(patientId, selectedBudget!.id, {
          itemIds: reviseIds,
          title: selectedBudget!.title,
          notes: selectedBudget!.notes ?? null,
          reason: reviseReason.trim(),
        }),
      ),
    onSuccess: (result) => {
      setReviseOpen(false)
      setReviseReason("")
      setReviseError(null)
      setSelectedBudgetId(result.data.id)
    },
    onError: (err) => setReviseError(mutationMessage(err)),
  })

  const groupMutation = useMutation({
    mutationFn: () =>
      writeBudget(() =>
        createOptionGroupApi(patientId, selectedPlan!.plan.id, { title: groupTitle.trim() }),
      ),
    onSuccess: () => {
      setGroupOpen(false)
      setGroupTitle("")
      setGroupError(null)
      void queryClient.invalidateQueries({ queryKey: ["treatment-plan", patientId] })
    },
    onError: (err) => setGroupError(mutationMessage(err)),
  })

  const alternativeMutation = useMutation({
    mutationFn: (body: { itemId: string; optionGroupId: string | null; isRecommended: boolean }) =>
      writeBudget(() =>
        setItemAlternativeApi(patientId, body.itemId, {
          optionGroupId: body.optionGroupId,
          isRecommended: body.isRecommended,
        }),
      ),
    onSuccess: () => setAlternativeError(null),
    onError: (err) => setAlternativeError(mutationMessage(err)),
  })

  // Quitar del borrador un tratamiento ya incluido: vuelve a quedar sin presupuestar.
  const removeItemsMutation = useMutation({
    mutationFn: (itemIds: string[]) =>
      writeBudget(() => removeBudgetItemsApi(patientId, selectedBudget!.id, itemIds)),
    onSuccess: () => setActionError(null),
  })

  const busy =
    removeItemsMutation.isPending ||
    createBudgetMutation.isPending ||
    updateMutation.isPending ||
    cancelMutation.isPending ||
    adjustMutation.isPending ||
    addItemsMutation.isPending ||
    reviseMutation.isPending ||
    groupMutation.isPending ||
    alternativeMutation.isPending ||
    printing
  const writeBlocked = disabled || busy

  const openPlan = (id: string) => {
    setSelectedPlanId(id)
    setSelectedBudgetId(null)
    setActionError(null)
  }

  const openPrepare = () => {
    setPrepareError(null)
    setPrepareOpen(true)
  }

  const planColumns = useMemo<ColumnDef<TreatmentPlanWithStatus>[]>(
    () => [
      {
        accessorKey: "title",
        header: "Plan",
        accessorFn: (row) => row.plan.title,
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span className="font-medium">{row.original.plan.title}</span>
            {row.original.plan.isLegacy ? (
              <span className="text-xs text-muted-foreground">
                Heredado · procede de presupuestos previos
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                Creado el {formatDate(row.original.plan.createdAt, locale, timeZone)}
              </span>
            )}
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: "Estado",
        meta: { view: { primary: true } },
        cell: ({ row }) => planStatusBadge(row.original.status),
      },
      {
        accessorKey: "pending",
        header: "Pendientes",
        meta: { view: { primary: true } },
        accessorFn: (row) => row.pendingItems,
        cell: ({ row }) => `${row.original.pendingItems} de ${row.original.totalItems}`,
      },
    ],
    [locale, timeZone],
  )
  const planTable = useReactTable({
    data: plans,
    columns: planColumns,
    getCoreRowModel: getCoreRowModel(),
  })

  const itemColumns = useMemo<ColumnDef<PlanItem>[]>(
    () => [
      {
        accessorKey: "title",
        header: "Tratamiento",
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span className="font-medium">{row.original.title}</span>
            <span className="text-xs text-muted-foreground">
              {treatmentSiteLabel(row.original)}
            </span>
          </span>
        ),
      },
      {
        accessorKey: "priceCents",
        header: "Tarifa indicada",
        meta: { view: { primary: true } },
        cell: ({ row }) =>
          row.original.priceCents == null ? (
            <span className="text-muted-foreground">Sin tarifa</span>
          ) : (
            <span className="whitespace-nowrap tabular-nums">
              {money(row.original.priceCents, row.original.currency)}
            </span>
          ),
      },
      {
        accessorKey: "decision",
        header: "Decisión",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className="flex flex-col gap-1">
            <Badge
              variant={
                row.original.decision === "aceptado"
                  ? "success"
                  : row.original.decision === "rechazado"
                    ? "destructive"
                    : "secondary"
              }
            >
              {row.original.decision === "pendiente"
                ? "Pendiente"
                : row.original.decision === "aceptado"
                  ? "Aceptado"
                  : row.original.decision === "rechazado"
                    ? "Rechazado"
                    : "Sin registro"}
            </Badge>
            {row.original.budgetId ? (
              <span className="text-xs text-muted-foreground">
                {budgetsById.get(row.original.budgetId)
                  ? `${budgetNumberLabel(budgetsById.get(row.original.budgetId)!.budgetNumber)} · ${budgetStatusLabel(budgetsById.get(row.original.budgetId)!.status)}`
                  : "En presupuesto"}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">Sin presupuestar</span>
            )}
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: "Estado clínico",
        cell: ({ row }) => <Badge variant="outline">{row.original.status}</Badge>,
      },
    ],
    [budgetsById, locale],
  )
  const itemTable = useReactTable({
    data: planItems,
    columns: itemColumns,
    getCoreRowModel: getCoreRowModel(),
  })

  if (plansQuery.isPending || (canBudgets && budgetsQuery.isPending)) return <LoadingState />
  const loadError = plansQuery.error ?? (canBudgets ? budgetsQuery.error : null)
  if (loadError) {
    return (
      <ErrorState
        error={loadError instanceof ApiError ? loadError.shape : null}
        onRetry={() => {
          void plansQuery.refetch()
          if (canBudgets) void budgetsQuery.refetch()
        }}
      />
    )
  }

  const selectedPlan = plans.find((p) => p.plan.id === selectedPlanId) ?? null
  const canPrepare = canBudgetsWrite && eligibleItems.length > 0

  return (
    <div className="flex flex-col gap-4">
      {contextMismatch ? (
        <p role="alert" className="rounded-xl border border-destructive/50 p-3 text-sm">
          El presupuesto enlazado pertenece a otro plan: se muestra su plan real en lugar de
          seleccionar otro paciente o el primer plan.
        </p>
      ) : null}
      {actionError && !selectedBudget ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {selectedPlanId == null ? (
        plans.length === 0 ? (
          <EmptyState
            title="Sin planes de tratamiento"
            description="Los planes se crean durante una atención en curso: allí se indica cada tratamiento y luego se presupuesta. Los registros históricos migrados aparecen aquí como planes heredados."
          />
        ) : (
          <DataTable table={planTable} onRowClick={(row) => openPlan(row.plan.id)} />
        )
      ) : selectedPlan == null ? (
        <EmptyState
          title="Plan no encontrado"
          description="El plan solicitado no existe para este paciente."
          actionLabel="Volver a planes"
          onAction={() => setSelectedPlanId(null)}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setSelectedPlanId(null)
                setSelectedBudgetId(null)
              }}
            >
              Volver a planes
            </Button>
            <h3 className="text-base font-semibold">{selectedPlan.plan.title}</h3>
            {planStatusBadge(selectedPlan.status)}
            {selectedPlan.plan.isLegacy ? <Badge variant="outline">Heredado</Badge> : null}
          </div>

          {planDetailQuery.isPending ? (
            <LoadingState />
          ) : planDetailQuery.isError ? (
            <ErrorState
              error={planDetailQuery.error instanceof ApiError ? planDetailQuery.error.shape : null}
              onRetry={() => void planDetailQuery.refetch()}
            />
          ) : (
            <>
              <section aria-label="Tratamientos del plan">
                <h4 className="mb-2 text-sm font-semibold">Tratamientos</h4>
                {planItems.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    El plan aún no tiene tratamientos indicados.
                  </p>
                ) : (
                  <DataTable table={itemTable} />
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  Añadir o corregir indicaciones exige una atención en curso: se hace en el panel
                  Plan de la atención, no desde aquí.
                </p>
              </section>

              <section aria-label="Alternativas del plan">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold">Alternativas</h4>
                  {canWrite ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={writeBlocked}
                      onClick={() => {
                        setGroupTitle("")
                        setGroupError(null)
                        setGroupOpen(true)
                      }}
                    >
                      Crear agrupación
                    </Button>
                  ) : null}
                </div>
                <p className="mb-2 text-xs text-muted-foreground">
                  Un grupo reúne opciones excluyentes para el mismo problema clínico: al aceptar
                  una, las demás se rechazan como «Alternativa no elegida». Marcar la recomendada
                  orienta la decisión sin aceptarla.
                </p>
                {optionGroups.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Este plan aún no tiene agrupaciones de alternativas.
                  </p>
                ) : (
                  <ul className="mb-3 flex flex-col gap-1">
                    {optionGroups.map((group) => {
                      const members = planItems.filter((item) => item.optionGroupId === group.id)
                      return (
                        <li key={group.id} className="rounded-md border p-2 text-sm">
                          <span className="font-medium">{group.title}</span>{" "}
                          <span className="text-muted-foreground">
                            {members.length === 0
                              ? "· sin alternativas asignadas"
                              : `· ${members.map((m) => m.title).join(" · ")}`}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
                {planItems.filter((item) => !["cancelado", "reemplazado"].includes(item.status))
                  .length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Sin indicaciones activas que agrupar.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {planItems
                      .filter((item) => !["cancelado", "reemplazado"].includes(item.status))
                      .map((item) => (
                        <li key={item.id} className="flex flex-col gap-2 rounded-md border p-3">
                          <span className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="font-medium">{item.title}</span>
                            <span className="text-muted-foreground">
                              {treatmentSiteLabel(item)}
                            </span>
                            {item.isRecommended ? (
                              <Badge variant="secondary">Recomendada</Badge>
                            ) : null}
                          </span>
                          {canWrite ? (
                            <div className="flex flex-wrap items-center gap-3">
                              <label className="flex items-center gap-2 text-sm">
                                Alternativa de
                                <ChoiceSelect
                                  aria-label={`Alternativa de ${item.title}`}
                                  disabled={writeBlocked}
                                  value={item.optionGroupId ?? ""}
                                  onChange={(event) =>
                                    alternativeMutation.mutate({
                                      itemId: item.id,
                                      optionGroupId: event.target.value || null,
                                      isRecommended: false,
                                    })
                                  }
                                >
                                  <option value="">Sin grupo</option>
                                  {optionGroups.map((group) => (
                                    <option key={group.id} value={group.id}>
                                      {group.title}
                                    </option>
                                  ))}
                                </ChoiceSelect>
                              </label>
                              <label className="flex items-center gap-2 text-sm">
                                <Checkbox
                                  checked={item.isRecommended}
                                  disabled={writeBlocked || item.optionGroupId == null}
                                  onCheckedChange={(next) =>
                                    alternativeMutation.mutate({
                                      itemId: item.id,
                                      optionGroupId: item.optionGroupId,
                                      isRecommended: next === true,
                                    })
                                  }
                                />
                                Recomendada
                              </label>
                            </div>
                          ) : null}
                        </li>
                      ))}
                  </ul>
                )}
                {alternativeError ? (
                  <p role="alert" className="mt-2 text-sm text-destructive">
                    {alternativeError}
                  </p>
                ) : null}
              </section>

              <section aria-label="Presupuestos del plan">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold">Presupuestos</h4>
                  {canPrepare && planBudgets.length > 0 ? (
                    <Button type="button" size="sm" disabled={writeBlocked} onClick={openPrepare}>
                      Preparar presupuesto
                    </Button>
                  ) : null}
                </div>
                {!canBudgets ? (
                  <p className="text-sm text-muted-foreground">
                    Los presupuestos los prepara el odontólogo de este plan: tu permiso no incluye
                    importes ni propuestas. La decisión de cada tratamiento se ve en la tabla de
                    arriba.
                  </p>
                ) : planBudgets.length === 0 ? (
                  <EmptyState
                    title="Este plan aún no tiene presupuestos"
                    description={
                      !canBudgetsWrite
                        ? "Los prepara el odontólogo del plan o la administración de la clínica."
                        : eligibleItems.length > 0
                          ? "Prepara uno con los tratamientos del plan. Nace como borrador: ajustas precios y lo entregas cuando esté listo."
                          : "Para presupuestar hace falta al menos un tratamiento indicado en una atención en curso."
                    }
                    actionLabel={canPrepare ? "Preparar presupuesto" : undefined}
                    onAction={canPrepare && !writeBlocked ? openPrepare : undefined}
                  />
                ) : (
                  <ul className="flex flex-col gap-2">
                    {planBudgets.map((b) => (
                      <li key={b.id}>
                        <Button
                          type="button"
                          variant={selectedBudgetId === b.id ? "default" : "outline"}
                          aria-pressed={selectedBudgetId === b.id}
                          className="h-auto w-full justify-start py-2"
                          onClick={() => {
                            setActionError(null)
                            setSelectedBudgetId(b.id)
                          }}
                        >
                          <span className="flex min-w-0 flex-col items-start text-left">
                            <span className="font-medium">
                              {budgetNumberLabel(b.budgetNumber)} · {b.title}
                            </span>
                            <span className="text-xs whitespace-normal opacity-80">
                              {budgetStatusLabel(b.status)} · {b.items.length} tratamiento
                              {b.items.length === 1 ? "" : "s"}
                              {b.totalCents != null
                                ? ` · ${money(b.totalCents, b.currency)}`
                                : " · falta la tarifa de algún tratamiento"}
                            </span>
                          </span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {selectedBudget ? (
                <BudgetDetail
                  key={selectedBudget.id}
                  budget={selectedBudget}
                  patientId={patientId}
                  patientName={patientQuery.data?.data.patient.displayName ?? null}
                  planTitle={selectedPlan.plan.title}
                  preparedBy={selectedBudget.createdBy ? memberName(selectedBudget.createdBy) : null}
                  canWrite={canBudgetsWrite}
                  canDecide={canDecide}
                  writeBlocked={writeBlocked}
                  money={money}
                  locale={locale}
                  localePending={profile.isPending}
                  onRetryLocale={() => void profile.refetch()}
                  formatDay={(iso) =>
                    new Date(iso).toLocaleDateString(locale, {
                      day: "numeric",
                      month: "long",
                      timeZone,
                    })
                  }
                  promotions={promotionsQuery.data?.data ?? []}
                  promotionsFailed={promotionsQuery.isError}
                  onRetryPromotions={() => void promotionsQuery.refetch()}
                  actionError={actionError}
                  saveLines={(lines) => adjustMutation.mutateAsync(lines)}
                  addable={selectedBudget.supersedesBudgetId ? [] : eligibleItems}
                  addItems={(itemIds) => addItemsMutation.mutateAsync(itemIds)}
                  removeItems={(itemIds) => removeItemsMutation.mutateAsync(itemIds)}
                  runWrite={writeBudget}
                  onEdit={() => {
                    setEditError(null)
                    setEditOpen(true)
                  }}
                  onDeliver={(pendingLines) => void handleDeliverPrint(pendingLines)}
                  onPrint={() => void handleReprint()}
                  onSent={() => {
                    void queryClient.invalidateQueries({ queryKey: ["budgets", patientId] })
                    void queryClient.invalidateQueries({ queryKey: ["budget", patientId] })
                  }}
                  onCancel={() => setCancellingBudget(selectedBudget)}
                  onRevise={() => {
                    setReviseIds(selectedBudget.items.map((line) => line.planItemId))
                    setReviseReason("")
                    setReviseError(null)
                    setReviseOpen(true)
                  }}
                  delivering={printing}
                  revisionAvailable={["presentado", "aceptado", "parcial", "pospuesto"].includes(
                    selectedBudget.status,
                  )}
                />
              ) : null}
            </>
          )}
        </div>
      )}

      {prepareOpen && selectedPlan ? (
        <PrepareBudgetDrawer
          planTitle={selectedPlan.plan.title}
          eligible={eligibleItems}
          budgetsById={budgetsById}
          money={money}
          error={prepareError}
          pending={createBudgetMutation.isPending}
          onClose={() => {
            if (!createBudgetMutation.isPending) setPrepareOpen(false)
          }}
          onSubmit={(itemIds, title, notes) =>
            createBudgetMutation.mutate({ planId: selectedPlan.plan.id, itemIds, title, notes })
          }
        />
      ) : null}

      {editOpen && selectedBudget ? (
        <EditBudgetDrawer
          initialTitle={selectedBudget.title}
          initialNotes={selectedBudget.notes ?? ""}
          error={editError}
          pending={updateMutation.isPending}
          onClose={() => {
            if (!updateMutation.isPending) setEditOpen(false)
          }}
          onSubmit={(title, notes) => updateMutation.mutate({ title, notes })}
        />
      ) : null}

      {groupOpen && selectedPlan ? (
        <FormDrawer
          open={groupOpen}
          title="Crear agrupación de alternativas"
          description="Agrupa indicaciones excluyentes del mismo problema clínico; después asigna cada alternativa a este grupo."
          error={groupError}
          isSubmitting={groupMutation.isPending}
          submitLabel="Crear agrupación"
          onClose={() => {
            if (!groupMutation.isPending) setGroupOpen(false)
          }}
          onSubmit={(event) => {
            event.preventDefault()
            if (!groupTitle.trim()) {
              setGroupError("Indica un título para la agrupación.")
              return
            }
            groupMutation.mutate()
          }}
        >
          <Field>
            <FieldLabel htmlFor={`${uid}-group-title`}>Título de la agrupación</FieldLabel>
            <Input
              id={`${uid}-group-title`}
              value={groupTitle}
              maxLength={200}
              onChange={(event) => setGroupTitle(event.target.value)}
            />
          </Field>
        </FormDrawer>
      ) : null}

      <ConfirmDialog
        open={cancellingBudget != null}
        title="Cancelar presupuesto"
        description="El documento se marca cancelado y conserva sus líneas. Los tratamientos que aún lo apunten quedan disponibles para un nuevo presupuesto."
        confirmLabel="Cancelar presupuesto"
        variant="destructive"
        onConfirm={() => {
          if (cancellingBudget) cancelMutation.mutate(cancellingBudget.id)
        }}
        pending={cancelMutation.isPending}
        onClose={() => {
          if (!cancelMutation.isPending) setCancellingBudget(null)
        }}
      />

      <FormDrawer
        open={reviseOpen}
        title="Crear revisión de la propuesta"
        description="La revisión conserva el número del presupuesto y lo versiona: el documento anterior queda sustituido. No puede retirarse una línea ya ejecutada, con cargo o con pago aplicado."
        error={reviseOpen ? reviseError : null}
        isSubmitting={reviseMutation.isPending}
        submitLabel="Crear revisión"
        onClose={() => {
          if (!reviseMutation.isPending) setReviseOpen(false)
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (reviseIds.length === 0) {
            setReviseError("Elige al menos un tratamiento para la revisión.")
            return
          }
          if (!reviseReason.trim()) {
            setReviseError("Indica el motivo de la revisión.")
            return
          }
          reviseMutation.mutate()
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Tratamientos de la revisión</legend>
          {planItems
            .filter((item) => !["cancelado", "reemplazado"].includes(item.status))
            .map((item) => (
              <label key={item.id} className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={reviseIds.includes(item.id)}
                  aria-label={item.title}
                  onCheckedChange={() =>
                    setReviseIds((current) =>
                      current.includes(item.id)
                        ? current.filter((id) => id !== item.id)
                        : [...current, item.id],
                    )
                  }
                />
                <span>
                  {item.title}
                  {item.toothNumber != null ? ` · Pieza ${item.toothNumber}` : ""}
                </span>
              </label>
            ))}
        </fieldset>
        <Field>
          <FieldLabel htmlFor={`${uid}-revise-reason`}>Motivo de la revisión</FieldLabel>
          <Textarea
            id={`${uid}-revise-reason`}
            maxLength={2000}
            value={reviseReason}
            onChange={(event) => setReviseReason(event.target.value)}
          />
        </Field>
      </FormDrawer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Presupuesto: líneas, totales, borrador y respuesta del paciente.
// Los importes llegan calculados del servidor (`lineTotalCents`, `totalCents`,
// `discountCents`, `acceptedCents`): aquí se muestran, no se recalculan.
// ---------------------------------------------------------------------------

const AMOUNT_PENDING = "Falta la tarifa de algún tratamiento"

type BadgeTone = "secondary" | "warning" | "success" | "destructive" | "outline"

function budgetStatusTone(status: string): BadgeTone {
  switch (status) {
    case "borrador":
      return "secondary"
    case "presentado":
    case "pospuesto":
      return "warning"
    case "aceptado":
    case "parcial":
      return "success"
    case "rechazado":
      return "destructive"
    default:
      return "outline"
  }
}

function answerTone(decision: string): BadgeTone {
  if (decision === "aceptado") return "success"
  if (decision === "rechazado") return "destructive"
  if (decision === "pospuesto") return "warning"
  return "secondary"
}

function isSessionLine(line: BudgetLine): boolean {
  return line.billingMode === "session"
}

/** Con precio fijo de promoción el importe no se negocia (lo rechaza el servidor). */
function hasFixedPromotion(line: BudgetLine): boolean {
  return line.promotionId != null && line.promotionMode === "fixed"
}

/** El precio guardado quedó por debajo de la tarifa de referencia. */
function isBelowTariff(line: BudgetLine): boolean {
  return (
    line.priceCents != null && line.tariffPriceCents != null && line.priceCents < line.tariffPriceCents
  )
}

/** «a», «a y b», «a, b y c». */
function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("")
  return `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`
}

/** Cómo se cobra la línea: una vez o en cada visita. */
function billingNote(line: BudgetLine, money: Money, withVisits: boolean): string {
  if (!isSessionLine(line)) return "Se cobra una vez"
  const each =
    line.priceCents == null
      ? "Se cobra por sesión, en cada visita"
      : `Se cobra por sesión: ${money.plain(line.priceCents, line.currency)} en cada visita`
  if (!withVisits || line.sessionsPlanned == null) return each
  return `${each} · ${line.sessionsPlanned} ${line.sessionsPlanned === 1 ? "visita prevista" : "visitas previstas"}`
}

/** Aclaración bajo el total cuando algo se cobra por sesión: el total no es deuda. */
function sessionExplanation(lines: BudgetLine[], money: Money): string | null {
  const perVisit = lines.filter(isSessionLine)
  if (perVisit.length === 0) return null
  const parts = perVisit.map((line) =>
    line.priceCents == null
      ? `cada visita de «${line.title}»`
      : `${money.plain(line.priceCents, line.currency)} en cada visita de «${line.title}»`,
  )
  const once = lines.length > perVisit.length ? "lo que se cobra una vez cuando se atiende, y " : ""
  return `El paciente ve el total, pero no lo debe todo desde el primer día: paga ${once}${joinList(parts)}.`
}

function BudgetTotals({
  budget,
  money,
  className,
}: {
  budget: BudgetWithTotals
  money: Money
  className?: string
}): React.JSX.Element {
  const hasSessions = budget.items.some(isSessionLine)
  return (
    <dl className={cn("flex flex-col gap-1.5 rounded-xl bg-muted/50 p-4 text-sm", className)}>
      <div className="flex gap-3">
        <dt className="flex-1 text-muted-foreground">Según tarifa</dt>
        <dd className="text-right tabular-nums">
          {budget.tariffTotalCents == null
            ? AMOUNT_PENDING
            : money.plain(budget.tariffTotalCents, budget.currency)}
        </dd>
      </div>
      {budget.discountCents != null && budget.discountCents > 0 ? (
        <div className="flex gap-3">
          <dt className="flex-1 text-muted-foreground">Descuento</dt>
          <dd className="text-right tabular-nums">
            −&nbsp;{money.plain(budget.discountCents, budget.currency)}
          </dd>
        </div>
      ) : null}
      <div className="flex items-baseline gap-3 border-t pt-2">
        <dt className="flex-1 font-semibold">{hasSessions ? "Total del tratamiento" : "Total"}</dt>
        <dd className="text-right text-xl font-semibold tabular-nums">
          {budget.totalCents == null ? AMOUNT_PENDING : money(budget.totalCents, budget.currency)}
        </dd>
      </div>
    </dl>
  )
}

function BudgetDetail({
  budget,
  patientId,
  patientName,
  planTitle,
  preparedBy,
  canWrite,
  canDecide,
  writeBlocked,
  money,
  locale,
  localePending,
  onRetryLocale,
  formatDay,
  promotions,
  promotionsFailed,
  onRetryPromotions,
  actionError,
  saveLines,
  addable,
  addItems,
  removeItems,
  runWrite,
  onEdit,
  onDeliver,
  onPrint,
  onSent,
  onCancel,
  onRevise,
  delivering,
  revisionAvailable,
}: {
  budget: BudgetWithTotals
  patientId: string
  patientName: string | null
  planTitle: string
  preparedBy: string | null
  canWrite: boolean
  canDecide: boolean
  writeBlocked: boolean
  money: Money
  locale: string | undefined
  localePending: boolean
  onRetryLocale: () => void
  formatDay: (iso: string) => string
  promotions: Promotion[]
  promotionsFailed: boolean
  onRetryPromotions: () => void
  actionError: string | null
  saveLines: (lines: AdjustBudgetLineBody[]) => Promise<unknown>
  /** Tratamientos del plan que aún pueden entrar en este borrador. */
  addable: PlanItem[]
  addItems: (itemIds: string[]) => Promise<unknown>
  removeItems: (itemIds: string[]) => Promise<unknown>
  runWrite: <T,>(operation: () => Promise<T>) => Promise<T>
  onEdit: () => void
  /** Entrega el presupuesto; antes guarda lo que el borrador tenía sin guardar. */
  onDeliver: (pendingLines: AdjustBudgetLineBody[]) => void
  onPrint: () => void
  onSent: () => void
  onCancel: () => void
  onRevise: () => void
  delivering: boolean
  /** Revisión vigente o decisiones ya tomadas: la revisión se ofrece después de entregar. */
  revisionAvailable: boolean
}): React.JSX.Element {
  const isDraft = budget.status === "borrador"
  const canCancel = isDraft || budget.status === "presentado"
  // La respuesta se anota (o se lee) en lo entregado; un presupuesto cancelado
  // o reemplazado sin respuesta no tiene nada que mostrar ahí.
  const showResponse =
    BUDGET_ANSWERABLE_STATUSES.includes(budget.status) || (!isDraft && budget.decidedAt != null)
  const context = [
    patientName,
    `plan «${planTitle}»`,
    budget.title !== planTitle ? budget.title : null,
    preparedBy ? `preparado por ${preparedBy}` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  // Acciones que no son la principal: van después de entregar o guardar.
  const secondaryActions = (
    <>
      {canWrite && isDraft ? (
        <Button type="button" size="sm" variant="outline" disabled={writeBlocked} onClick={onEdit}>
          Título y notas
        </Button>
      ) : null}
      {canWrite && !isDraft ? (
        <SubmitButton
          size="sm"
          variant="outline"
          pending={delivering}
          disabled={writeBlocked}
          onClick={onPrint}
        >
          Imprimir
        </SubmitButton>
      ) : null}
      {canWrite ? (
        <SendFinancialDocument
          patientId={patientId}
          documentType="budget"
          documentId={budget.id}
          onSent={onSent}
        />
      ) : null}
      {canWrite && revisionAvailable ? (
        <Button type="button" size="sm" variant="outline" disabled={writeBlocked} onClick={onRevise}>
          Crear revisión
        </Button>
      ) : null}
      {canWrite && canCancel ? (
        <Button type="button" size="sm" variant="outline" disabled={writeBlocked} onClick={onCancel}>
          Cancelar presupuesto
        </Button>
      ) : null}
    </>
  )

  const errorAlert = actionError ? (
    <p role="alert" className="text-sm text-destructive">
      {actionError}
    </p>
  ) : null

  return (
    <div className="flex flex-wrap items-start gap-4">
      <section
        aria-label="Detalle del presupuesto"
        className="flex min-w-0 flex-[1_1_28rem] flex-col gap-4 rounded-xl border bg-card p-4"
      >
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-base font-semibold">{budgetNumberLabel(budget.budgetNumber)}</h4>
            <Badge variant={budgetStatusTone(budget.status)}>
              {budgetStatusLabel(budget.status)}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{context}</p>
        </div>
        {budget.notes ? <p className="text-sm">{budget.notes}</p> : null}

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
        ) : isDraft && canWrite ? (
          <BudgetDraftEditor
            budget={budget}
            promotions={promotions}
            promotionsFailed={promotionsFailed}
            onRetryPromotions={onRetryPromotions}
            locale={locale}
            money={money}
            disabled={writeBlocked}
            delivering={delivering}
            saveLines={saveLines}
            addable={addable}
            addItems={addItems}
            removeItems={removeItems}
            onDeliver={onDeliver}
            actionAlert={errorAlert}
            secondaryActions={secondaryActions}
          />
        ) : (
          <>
            <BudgetLinesList budget={budget} money={money} showAnswers={!isDraft} />
            <BudgetTotals budget={budget} money={money} className="sm:max-w-sm sm:self-end" />
            <SessionNote budget={budget} money={money} />
            {errorAlert}
            <div className="flex flex-wrap gap-2 border-t pt-4">{secondaryActions}</div>
          </>
        )}
        {isDraft ? (
          <p className="text-xs text-muted-foreground">
            Al entregarlo, aquí mismo se anota qué respondió el paciente.
          </p>
        ) : null}
      </section>

      {showResponse ? (
        <BudgetResponse
          patientId={patientId}
          budget={budget}
          canDecide={canDecide}
          disabled={writeBlocked}
          money={money}
          formatDay={formatDay}
          runWrite={runWrite}
          className="flex-[1_1_20rem] xl:max-w-sm"
        />
      ) : null}
    </div>
  )
}

function SessionNote({
  budget,
  money,
}: {
  budget: BudgetWithTotals
  money: Money
}): React.JSX.Element | null {
  const text = sessionExplanation(budget.items, money)
  return text ? <p className="text-sm text-muted-foreground">{text}</p> : null
}

/** Líneas del presupuesto ya entregado (o de un borrador que no se puede editar). */
function BudgetLinesList({
  budget,
  money,
  showAnswers,
}: {
  budget: BudgetWithTotals
  money: Money
  showAnswers: boolean
}): React.JSX.Element {
  return (
    <ul aria-label="Tratamientos del presupuesto" className="flex flex-col divide-y rounded-xl border">
      {budget.items.map((line) => (
        <li key={line.id} className="flex flex-col gap-2 px-3 py-3">
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">{line.title}</span>
              <span className="text-xs text-muted-foreground">
                {treatmentSiteLabel(line)} · {billingNote(line, money, true)}
              </span>
              {line.promotionName ? (
                <span className="text-xs text-muted-foreground">
                  Promoción: {line.promotionName}
                </span>
              ) : null}
              {line.priceReason ? (
                <span className="text-xs text-muted-foreground">
                  Motivo del ajuste: {line.priceReason}
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-end">
              <span className="font-semibold whitespace-nowrap tabular-nums">
                {line.lineTotalCents == null
                  ? "Sin tarifa"
                  : money.plain(line.lineTotalCents, line.currency)}
              </span>
              {isBelowTariff(line) && line.tariffLineTotalCents != null ? (
                <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  <span className="sr-only">Tarifa: </span>
                  <span className="line-through">
                    {money.plain(line.tariffLineTotalCents, line.currency)}
                  </span>
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {showAnswers ? (
              <Badge variant={answerTone(line.decision)}>{budgetAnswerLabel(line.decision)}</Badge>
            ) : null}
            <Badge variant="outline">{glossaryLabel("tratamiento", line.itemStatus)}</Badge>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Lo escrito en una línea del borrador y aún sin guardar. */
interface LineEdit {
  price?: string
  sessions?: string
}

/**
 * Precio de referencia de una línea: su tarifa o, con promoción «desde», el
 * mínimo anunciado. `undefined` cuando esa promoción ya no está entre las
 * vigentes: entonces solo el servidor sabe si hace falta motivo.
 */
function lineReference(line: BudgetLine, promotions: Promotion[]): number | null | undefined {
  if (line.promotionId != null && line.promotionMode === "from") {
    const item = promotions
      .find((promo) => promo.id === line.promotionId)
      ?.items.find((entry) => entry.serviceId === line.serviceId)
    return item ? item.priceCents : undefined
  }
  return line.tariffPriceCents
}

/**
 * Borrador del presupuesto (tableros 6, 13b y 22): precio acordado por línea,
 * visitas previstas de lo que se cobra por sesión, promociones ofrecidas y un
 * motivo común para lo que baja de su referencia. Lo escrito se conserva hasta
 * guardar; aplicar o quitar una promoción se guarda en el momento.
 */
function BudgetDraftEditor({
  budget,
  promotions,
  promotionsFailed,
  onRetryPromotions,
  locale,
  money,
  disabled,
  delivering,
  saveLines,
  addable,
  addItems,
  removeItems,
  onDeliver,
  actionAlert,
  secondaryActions,
}: {
  budget: BudgetWithTotals
  promotions: Promotion[]
  promotionsFailed: boolean
  onRetryPromotions: () => void
  locale: string
  money: Money
  disabled: boolean
  delivering: boolean
  saveLines: (lines: AdjustBudgetLineBody[]) => Promise<unknown>
  addable: PlanItem[]
  addItems: (itemIds: string[]) => Promise<unknown>
  removeItems: (itemIds: string[]) => Promise<unknown>
  onDeliver: (pendingLines: AdjustBudgetLineBody[]) => void
  actionAlert: ReactNode
  secondaryActions: ReactNode
}): React.JSX.Element {
  const uid = useId()
  const [edits, setEdits] = useState<Record<string, LineEdit>>({})
  /** `null`: el motivo no se ha tocado y vale el que ya tienen las líneas. */
  const [reason, setReason] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  const [discountOpen, setDiscountOpen] = useState(false)
  const [discountPercent, setDiscountPercent] = useState("")
  const [discountReason, setDiscountReason] = useState("")
  const [discountError, setDiscountError] = useState<string | null>(null)

  const savedReason = budget.items.find((line) => line.priceReason)?.priceReason ?? ""
  const reasonText = reason ?? savedReason
  const reasonTouched = reason !== null

  const inputValue = (cents: number | null, currency: string): string => {
    if (cents == null) return ""
    try {
      return formatMoneyInput(cents, currency, locale)
    } catch {
      return ""
    }
  }
  const setEdit = (planItemId: string, patch: LineEdit) =>
    setEdits((current) => ({ ...current, [planItemId]: { ...current[planItemId], ...patch } }))
  /** Tras cambiar el precio en el servidor, lo escrito para ese precio ya no vale. */
  const dropPriceEdits = (planItemIds: string[]) =>
    setEdits((current) => {
      const next = { ...current }
      for (const id of planItemIds) {
        if (next[id]) next[id] = { sessions: next[id].sessions }
      }
      return next
    })

  /** Lo que cambió frente a lo guardado, o el motivo por el que aún no se puede guardar. */
  const buildPatch = (): { lines: AdjustBudgetLineBody[] } | { error: string } => {
    const reasonValue = reasonText.trim()
    const lines: AdjustBudgetLineBody[] = []
    for (const line of budget.items) {
      const edit = edits[line.planItemId] ?? {}
      const body: AdjustBudgetLineBody = { planItemId: line.planItemId }
      let changed = false
      let price = line.priceCents

      if (edit.price !== undefined && !hasFixedPromotion(line)) {
        const text = edit.price.trim()
        if (text === "") {
          if (line.priceCents != null) {
            return { error: `Escribe el precio acordado de «${line.title}».` }
          }
        } else {
          let parsed: number
          try {
            parsed = parseMoney(text, line.currency, locale)
          } catch (err) {
            const detail = err instanceof Error ? err.message : "Importe inválido"
            return { error: `«${line.title}»: ${detail}.` }
          }
          if (parsed !== line.priceCents) {
            body.priceCents = parsed
            changed = true
          }
          price = parsed
        }
      }

      if (edit.sessions !== undefined && isSessionLine(line)) {
        const text = edit.sessions.trim()
        const visits = /^\d{1,3}$/.test(text) ? Number(text) : Number.NaN
        if (!Number.isInteger(visits) || visits < 1 || visits > 200) {
          return { error: `Las visitas previstas de «${line.title}» van de 1 a 200.` }
        }
        if (visits !== line.sessionsPlanned) {
          body.sessionsPlanned = visits
          changed = true
        }
      }

      // Motivo: solo cuando el precio baja de su referencia, y solo si aquí se
      // tocó el precio o el motivo. La regla la aplica el servidor; esto evita
      // enviar un borrador al que le va a faltar.
      const priceChanged = body.priceCents !== undefined
      if (!hasFixedPromotion(line) && (priceChanged || reasonTouched)) {
        const reference = lineReference(line, promotions)
        if (reference === undefined) {
          if (priceChanged && reasonValue && reasonValue !== (line.priceReason ?? "")) {
            body.reason = reasonValue
          }
        } else if (reference != null && price != null && price < reference) {
          const wanted = reasonTouched ? reasonValue : (line.priceReason ?? reasonValue)
          if (!wanted) {
            const floor = line.promotionId ? "el mínimo de la promoción" : "la tarifa"
            return {
              error: `Escribe el motivo del ajuste: «${line.title}» queda por debajo de ${floor}.`,
            }
          }
          if (wanted !== (line.priceReason ?? "")) {
            body.reason = wanted
            changed = true
          }
        } else if (priceChanged && line.priceReason) {
          // Volvió a su referencia: el motivo anterior ya no describe nada.
          body.reason = null
        }
      }

      if (changed) lines.push(body)
    }
    return { lines }
  }

  const patch = buildPatch()
  const dirty = "error" in patch || patch.lines.length > 0
  const blocked = disabled || pending != null
  // En una revisión los tratamientos se eligen al crearla (misma regla del servidor).
  const canChangeItems = !budget.supersedesBudgetId

  const handleSave = async () => {
    if ("error" in patch) {
      setError(patch.error)
      return
    }
    if (patch.lines.length === 0) return
    setError(null)
    setPending("save")
    try {
      await saveLines(patch.lines)
      setEdits({})
      setReason(null)
    } catch (err) {
      setError(mutationMessage(err))
    } finally {
      setPending(null)
    }
  }

  const handleDeliver = () => {
    if ("error" in patch) {
      setError(patch.error)
      return
    }
    setError(null)
    onDeliver(patch.lines)
  }

  /** Aplicar o quitar una promoción: se guarda en el momento, línea por línea. */
  const runPromotion = async (key: string, body: AdjustBudgetLineBody) => {
    setError(null)
    setPending(key)
    try {
      await saveLines([body])
      dropPriceEdits([body.planItemId])
    } catch (err) {
      setError(mutationMessage(err))
    } finally {
      setPending(null)
    }
  }

  const submitDiscount = async () => {
    const text = discountPercent.trim()
    const percent = /^\d{1,3}$/.test(text) ? Number(text) : Number.NaN
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
      setDiscountError("Escribe un porcentaje del 1 al 100.")
      return
    }
    const motive = discountReason.trim()
    if (!motive) {
      setDiscountError("Escribe el motivo del descuento.")
      return
    }
    // El porcentaje se reparte aquí, sobre la tarifa de cada línea y en enteros
    // de la unidad menor de la moneda; el servidor guarda ese precio con el
    // motivo común y devuelve los totales.
    const lines: AdjustBudgetLineBody[] = budget.items.flatMap((line) => {
      const base = line.tariffPriceCents ?? line.priceCents
      if (line.promotionId != null || base == null) return []
      return [
        {
          planItemId: line.planItemId,
          priceCents: Math.round((base * (100 - percent)) / 100),
          reason: motive,
        },
      ]
    })
    if (lines.length === 0) {
      setDiscountError(
        "Ningún tratamiento admite el descuento: todos tienen una promoción o les falta la tarifa.",
      )
      return
    }
    setDiscountError(null)
    setPending("discount")
    try {
      await saveLines(lines)
      dropPriceEdits(lines.map((line) => line.planItemId))
      setReason(null)
      setDiscountOpen(false)
    } catch (err) {
      setDiscountError(mutationMessage(err))
    } finally {
      setPending(null)
    }
  }

  const note = sessionExplanation(budget.items, money)

  return (
    <>
      <div className="flex flex-col rounded-xl border">
        <div
          aria-hidden="true"
          className="hidden items-center gap-3 rounded-t-xl bg-muted/50 px-3 py-2 text-xs font-semibold text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1fr)_6rem_8rem]"
        >
          <span>Tratamiento</span>
          <span className="text-right">Tarifa</span>
          <span className="text-right">Precio acordado</span>
        </div>
        <ul aria-label="Tratamientos del presupuesto" className="flex flex-col divide-y">
          {budget.items.map((line) => {
            const edit = edits[line.planItemId] ?? {}
            const fixed = hasFixedPromotion(line)
            const session = isSessionLine(line)
            const below = isBelowTariff(line)
            const reference = lineReference(line, promotions)
            const offers =
              line.promotionId != null || line.serviceId == null
                ? []
                : promotions.flatMap((promo) => {
                    const item = promo.items.find(
                      (entry) =>
                        entry.serviceId === line.serviceId && entry.currency === line.currency,
                    )
                    return item ? [{ promo, item }] : []
                  })
            const priceLabel = session
              ? `Precio por visita de ${line.title}`
              : `Precio acordado de ${line.title}`
            return (
              <li key={line.id} className="flex flex-col gap-2 px-3 py-3">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_6rem_8rem]">
                  <div className="flex min-w-0 items-start gap-3">
                    {/* Casilla de los tableros: desmarcarla quita el tratamiento del borrador. */}
                    {canChangeItems ? (
                      <Checkbox
                        checked
                        className="mt-0.5"
                        disabled={blocked}
                        aria-label={`Incluir ${line.title}`}
                        onCheckedChange={(next) => {
                          if (next === true) return
                          setError(null)
                          setPending(`drop:${line.planItemId}`)
                          removeItems([line.planItemId])
                            .then(() =>
                              setEdits((current) => {
                                const { [line.planItemId]: _gone, ...rest } = current
                                return rest
                              }),
                            )
                            .catch((err: unknown) => setError(mutationMessage(err)))
                            .finally(() => setPending(null))
                        }}
                      />
                    ) : null}
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium">{line.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {treatmentSiteLabel(line)} · {billingNote(line, money, false)}
                    </span>
                    {/* En pantallas estrechas no hay columna «Tarifa»: va aquí. */}
                    {!below && line.tariffPriceCents != null ? (
                      <span className="text-xs text-muted-foreground sm:hidden">
                        Tarifa {money.plain(line.tariffPriceCents, line.currency)}
                      </span>
                    ) : null}
                    {below ? (
                      <span className="text-xs font-medium text-primary">
                        {line.lineDiscountCents != null
                          ? `${money.plain(line.lineDiscountCents, line.currency)} menos que la tarifa`
                          : `Menos que la tarifa de ${money.plain(line.tariffPriceCents, line.currency)}`}
                      </span>
                    ) : null}
                    {line.priceCents == null ? (
                      <span className="text-xs text-muted-foreground">
                        Sin tarifa: escribe el precio acordado.
                      </span>
                    ) : null}
                  </div>
                  </div>
                  <span className="hidden text-right text-sm text-muted-foreground tabular-nums sm:block">
                    <span className="sr-only">Tarifa: </span>
                    <span className={cn(below && "line-through")}>
                      {line.tariffPriceCents == null
                        ? "sin tarifa"
                        : money.plain(line.tariffPriceCents, line.currency)}
                    </span>
                  </span>
                  {fixed ? (
                    <span className="justify-self-end text-right font-semibold tabular-nums">
                      {money.plain(line.priceCents, line.currency)}
                    </span>
                  ) : (
                    <Input
                      aria-label={priceLabel}
                      inputMode="decimal"
                      autoComplete="off"
                      className="w-28 justify-self-end text-right font-semibold tabular-nums"
                      disabled={blocked}
                      value={edit.price ?? inputValue(line.priceCents, line.currency)}
                      onChange={(event) =>
                        setEdit(line.planItemId, { price: event.currentTarget.value })
                      }
                    />
                  )}
                </div>

                {session ? (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <label
                      htmlFor={`${uid}-visits-${line.id}`}
                      className="text-sm text-muted-foreground"
                    >
                      Visitas previstas
                    </label>
                    <Input
                      id={`${uid}-visits-${line.id}`}
                      inputMode="numeric"
                      autoComplete="off"
                      className="w-16 text-center font-semibold tabular-nums"
                      disabled={blocked}
                      value={
                        edit.sessions ??
                        (line.sessionsPlanned == null ? "" : String(line.sessionsPlanned))
                      }
                      onChange={(event) =>
                        setEdit(line.planItemId, { sessions: event.currentTarget.value })
                      }
                    />
                    <span className="ml-auto text-sm">
                      <span className="text-muted-foreground">Total de la línea </span>
                      <span className="font-semibold tabular-nums">
                        {line.lineTotalCents == null
                          ? "sin tarifa"
                          : money.plain(line.lineTotalCents, line.currency)}
                      </span>
                    </span>
                  </div>
                ) : null}

                {line.promotionId != null ? (
                  <div className="flex flex-col gap-1 rounded-lg bg-muted/50 px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1">
                        Promoción: {line.promotionName ?? "sin nombre"}
                      </span>
                      <SubmitButton
                        size="sm"
                        variant="outline"
                        pending={pending === `remove:${line.planItemId}`}
                        disabled={blocked}
                        onClick={() =>
                          void runPromotion(`remove:${line.planItemId}`, {
                            planItemId: line.planItemId,
                            promotionId: null,
                          })
                        }
                      >
                        Quitar
                        <span className="sr-only"> la promoción de {line.title}</span>
                      </SubmitButton>
                    </div>
                    {fixed ? (
                      <span className="text-xs text-muted-foreground">
                        El precio de esta promoción es fijo.
                      </span>
                    ) : reference != null ? (
                      <span className="text-xs text-muted-foreground">
                        Solo pide un motivo si el precio baja de {money.plain(reference,line.currency)}.
                      </span>
                    ) : null}
                  </div>
                ) : (
                  offers.map(({ promo, item }) => {
                    const key = `apply:${line.planItemId}:${promo.id}`
                    return (
                      <div
                        key={promo.id}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{promo.name}:</span>{" "}
                          {item.mode === "fixed"
                            ? `quedaría en ${money.plain(item.priceCents, item.currency)}`
                            : `tú pones el precio final, desde ${money.plain(item.priceCents, item.currency)}`}
                        </span>
                        <SubmitButton
                          size="sm"
                          variant="outline"
                          pending={pending === key}
                          disabled={blocked}
                          onClick={() =>
                            void runPromotion(
                              key,
                              item.mode === "fixed"
                                ? { planItemId: line.planItemId, promotionId: promo.id }
                                : {
                                    planItemId: line.planItemId,
                                    promotionId: promo.id,
                                    // Con «desde», el precio editable empieza en el mínimo anunciado.
                                    promotionFinalPriceCents: item.priceCents,
                                  },
                            )
                          }
                        >
                          Aplicar
                          <span className="sr-only">
                            {" "}
                            {promo.name} a {line.title}
                          </span>
                        </SubmitButton>
                      </div>
                    )
                  })
                )}
              </li>
            )
          })}
        </ul>
      </div>

      {addable.length > 0 ? (
        <fieldset className="flex flex-col gap-2 rounded-xl border border-dashed px-3 py-3">
          <legend className="px-1 text-sm font-medium">Otros tratamientos del plan</legend>
          <p className="text-xs text-muted-foreground">
            Marca uno para incluirlo en este presupuesto, a su tarifa.
          </p>
          {addable.map((item) => (
            <label key={item.id} className="flex items-center gap-3 text-sm">
              <Checkbox
                checked={false}
                disabled={blocked}
                aria-label={`Incluir ${item.title}`}
                onCheckedChange={(next) => {
                  if (next !== true) return
                  setError(null)
                  setPending(`add:${item.id}`)
                  addItems([item.id])
                    .catch((err: unknown) => setError(mutationMessage(err)))
                    .finally(() => setPending(null))
                }}
              />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{item.title}</span>{" "}
                <span className="text-xs text-muted-foreground">{treatmentSiteLabel(item)}</span>
              </span>
              <span className="text-muted-foreground tabular-nums">
                {item.priceCents == null ? "Sin tarifa" : money.plain(item.priceCents, item.currency)}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {promotionsFailed ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          No se pudieron cargar las promociones vigentes.
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={onRetryPromotions}
          >
            Reintentar
          </Button>
        </p>
      ) : null}

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-3">
          <Button
            type="button"
            variant="link"
            className="h-auto self-start p-0"
            disabled={blocked}
            onClick={() => {
              setDiscountPercent("")
              setDiscountReason(reasonText)
              setDiscountError(null)
              setDiscountOpen(true)
            }}
          >
            Aplicar un descuento a todo
          </Button>
          <Field>
            <FieldLabel htmlFor={`${uid}-reason`}>Motivo del ajuste de precio</FieldLabel>
            <Input
              id={`${uid}-reason`}
              value={reasonText}
              maxLength={500}
              disabled={blocked}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
            <FieldDescription>Se pide solo cuando un precio baja de la tarifa.</FieldDescription>
          </Field>
        </div>
        <BudgetTotals budget={budget} money={money} className="flex-[1_1_16rem]" />
      </div>

      {dirty ? (
        <p role="status" className="text-sm text-muted-foreground">
          Hay cambios sin guardar: el total se actualiza al guardar el borrador.
        </p>
      ) : null}
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {actionAlert}

      <div className="flex flex-wrap gap-2 border-t pt-4">
        <SubmitButton pending={delivering} disabled={blocked} onClick={handleDeliver}>
          Imprimir y entregar
        </SubmitButton>
        <SubmitButton
          variant="outline"
          pending={pending === "save"}
          disabled={blocked || !dirty}
          onClick={() => void handleSave()}
        >
          Guardar borrador
        </SubmitButton>
        {secondaryActions}
      </div>

      {discountOpen ? (
        <FormDrawer
          open={discountOpen}
          title="Aplicar un descuento a todo"
          description="Baja el mismo porcentaje a cada tratamiento, calculado sobre su tarifa. Los que tienen una promoción no cambian."
          error={discountError}
          isSubmitting={pending === "discount"}
          submitLabel="Aplicar descuento"
          onClose={() => {
            if (pending !== "discount") setDiscountOpen(false)
          }}
          onSubmit={(event) => {
            event.preventDefault()
            void submitDiscount()
          }}
        >
          <Field>
            <FieldLabel htmlFor={`${uid}-discount-percent`}>Descuento, en porcentaje</FieldLabel>
            <Input
              id={`${uid}-discount-percent`}
              inputMode="numeric"
              autoComplete="off"
              value={discountPercent}
              onChange={(event) => setDiscountPercent(event.currentTarget.value)}
            />
            <FieldDescription>Un número del 1 al 100.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-discount-reason`}>Motivo del descuento</FieldLabel>
            <Input
              id={`${uid}-discount-reason`}
              value={discountReason}
              maxLength={500}
              onChange={(event) => setDiscountReason(event.currentTarget.value)}
            />
            <FieldDescription>Queda anotado en cada tratamiento que baja.</FieldDescription>
          </Field>
        </FormDrawer>
      ) : null}
    </>
  )
}

type Answer = "aceptado" | "pospuesto" | "rechazado"

const ANSWER_OPTIONS: ReadonlyArray<{ value: Answer; label: string }> = [
  { value: "aceptado", label: "Acepta" },
  { value: "pospuesto", label: "Lo piensa" },
  { value: "rechazado", label: "No" },
]

/** Lo que el paciente ya aceptó o no aceptó no se reescribe al completar la respuesta. */
function isAnswerFinal(line: BudgetLine): boolean {
  return line.decision === "aceptado" || line.decision === "rechazado"
}

/**
 * Cómo quedará el presupuesto, para decirlo antes de guardar. Misma derivación
 * que `decideBudget` en `packages/services/src/budgets.ts`; el estado real es
 * el que devuelve el servidor.
 */
function expectedStatus(answers: string[]): string {
  const accepted = answers.filter((answer) => answer === "aceptado").length
  if (accepted === answers.length) return "aceptado"
  if (accepted > 0) return "parcial"
  return answers.includes("pospuesto") ? "pospuesto" : "rechazado"
}

interface Decider {
  id: string
  name: string
  kind: "paciente" | "representante" | "anterior"
}

function deciderRole(kind: Decider["kind"]): string {
  if (kind === "paciente") return "paciente"
  if (kind === "representante") return "representante legal"
  return "quien respondió la primera vez"
}

/** «Decide Elena Huamán, paciente» con «Cambiar» (tableros 6 y 28). */
function DeciderPicker({
  patientId,
  selectId,
  decider,
  deciders,
  locked,
  changing,
  notice,
  onStartChange,
  onChange,
}: {
  patientId: string
  selectId: string
  decider: Decider | null
  deciders: Decider[]
  /** Al completar una respuesta decide quien la dio: no se cambia. */
  locked: boolean
  changing: boolean
  notice: string | null
  onStartChange: () => void
  onChange: (contactId: string) => void
}): React.JSX.Element {
  const responsiblesLink = (
    <Button
      nativeButton={false}
      variant="link"
      size="sm"
      className="h-auto self-start p-0"
      render={
        <Link to="/patients/$patientId" params={{ patientId }} search={{ tab: "responsables" }} />
      }
    >
      Registrar un representante en Responsables
    </Button>
  )
  return (
    <div className="flex flex-col gap-2 rounded-xl border px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1">
          {decider ? (
            <>
              <span className="text-muted-foreground">Decide</span>{" "}
              <span className="font-medium">{decider.name}</span>
              <span className="text-muted-foreground">, {deciderRole(decider.kind)}</span>
            </>
          ) : (
            "No hay una persona vinculada que pueda decidir."
          )}
        </p>
        {!locked && !changing && decider ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={onStartChange}
          >
            Cambiar
          </Button>
        ) : null}
      </div>
      {!locked && changing && decider ? (
        <Field>
          <FieldLabel htmlFor={selectId}>Quién decide</FieldLabel>
          <ChoiceSelect
            id={selectId}
            value={decider.id}
            onChange={(event) => onChange(event.target.value)}
          >
            {deciders.map((option) => (
              <option key={option.id} value={option.id}>
                {`${option.name} · ${deciderRole(option.kind)}`}
              </option>
            ))}
          </ChoiceSelect>
          <FieldDescription>
            Decide el paciente o su representante legal vigente.
          </FieldDescription>
          {responsiblesLink}
        </Field>
      ) : null}
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
      {!decider || (notice && !changing && !locked) ? responsiblesLink : null}
    </div>
  )
}

/**
 * Respuesta del paciente a un presupuesto entregado (tableros 6 y 28): cuatro
 * respuestas claras que abren el mismo panel con cada tratamiento ya marcado;
 * nada queda anotado hasta «Guardar la respuesta», porque lo aceptado o no
 * aceptado no se reescribe después. Sirve a quien tenga `budgets.decide`.
 */
export function BudgetResponse({
  patientId,
  budget,
  canDecide,
  disabled = false,
  money,
  formatDay,
  runWrite,
  className,
}: {
  patientId: string
  budget: BudgetWithTotals
  canDecide: boolean
  disabled?: boolean
  money: Money
  formatDay: (iso: string) => string
  /** Envoltura de escritura de la pantalla (guardas e invalidaciones propias). */
  runWrite?: <T>(operation: () => Promise<T>) => Promise<T>
  className?: string
}): React.JSX.Element {
  const uid = useId()
  const queryClient = useQueryClient()
  const canPatients = usePermission("patients.read")
  const answerable = BUDGET_ANSWERABLE_STATUSES.includes(budget.status)
  const active = canDecide && answerable

  const patientQuery = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled: active && canPatients,
  })
  const responsibilitiesQuery = useQuery({
    queryKey: ["responsibilities", patientId],
    queryFn: () => fetchResponsibilities(patientId),
    enabled: active && canPatients,
  })

  const [chosenDeciderId, setChosenDeciderId] = useState<string | null>(null)
  const [changingDecider, setChangingDecider] = useState(false)
  /**
   * `null`: panel cerrado. Con valor, la respuesta en preparación por
   * tratamiento; el que aún no tiene respuesta marcada no aparece.
   */
  const [draft, setDraft] = useState<Record<string, Answer | undefined> | null>(null)
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** Respuesta definitiva para todo, a la espera de su confirmación corta. */
  const [confirming, setConfirming] = useState<"aceptado" | "rechazado" | null>(null)

  const patient = patientQuery.data?.data
  const responsibilities = responsibilitiesQuery.data?.data
  const { deciders, minor } = useMemo(() => {
    const list: Decider[] = []
    const self = patient?.contacts.find((link) => link.relationship === "self" && link.isActive)
    if (self) list.push({ id: self.contactId, name: self.displayName, kind: "paciente" })
    for (const row of responsibilities ?? []) {
      if (
        row.kind === "representante_legal" &&
        row.isCurrent &&
        !row.revokedAt &&
        row.contact.isActive &&
        !list.some((entry) => entry.id === row.contactId)
      ) {
        list.push({ id: row.contactId, name: row.contact.displayName, kind: "representante" })
      }
    }
    const birthDate = patient?.patient.birthDate?.slice(0, 10)
    return {
      deciders: list,
      minor: birthDate ? isMinor(birthDate, new Date().toISOString().slice(0, 10)) : false,
    }
  }, [patient, responsibilities])

  // Por defecto decide el paciente; si es menor, su representante legal.
  const self = deciders.find((entry) => entry.kind === "paciente") ?? null
  const representative = deciders.find((entry) => entry.kind === "representante") ?? null
  const defaultDecider = minor ? (representative ?? self) : (self ?? representative)
  // Completar una respuesta: decide quien respondió la primera vez.
  const followUp = budget.status === "parcial" || budget.status === "pospuesto"
  const lockedId = followUp ? (budget.decisionContactId ?? null) : null
  const decider: Decider | null = lockedId
    ? (deciders.find((entry) => entry.id === lockedId) ?? {
        id: lockedId,
        name: budget.acceptedByName ?? "La misma persona",
        kind: "anterior",
      })
    : (deciders.find((entry) => entry.id === chosenDeciderId) ?? defaultDecider)
  const deciderNotice = lockedId
    ? "Completa la respuesta quien la dio la primera vez."
    : minor && !representative
      ? "Es menor de edad y no tiene representante legal registrado."
      : null

  const openLines = budget.items.filter((line) => !isAnswerFinal(line))
  const amount = (cents: number | null): string =>
    cents == null ? AMOUNT_PENDING : money(cents, budget.currency)

  /**
   * Abre el panel con cada tratamiento pendiente ya marcado. «Acepta una
   * parte» lo abre sin marcar (`null`): ahí se elige tratamiento por tratamiento.
   */
  const openWith = (preset: Answer | null) => {
    setDraft(
      preset ? Object.fromEntries(openLines.map((line) => [line.planItemId, preset])) : {},
    )
    setNote(budget.decisionNote ?? "")
    setError(null)
  }

  /** Respuesta de la línea: la ya anotada si es definitiva; si no, la marcada en el panel. */
  const answerOf = (line: BudgetLine): Answer | undefined =>
    line.decision === "aceptado" || line.decision === "rechazado"
      ? line.decision
      : draft?.[line.planItemId]

  /**
   * Importe de lo marcado como «Acepta» mientras se elige, con la misma regla
   * que usa el servidor para `acceptedCents` (`sumAcceptedCents`, compartida en
   * `@odentia/clinical`) sobre los totales de línea que él envía.
   */
  const acceptingCents = (): number | null =>
    sumAcceptedCents(
      budget.items.map((line) => ({
        lineTotalCents: line.lineTotalCents,
        decision: answerOf(line),
      })),
    )

  type Decisions = Array<{ planItemId: string; decision: Answer }>

  /** Anota la respuesta; devuelve si quedó guardada. El error se muestra donde se pidió. */
  const send = async (decisions: Decisions, decisionNote: string | null): Promise<boolean> => {
    if (saving) return false
    const body = { decisions, decidedByContactId: decider?.id ?? null, decisionNote }
    setSaving(true)
    setError(null)
    try {
      if (runWrite) {
        await runWrite(() => decideBudgetApi(patientId, budget.id, body))
      } else {
        await decideBudgetApi(patientId, budget.id, body)
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["budgets", patientId] }),
          queryClient.invalidateQueries({ queryKey: ["budget", patientId] }),
        ])
      }
      setChangingDecider(false)
      return true
    } catch (err) {
      setError(mutationMessage(err))
      return false
    } finally {
      setSaving(false)
    }
  }

  /**
   * La misma respuesta para todo lo pendiente, sin abrir el panel: lo ya
   * respondido de forma definitiva se reenvía tal cual.
   */
  const answerAll = async (answer: Answer): Promise<void> => {
    const saved = await send(
      budget.items.map((line) => ({
        planItemId: line.planItemId,
        decision:
          line.decision === "aceptado" || line.decision === "rechazado" ? line.decision : answer,
      })),
      budget.decisionNote ?? null,
    )
    if (saved) setConfirming(null)
  }

  const submit = async () => {
    if (!draft || saving) return
    const decisions: Decisions = []
    for (const line of budget.items) {
      const decision = answerOf(line)
      if (!decision) {
        setError("Marca la respuesta de cada tratamiento.")
        return
      }
      decisions.push({ planItemId: line.planItemId, decision })
    }
    if (await send(decisions, note.trim() || null)) setDraft(null)
  }

  const statusLine =
    budget.status === "presentado"
      ? budget.presentedAt
        ? `Entregado el ${formatDay(budget.presentedAt)}, sin respuesta`
        : "Entregado, sin respuesta"
      : budget.decidedAt && ["aceptado", "parcial", "rechazado", "pospuesto"].includes(budget.status)
        ? `${budgetStatusLabel(budget.status)} · respondió el ${formatDay(budget.decidedAt)}`
        : budgetStatusLabel(budget.status)

  const decidersLoading =
    active && canPatients && (patientQuery.isPending || responsibilitiesQuery.isPending)
  const decidersError = patientQuery.error ?? responsibilitiesQuery.error
  const blocked = disabled || saving || decidersLoading

  const picker = (selectId: string) => (
    <DeciderPicker
      patientId={patientId}
      selectId={selectId}
      decider={decider}
      deciders={deciders}
      locked={lockedId != null}
      changing={changingDecider}
      notice={deciderNotice}
      onStartChange={() => setChangingDecider(true)}
      onChange={setChosenDeciderId}
    />
  )

  const answers = budget.items.flatMap((line) => answerOf(line) ?? [])
  const unanswered = budget.items.length - answers.length
  const patientShortName =
    patient?.patient.givenNames?.trim().split(/\s+/)[0] ?? patient?.patient.displayName ?? null

  return (
    <section
      aria-label="Respuesta del paciente"
      className={cn("flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4", className)}
    >
      <div className="flex flex-col gap-1.5">
        <h4 className="text-base font-semibold">¿Qué respondió?</h4>
        <Badge
          variant={budgetStatusTone(budget.status)}
          className="h-auto self-start py-0.5 text-left whitespace-normal"
        >
          {statusLine}
        </Badge>
      </div>

      {budget.decidedAt ? (
        <dl className="flex flex-col gap-1.5 rounded-xl bg-muted/50 p-4 text-sm">
          <div className="flex gap-3">
            <dt className="flex-1 text-muted-foreground">Presupuestado</dt>
            <dd className="text-right tabular-nums">{budget.totalCents == null
                ? AMOUNT_PENDING
                : money.plain(budget.totalCents, budget.currency)}</dd>
          </div>
          <div className="flex items-baseline gap-3">
            <dt className="flex-1 font-semibold">Acepta</dt>
            <dd className="text-right text-lg font-semibold tabular-nums">
              {amount(budget.acceptedCents)}
            </dd>
          </div>
        </dl>
      ) : null}
      {budget.decidedAt && budget.acceptedByName ? (
        <p className="text-sm text-muted-foreground">Respondió {budget.acceptedByName}.</p>
      ) : null}
      {budget.decisionNote ? (
        <p className="text-sm text-muted-foreground">Nota: {budget.decisionNote}</p>
      ) : null}

      {!answerable ? null : !canDecide ? (
        <p className="text-sm text-muted-foreground">
          Tu rol no anota respuestas de presupuestos: lo hacen el odontólogo del plan, caja o la
          administración.
        </p>
      ) : decidersLoading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : decidersError ? (
        <ErrorState
          title="No se pudo cargar quién decide"
          error={decidersError instanceof ApiError ? decidersError.shape : null}
          onRetry={() => {
            void patientQuery.refetch()
            void responsibilitiesQuery.refetch()
          }}
        />
      ) : (
        <>
          {followUp ? (
            <p className="text-sm">
              {openLines.length === 1
                ? "Falta la respuesta de 1 tratamiento."
                : `Falta la respuesta de ${openLines.length} tratamientos.`}
            </p>
          ) : null}
          {draft == null ? picker(`${uid}-decider`) : null}
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              size="lg"
              disabled={blocked || openLines.length === 0}
              onClick={() => {
                setError(null)
                setConfirming("aceptado")
              }}
            >
              <Check aria-hidden="true" />
              Acepta todo
            </Button>
            {openLines.length > 1 ? (
              <Button
                type="button"
                variant="outline"
                disabled={blocked}
                onClick={() => openWith(null)}
              >
                Acepta una parte
              </Button>
            ) : null}
            {/* Pensarlo no cierra nada (se responde después): se anota con un clic. */}
            <SubmitButton
              variant="outline"
              pending={saving && confirming == null && draft == null}
              disabled={blocked || openLines.length === 0}
              onClick={() => void answerAll("pospuesto")}
            >
              Lo va a pensar
            </SubmitButton>
            <Button
              type="button"
              variant="outline"
              className="text-destructive"
              disabled={blocked || openLines.length === 0}
              onClick={() => {
                setError(null)
                setConfirming("rechazado")
              }}
            >
              No acepta
            </Button>
          </div>
          {error && draft == null && confirming == null ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Aceptar no genera deuda. Cada tratamiento se cobra cuando se atiende, o antes si el
            paciente deja un adelanto.
          </p>
          <div className="flex flex-col gap-1 border-t pt-3">
            <span className="text-sm font-semibold text-muted-foreground">
              También puede responder el paciente
            </span>
            <span className="text-sm">
              Si tiene acceso al portal, ve este presupuesto ahí y elige por tratamiento. Su
              respuesta llega aquí.
            </span>
          </div>
        </>
      )}

      {/* Aceptar o no aceptar todo no se reescribe después: una confirmación corta. */}
      <ConfirmDialog
        open={confirming != null}
        title={confirming === "rechazado" ? "¿Anotar que no acepta?" : "¿Anotar que acepta todo?"}
        description={`${
          decider ? `Decide ${decider.name}, ${deciderRole(decider.kind)}. ` : ""
        }Quedará como «${budgetStatusLabel(
          expectedStatus(
            budget.items.map((line) =>
              line.decision === "aceptado" || line.decision === "rechazado"
                ? line.decision
                : (confirming ?? "pospuesto"),
            ),
          ),
        )}» y ya no se cambia: para corregirlo se crea una revisión.${error ? ` ${error}` : ""}`}
        confirmLabel={confirming === "rechazado" ? "Anotar que no acepta" : "Anotar que acepta todo"}
        variant={confirming === "rechazado" ? "destructive" : "default"}
        pending={saving}
        onConfirm={() => {
          if (confirming) void answerAll(confirming)
        }}
        onClose={() => {
          if (!saving) setConfirming(null)
        }}
      />

      {draft != null ? (
        <FormDrawer
          open
          title={patientShortName ? `¿Qué acepta ${patientShortName}?` : "¿Qué acepta el paciente?"}
          description={`${budgetNumberLabel(budget.budgetNumber)}. Marca la respuesta de cada tratamiento.`}
          error={error}
          isSubmitting={saving}
          submitLabel="Guardar la respuesta"
          onClose={() => {
            if (!saving) setDraft(null)
          }}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <ul className="flex flex-col divide-y rounded-xl border">
            {budget.items.map((line) => {
              const final = isAnswerFinal(line)
              const value = answerOf(line)
              return (
                <li key={line.id} className="flex flex-col gap-2 px-3 py-3">
                  <div className="flex gap-3 text-sm">
                    <span className="min-w-0 flex-1 font-medium">{line.title}</span>
                    <span className="whitespace-nowrap tabular-nums">
                      {line.lineTotalCents == null
                        ? "Sin tarifa"
                        : money.plain(line.lineTotalCents, line.currency)}
                    </span>
                  </div>
                  {final ? (
                    <p className="text-xs text-muted-foreground">
                      Ya respondió: {budgetAnswerLabel(line.decision).toLowerCase()}. No se cambia
                      desde aquí.
                    </p>
                  ) : (
                    <ButtonGroup aria-label={`Respuesta para ${line.title}`} className="w-full">
                      {ANSWER_OPTIONS.map((option) => (
                        <Button
                          key={option.value}
                          type="button"
                          size="sm"
                          className="flex-1"
                          variant={value === option.value ? "default" : "outline"}
                          aria-pressed={value === option.value}
                          disabled={saving}
                          onClick={() =>
                            setDraft((current) =>
                              current ? { ...current, [line.planItemId]: option.value } : current,
                            )
                          }
                        >
                          {option.label}
                        </Button>
                      ))}
                    </ButtonGroup>
                  )}
                </li>
              )
            })}
          </ul>

          <dl className="flex flex-col gap-1.5 rounded-xl bg-muted/50 p-4 text-sm">
            <div className="flex gap-3">
              <dt className="flex-1 text-muted-foreground">Presupuestado</dt>
              <dd className="text-right tabular-nums">{budget.totalCents == null
                ? AMOUNT_PENDING
                : money.plain(budget.totalCents, budget.currency)}</dd>
            </div>
            <div className="flex items-baseline gap-3">
              <dt className="flex-1 font-semibold">Acepta</dt>
              <dd className="text-right text-lg font-semibold tabular-nums">
                {amount(acceptingCents())}
              </dd>
            </div>
          </dl>

          {picker(`${uid}-drawer-decider`)}

          <Field>
            <FieldLabel htmlFor={`${uid}-note`}>Nota, si hace falta</FieldLabel>
            <Textarea
              id={`${uid}-note`}
              rows={2}
              maxLength={4000}
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </Field>

          <p role="status" className="text-sm text-muted-foreground">
            {unanswered > 0
              ? unanswered === 1
                ? "Falta marcar la respuesta de 1 tratamiento."
                : `Falta marcar la respuesta de ${unanswered} tratamientos.`
              : `Quedará como «${budgetStatusLabel(expectedStatus(answers))}».${
                  answers.includes("pospuesto") ? " Lo que piensa se puede responder después." : ""
                }${
                  answers.some((answer) => answer !== "pospuesto")
                    ? " Lo que acepta o no acepta ya no se cambia: para corregirlo se crea una revisión."
                    : ""
                }`}
          </p>
        </FormDrawer>
      ) : null}
    </section>
  )
}

function PrepareBudgetDrawer({
  planTitle,
  eligible,
  budgetsById,
  money,
  error,
  pending,
  onClose,
  onSubmit,
}: {
  planTitle: string
  eligible: PlanItem[]
  budgetsById: Map<string, BudgetWithTotals>
  money: Money
  error: string | null
  pending: boolean
  onClose: () => void
  onSubmit: (itemIds: string[], title: string | null, notes: string | null) => void
}): React.JSX.Element {
  const uid = useId()
  const [checked, setChecked] = useState<string[]>(() => eligible.map((item) => item.id))
  const [title, setTitle] = useState(planTitle)
  const [notes, setNotes] = useState("")
  const [localError, setLocalError] = useState<string | null>(null)
  const toggle = (id: string) => {
    setChecked((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]))
  }
  return (
    <FormDrawer
      open
      title="Preparar presupuesto"
      description="Elige los tratamientos del plan que entran. Nace como borrador: ahí ajustas precios, promociones y visitas previstas, y ves el total."
      error={localError ?? error}
      isSubmitting={pending}
      submitLabel="Crear borrador"
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        if (checked.length === 0) {
          setLocalError("Elige al menos un tratamiento para presupuestar.")
          return
        }
        setLocalError(null)
        onSubmit(
          eligible.filter((item) => checked.includes(item.id)).map((item) => item.id),
          title.trim() === "" ? null : title.trim(),
          notes.trim() === "" ? null : notes.trim(),
        )
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Tratamientos</legend>
        {eligible.map((item) => {
          const previous = item.budgetId ? budgetsById.get(item.budgetId) : undefined
          return (
            <label key={item.id} className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={checked.includes(item.id)}
                onCheckedChange={() => toggle(item.id)}
                aria-label={`Incluir ${item.title}`}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{item.title}</span>
                <span className="text-xs text-muted-foreground">
                  {treatmentSiteLabel(item)} ·{" "}
                  {item.priceCents == null
                    ? "Sin tarifa"
                    : `Tarifa ${money.plain(item.priceCents, item.currency)}`}{" "}
                  ·{" "}
                  {!item.budgetId
                    ? "Sin presupuestar"
                    : item.decision === "rechazado"
                      ? "No aceptado antes"
                      : previous
                        ? `Estuvo en un presupuesto ${budgetStatusLabel(previous.status).toLowerCase()}`
                        : "Estuvo en un presupuesto anterior"}
                </span>
              </span>
            </label>
          )
        })}
      </fieldset>
      <Field>
        <FieldLabel htmlFor={`${uid}-prepare-title`}>Título</FieldLabel>
        <Input
          id={`${uid}-prepare-title`}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          maxLength={200}
        />
        <FieldDescription>Si lo dejas vacío, lleva el nombre del plan.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-prepare-notes`}>Notas para el paciente</FieldLabel>
        <Textarea
          id={`${uid}-prepare-notes`}
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
          rows={2}
          maxLength={4000}
        />
      </Field>
    </FormDrawer>
  )
}

function EditBudgetDrawer({
  initialTitle,
  initialNotes,
  error,
  pending,
  onClose,
  onSubmit,
}: {
  initialTitle: string
  initialNotes: string
  error: string | null
  pending: boolean
  onClose: () => void
  onSubmit: (title: string | undefined, notes: string | null) => void
}): React.JSX.Element {
  const uid = useId()
  const [title, setTitle] = useState(initialTitle)
  const [notes, setNotes] = useState(initialNotes)
  const [localError, setLocalError] = useState<string | null>(null)
  return (
    <FormDrawer
      open
      title="Título y notas del presupuesto"
      description="Salen en la hoja que recibe el paciente."
      error={localError ?? error}
      isSubmitting={pending}
      isDirty={title !== initialTitle || notes !== initialNotes}
      submitLabel="Guardar"
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        const nextTitle = title.trim()
        if (!nextTitle) {
          setLocalError("Escribe un título para el presupuesto.")
          return
        }
        setLocalError(null)
        onSubmit(
          nextTitle === initialTitle ? undefined : nextTitle,
          notes.trim() === "" ? null : notes.trim(),
        )
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${uid}-edit-title`}>Título</FieldLabel>
        <Input
          id={`${uid}-edit-title`}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          maxLength={200}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-edit-notes`}>Notas</FieldLabel>
        <Textarea
          id={`${uid}-edit-notes`}
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
          rows={3}
          maxLength={4000}
        />
      </Field>
    </FormDrawer>
  )
}
