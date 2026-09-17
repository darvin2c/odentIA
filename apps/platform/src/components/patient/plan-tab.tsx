import { Badge, Button, Checkbox, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import {
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef, getCoreRowModel, type Table, useReactTable } from "@tanstack/react-table"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError } from "../../lib/api"
import {
  type BudgetLine,
  type BudgetWithTotals,
  budgetNumberLabel,
  budgetStatusLabel,
  cancelBudgetApi,
  createBudgetApi,
  decideBudgetApi,
  fetchBudgetDetail,
  fetchBudgets,
  fetchTreatmentPlanDetail,
  fetchTreatmentPlans,
  planDecisionLabel,
  presentBudgetApi,
  updateBudgetApi,
} from "../../lib/budgets"
import { useCanWrite } from "../../lib/crm"
import type { PlanItem, TreatmentPlanWithStatus } from "../../lib/patients"
import { formatMoney } from "../../lib/services"

function mutationMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.shape.message) return err.shape.message
    if (err.shape.code) return `No se pudo guardar (${err.shape.code}). Inténtalo de nuevo.`
  }
  return err instanceof Error ? err.message : "No se pudo guardar. Inténtalo de nuevo."
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" })
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
  const canWrite = useCanWrite()
  const uid = useId()

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [selectedBudgetId, setSelectedBudgetId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [prepareOpen, setPrepareOpen] = useState(false)
  const [prepareIds, setPrepareIds] = useState<string[]>([])
  const [prepareTitle, setPrepareTitle] = useState("")
  const [prepareNotes, setPrepareNotes] = useState("")
  const [prepareError, setPrepareError] = useState<string | null>(null)

  const [editOpen, setEditOpen] = useState(false)
  const [editTitle, setEditTitle] = useState("")
  const [editNotes, setEditNotes] = useState("")
  const [editError, setEditError] = useState<string | null>(null)

  const [presenting, setPresenting] = useState(false)
  const [cancellingBudget, setCancellingBudget] = useState<BudgetWithTotals | null>(null)

  const [decisionOpen, setDecisionOpen] = useState(false)
  const [acceptedIds, setAcceptedIds] = useState<string[]>([])
  const [acceptedBy, setAcceptedBy] = useState("")
  const [decisionNote, setDecisionNote] = useState("")
  const [decisionError, setDecisionError] = useState<string | null>(null)

  const plansQuery = useQuery({
    queryKey: ["treatment-plans", patientId],
    queryFn: () => fetchTreatmentPlans(patientId),
  })
  const budgetsQuery = useQuery({
    queryKey: ["budgets", patientId],
    queryFn: () => fetchBudgets(patientId),
  })
  const planDetailQuery = useQuery({
    queryKey: ["treatment-plan", patientId, selectedPlanId],
    queryFn: () => fetchTreatmentPlanDetail(patientId, selectedPlanId as string),
    enabled: selectedPlanId != null,
  })
  const budgetDetailQuery = useQuery({
    queryKey: ["budget", patientId, selectedBudgetId],
    queryFn: () => fetchBudgetDetail(patientId, selectedBudgetId as string),
    enabled: selectedBudgetId != null,
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
      queryClient.invalidateQueries({ queryKey: ["plan", patientId] }),
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
      setPrepareIds([])
      setPrepareTitle("")
      setPrepareNotes("")
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

  const presentMutation = useMutation({
    mutationFn: () => writeBudget(() => presentBudgetApi(patientId, selectedBudget!.id)),
    onSuccess: () => {
      setPresenting(false)
      setActionError(null)
    },
    onError: (err) => {
      setActionError(mutationMessage(err))
      setPresenting(false)
    },
  })

  const decideMutation = useMutation({
    mutationFn: (body: {
      acceptedItemIds: string[]
      acceptedByName: string
      decisionNote: string | null
    }) => writeBudget(() => decideBudgetApi(patientId, selectedBudget!.id, body)),
    onSuccess: () => {
      setDecisionOpen(false)
      setDecisionError(null)
      setActionError(null)
    },
    onError: (err) => setDecisionError(mutationMessage(err)),
  })

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

  const busy =
    createBudgetMutation.isPending ||
    updateMutation.isPending ||
    decideMutation.isPending ||
    cancelMutation.isPending ||
    presentMutation.isPending
  const writeBlocked = disabled || busy

  const openPlan = (id: string) => {
    setSelectedPlanId(id)
    setSelectedBudgetId(null)
    setActionError(null)
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
                Creado el {formatDate(row.original.plan.createdAt)}
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
    [],
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
              {formatMoney(row.original.priceCents, row.original.currency)}
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
    [budgetsById],
  )
  const itemTable = useReactTable({
    data: planItems,
    columns: itemColumns,
    getCoreRowModel: getCoreRowModel(),
  })

  const lineColumns = useMemo<ColumnDef<BudgetLine>[]>(
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
        header: "Cotizado",
        meta: { view: { primary: true } },
        cell: ({ row }) =>
          row.original.priceCents == null ? (
            <span className="text-muted-foreground">Sin tarifa</span>
          ) : (
            <span className="whitespace-nowrap tabular-nums">
              {formatMoney(row.original.priceCents, row.original.currency)}
            </span>
          ),
      },
      {
        accessorKey: "decision",
        header: "Decisión",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
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
                : "Rechazado"}
          </Badge>
        ),
      },
      {
        accessorKey: "itemStatus",
        header: "Estado clínico",
        cell: ({ row }) => <Badge variant="outline">{row.original.itemStatus}</Badge>,
      },
    ],
    [],
  )
  const lineTable = useReactTable({
    data: selectedBudget?.items ?? [],
    columns: lineColumns,
    getCoreRowModel: getCoreRowModel(),
  })

  if (plansQuery.isPending || budgetsQuery.isPending) return <LoadingState />
  const loadError = plansQuery.error ?? budgetsQuery.error
  if (loadError) {
    return (
      <ErrorState
        error={loadError instanceof ApiError ? loadError.shape : null}
        onRetry={() => {
          void plansQuery.refetch()
          void budgetsQuery.refetch()
        }}
      />
    )
  }

  const selectedPlan = plans.find((p) => p.plan.id === selectedPlanId) ?? null

  return (
    <div className="flex flex-col gap-4">
      {contextMismatch ? (
        <p role="alert" className="rounded-xl border border-destructive/50 p-3 text-sm">
          El presupuesto enlazado pertenece a otro plan: se muestra su plan real en lugar de
          seleccionar otro paciente o el primer plan.
        </p>
      ) : null}
      {actionError ? (
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

              <section aria-label="Presupuestos del plan">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold">Presupuestos</h4>
                  {canWrite && eligibleItems.length > 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={writeBlocked}
                      onClick={() => {
                        setPrepareIds(eligibleItems.map((i) => i.id))
                        setPrepareTitle(selectedPlan.plan.title)
                        setPrepareNotes("")
                        setPrepareError(null)
                        setPrepareOpen(true)
                      }}
                    >
                      Preparar presupuesto
                    </Button>
                  ) : null}
                </div>
                {planBudgets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Este plan aún no tiene presupuestos.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {planBudgets.map((b) => (
                      <li key={b.id}>
                        <Button
                          type="button"
                          variant={selectedBudgetId === b.id ? "default" : "outline"}
                          className="h-auto w-full justify-start py-2"
                          onClick={() => setSelectedBudgetId(b.id)}
                        >
                          <span className="flex flex-col items-start">
                            <span className="font-medium">
                              {budgetNumberLabel(b.budgetNumber)} · {b.title}
                            </span>
                            <span className="text-xs opacity-80">
                              {budgetStatusLabel(b.status)} · {b.items.length} tratamiento
                              {b.items.length === 1 ? "" : "s"}
                              {b.totalCents != null
                                ? ` · ${formatMoney(b.totalCents, b.currency)}`
                                : " · total con tarifas pendientes"}
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
                  budget={selectedBudget}
                  canWrite={canWrite}
                  writeBlocked={writeBlocked}
                  onEdit={() => {
                    setEditTitle(selectedBudget.title)
                    setEditNotes(selectedBudget.notes ?? "")
                    setEditError(null)
                    setEditOpen(true)
                  }}
                  onPresent={() => setPresenting(true)}
                  onDecide={() => {
                    setAcceptedIds(selectedBudget.items.map((i) => i.planItemId))
                    setAcceptedBy(selectedBudget.acceptedByName ?? "")
                    setDecisionNote(selectedBudget.decisionNote ?? "")
                    setDecisionError(null)
                    setDecisionOpen(true)
                  }}
                  onCancel={() => setCancellingBudget(selectedBudget)}
                  lineTable={lineTable}
                />
              ) : null}
            </>
          )}
        </div>
      )}

      {prepareOpen && selectedPlan ? (
        <PrepareBudgetDialog
          planTitle={selectedPlan.plan.title}
          eligible={eligibleItems}
          budgetsById={budgetsById}
          initialIds={prepareIds}
          initialTitle={prepareTitle}
          initialNotes={prepareNotes}
          error={prepareError}
          pending={createBudgetMutation.isPending}
          onClose={() => setPrepareOpen(false)}
          onSubmit={(itemIds, title, notes) => {
            if (itemIds.length === 0) {
              setPrepareError("Elige al menos un tratamiento para presupuestar.")
              return
            }
            createBudgetMutation.mutate({ planId: selectedPlan.plan.id, itemIds, title, notes })
          }}
        />
      ) : null}

      {editOpen && selectedBudget ? (
        <EditBudgetDialog
          initialTitle={editTitle}
          initialNotes={editNotes}
          error={editError}
          pending={updateMutation.isPending}
          onClose={() => setEditOpen(false)}
          onSubmit={(title, notes) => updateMutation.mutate({ title, notes })}
        />
      ) : null}

      {decisionOpen && selectedBudget ? (
        <DecideBudgetDialog
          uid={uid}
          lines={selectedBudget.items}
          initialAccepted={acceptedIds}
          initialBy={acceptedBy}
          initialNote={decisionNote}
          error={decisionError}
          pending={decideMutation.isPending}
          onClose={() => setDecisionOpen(false)}
          onSubmit={(acceptedItemIds, acceptedByName, decisionNote) =>
            decideMutation.mutate({ acceptedItemIds, acceptedByName, decisionNote })
          }
        />
      ) : null}

      <ConfirmDialog
        open={presenting}
        title="Presentar presupuesto"
        description={
          selectedBudget
            ? `Se presentará ${budgetNumberLabel(selectedBudget.budgetNumber)} «${selectedBudget.title}» con ${selectedBudget.items.length} tratamiento${selectedBudget.items.length === 1 ? "" : "s"}. La cotización quedará congelada y el borrador ya no será editable.`
            : "Se presentará el presupuesto."
        }
        confirmLabel="Presentar"
        onConfirm={() => presentMutation.mutate()}
        pending={presentMutation.isPending}
        onClose={() => {
          if (!presentMutation.isPending) setPresenting(false)
        }}
      />

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
    </div>
  )
}

function BudgetDetail({
  budget,
  canWrite,
  writeBlocked,
  onEdit,
  onPresent,
  onDecide,
  onCancel,
  lineTable,
}: {
  budget: BudgetWithTotals
  canWrite: boolean
  writeBlocked: boolean
  onEdit: () => void
  onPresent: () => void
  onDecide: () => void
  onCancel: () => void
  lineTable: Table<BudgetLine>
}) {
  const isDraft = budget.status === "borrador"
  const isPresented = budget.status === "presentado"
  const canCancel = isDraft || isPresented
  return (
    <section
      aria-label="Detalle del presupuesto"
      className="flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-semibold">
          {budgetNumberLabel(budget.budgetNumber)} · {budget.title}
        </h4>
        <Badge
          variant={
            isDraft
              ? "secondary"
              : isPresented
                ? "default"
                : budget.status === "cancelado"
                  ? "destructive"
                  : "success"
          }
        >
          {budgetStatusLabel(budget.status)}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
        <span>
          Total:{" "}
          {budget.totalCents == null
            ? "con tarifas pendientes"
            : formatMoney(budget.totalCents, budget.currency)}
        </span>
        <span>
          Aceptado:{" "}
          {budget.acceptedCents == null ? "—" : formatMoney(budget.acceptedCents, budget.currency)}
        </span>
        {budget.decidedAt ? (
          <span>
            Decidido el {formatDate(budget.decidedAt)} por {budget.acceptedByName ?? "—"}
          </span>
        ) : null}
      </div>
      {budget.notes ? <p className="text-sm">{budget.notes}</p> : null}
      {budget.decisionNote ? (
        <p className="text-sm text-muted-foreground">Decisión: {budget.decisionNote}</p>
      ) : null}
      <DataTable table={lineTable} />
      {canWrite ? (
        <div className="flex flex-wrap gap-2">
          {isDraft ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={writeBlocked}
              onClick={onEdit}
            >
              Editar borrador
            </Button>
          ) : null}
          {isDraft ? (
            <Button type="button" size="sm" disabled={writeBlocked} onClick={onPresent}>
              Presentar
            </Button>
          ) : null}
          {isPresented ? (
            <Button type="button" size="sm" disabled={writeBlocked} onClick={onDecide}>
              Registrar decisión
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={writeBlocked}
              onClick={onCancel}
            >
              Cancelar
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function PrepareBudgetDialog({
  planTitle,
  eligible,
  budgetsById,
  initialIds,
  initialTitle,
  initialNotes,
  error,
  pending,
  onClose,
  onSubmit,
}: {
  planTitle: string
  eligible: PlanItem[]
  budgetsById: Map<string, BudgetWithTotals>
  initialIds: string[]
  initialTitle: string
  initialNotes: string
  error: string | null
  pending: boolean
  onClose: () => void
  onSubmit: (itemIds: string[], title: string | null, notes: string | null) => void
}) {
  const [checked, setChecked] = useState<string[]>(initialIds)
  const [title, setTitle] = useState(initialTitle || planTitle)
  const [notes, setNotes] = useState(initialNotes)
  const toggle = (id: string) => {
    setChecked((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]))
  }
  const total = eligible
    .filter((i) => checked.includes(i.id))
    .reduce<number | null>(
      (acc, i) => (acc == null || i.priceCents == null ? null : acc + i.priceCents),
      0,
    )
  return (
    <div
      role="dialog"
      aria-label="Preparar presupuesto"
      className="flex flex-col gap-3 rounded-xl border p-4"
    >
      <h4 className="font-semibold">Preparar presupuesto</h4>
      <p className="text-sm text-muted-foreground">
        Selección explícita de ítems elegibles. Sin descuentos ni deuda: solo lo indicado con
        tarifa.
      </p>
      <ul className="flex flex-col gap-2">
        {eligible.map((item) => (
          <li key={item.id} className="flex items-start gap-2">
            <Checkbox
              checked={checked.includes(item.id)}
              onCheckedChange={() => toggle(item.id)}
              aria-label={item.title}
            />
            <span className="flex flex-1 flex-col">
              <span className="text-sm font-medium">{item.title}</span>
              <span className="text-xs text-muted-foreground">
                {treatmentSiteLabel(item)} ·{" "}
                {item.priceCents == null
                  ? "Sin tarifa"
                  : formatMoney(item.priceCents, item.currency)}{" "}
                ·{" "}
                {!item.budgetId
                  ? "Sin presupuestar"
                  : item.decision === "rechazado"
                    ? "Rechazado antes"
                    : `Presupuesto ${budgetsById.get(item.budgetId) ? budgetStatusLabel(budgetsById.get(item.budgetId)!.status).toLowerCase() : "previo"}`}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <Field>
        <FieldLabel htmlFor="prepare-title">Título (por defecto, el del plan)</FieldLabel>
        <Input
          id="prepare-title"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          maxLength={200}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="prepare-notes">Notas</FieldLabel>
        <Textarea
          id="prepare-notes"
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
          rows={2}
          maxLength={4000}
        />
      </Field>
      <p className="text-sm font-semibold tabular-nums">
        Total:{" "}
        {total == null
          ? "con tarifas pendientes"
          : formatMoney(total, eligible[0]?.currency ?? "PEN")}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancelar
        </Button>
        <Button
          type="button"
          disabled={pending || checked.length === 0}
          onClick={() =>
            onSubmit(
              checked,
              title.trim() === "" ? null : title.trim(),
              notes.trim() === "" ? null : notes.trim(),
            )
          }
        >
          {pending ? "Creando…" : "Crear presupuesto"}
        </Button>
      </div>
    </div>
  )
}

function EditBudgetDialog({
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
}) {
  const [title, setTitle] = useState(initialTitle)
  const [notes, setNotes] = useState(initialNotes)
  return (
    <div
      role="dialog"
      aria-label="Editar borrador"
      className="flex flex-col gap-3 rounded-xl border p-4"
    >
      <h4 className="font-semibold">Editar borrador</h4>
      <Field>
        <FieldLabel htmlFor="edit-budget-title">Título</FieldLabel>
        <Input
          id="edit-budget-title"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          maxLength={200}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="edit-budget-notes">Notas</FieldLabel>
        <Textarea
          id="edit-budget-notes"
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
          rows={2}
          maxLength={4000}
        />
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancelar
        </Button>
        <Button
          type="button"
          disabled={pending}
          onClick={() => {
            const nextTitle = title.trim()
            onSubmit(
              nextTitle === initialTitle ? undefined : nextTitle,
              notes.trim() === "" ? null : notes.trim(),
            )
          }}
        >
          {pending ? "Guardando…" : "Guardar"}
        </Button>
      </div>
    </div>
  )
}

function DecideBudgetDialog({
  uid,
  lines,
  initialAccepted,
  initialBy,
  initialNote,
  error,
  pending,
  onClose,
  onSubmit,
}: {
  uid: string
  lines: BudgetLine[]
  initialAccepted: string[]
  initialBy: string
  initialNote: string
  error: string | null
  pending: boolean
  onClose: () => void
  onSubmit: (acceptedItemIds: string[], acceptedByName: string, decisionNote: string | null) => void
}) {
  const [checked, setChecked] = useState<string[]>(initialAccepted)
  const [by, setBy] = useState(initialBy)
  const [note, setNote] = useState(initialNote)
  const [localError, setLocalError] = useState<string | null>(null)
  const toggle = (id: string) => {
    setChecked((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]))
  }
  return (
    <div
      role="dialog"
      aria-label="Registrar decisión"
      className="flex flex-col gap-3 rounded-xl border p-4"
    >
      <h4 className="font-semibold">Registrar decisión</h4>
      <p className="text-sm text-muted-foreground">
        Marca los tratamientos aceptados en ESTE documento. La aceptación parcial no equivale a
        realización.
      </p>
      <ul className="flex flex-col gap-2">
        {lines.map((line) => (
          <li key={line.id} className="flex items-start gap-2">
            <Checkbox
              checked={checked.includes(line.planItemId)}
              onCheckedChange={() => toggle(line.planItemId)}
              aria-label={line.title}
            />
            <span className="flex flex-1 flex-col">
              <span className="text-sm font-medium">{line.title}</span>
              <span className="text-xs text-muted-foreground">
                {treatmentSiteLabel(line)} ·{" "}
                {line.priceCents == null
                  ? "Sin tarifa"
                  : formatMoney(line.priceCents, line.currency)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <Field>
        <FieldLabel htmlFor={`${uid}-decide-by`}>Aceptado por (nombre)</FieldLabel>
        <Input
          id={`${uid}-decide-by`}
          value={by}
          onChange={(e) => setBy(e.currentTarget.value)}
          maxLength={200}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-decide-note`}>Nota de decisión</FieldLabel>
        <Textarea
          id={`${uid}-decide-note`}
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          rows={2}
          maxLength={4000}
        />
      </Field>
      {(error ?? localError) ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? localError}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancelar
        </Button>
        <Button
          type="button"
          disabled={pending}
          onClick={() => {
            if (by.trim() === "") {
              setLocalError("Indica el nombre de quien acepta.")
              return
            }
            onSubmit(checked, by.trim(), note.trim() === "" ? null : note.trim())
          }}
        >
          {pending ? "Guardando…" : "Registrar"}
        </Button>
      </div>
    </div>
  )
}
