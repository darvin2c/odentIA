import { Badge, Button, Checkbox, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import {
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef, getCoreRowModel, type Table, useReactTable } from "@tanstack/react-table"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import {
  type BudgetLine,
  type BudgetWithTotals,
  budgetNumberLabel,
  budgetStatusLabel,
  cancelBudgetApi,
  createBudgetApi,
  type DecideBudgetBody,
  decideBudgetApi,
  fetchBudgetDetail,
  fetchBudgets,
  fetchTreatmentPlanDetail,
  fetchTreatmentPlans,
  planDecisionLabel,
  presentBudgetApi,
  reviseBudgetApi,
  updateBudgetApi,
} from "../../lib/budgets"
import {
  centsFromInput,
  createChargeApi,
  createOptionGroupApi,
  fetchResponsibilities,
  mutationMessage as journeyMessage,
  setItemAlternativeApi,
} from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import type { PatientFull, PlanItem, TreatmentPlanWithStatus } from "../../lib/patients"
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
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")
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

  const [reviseOpen, setReviseOpen] = useState(false)
  const [reviseIds, setReviseIds] = useState<string[]>([])
  const [reviseReason, setReviseReason] = useState("")
  const [reviseError, setReviseError] = useState<string | null>(null)

  const [chargeLine, setChargeLine] = useState<BudgetLine | null>(null)
  const [chargeAmount, setChargeAmount] = useState("")
  const [chargeError, setChargeError] = useState<string | null>(null)

  const [decisionOpen, setDecisionOpen] = useState(false)
  const [acceptedIds, setAcceptedIds] = useState<string[]>([])
  const [acceptedBy, setAcceptedBy] = useState("")
  const [decisionNote, setDecisionNote] = useState("")
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const [decisionByContactId, setDecisionByContactId] = useState("")

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
    enabled: canRead,
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
  const responsibilitiesQuery = useQuery({
    queryKey: ["responsibilities", patientId],
    queryFn: () => fetchResponsibilities(patientId),
    enabled: canRead,
  })
  const budgetDetailQuery = useQuery({
    queryKey: ["budget", patientId, selectedBudgetId],
    queryFn: () => fetchBudgetDetail(patientId, selectedBudgetId as string),
    enabled: canRead && selectedBudgetId != null,
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
  // Quién puede decidir la propuesta: el propio paciente o su representante legal vigente.
  const deciders = useMemo(() => {
    const list: Array<{ id: string; label: string }> = []
    for (const contact of patientQuery.data?.data.contacts ?? []) {
      if (contact.relationship === "self") {
        list.push({ id: contact.contactId, label: "El propio paciente" })
      }
    }
    for (const row of responsibilitiesQuery.data?.data ?? []) {
      if (row.kind === "representante_legal" && row.isCurrent && !row.revokedAt) {
        list.push({ id: row.contactId, label: `Representante legal: ${row.contact.displayName}` })
      }
    }
    return list
  }, [patientQuery.data, responsibilitiesQuery.data])
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
    mutationFn: (body: DecideBudgetBody) =>
      writeBudget(() => decideBudgetApi(patientId, selectedBudget!.id, body)),
    onSuccess: () => {
      setDecisionOpen(false)
      setDecisionError(null)
      setActionError(null)
      setDecisionByContactId("")
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

  const chargeMutation = useMutation({
    mutationFn: () =>
      writeBudget(() =>
        createChargeApi(patientId, {
          budgetItemId: chargeLine!.id,
          amountCents: centsFromInput(chargeAmount) ?? undefined,
        }),
      ),
    onSuccess: () => {
      setChargeLine(null)
      setChargeAmount("")
      setChargeError(null)
    },
    onError: (err) => setChargeError(journeyMessage(err)),
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

  const busy =
    createBudgetMutation.isPending ||
    updateMutation.isPending ||
    decideMutation.isPending ||
    cancelMutation.isPending ||
    presentMutation.isPending ||
    reviseMutation.isPending ||
    groupMutation.isPending ||
    alternativeMutation.isPending ||
    chargeMutation.isPending
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
                                <select
                                  aria-label={`Alternativa de ${item.title}`}
                                  className="h-9 rounded-md border bg-background px-3 text-sm"
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
                                </select>
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
                    setDecisionByContactId(selectedBudget.decisionContactId ?? "")
                    setDecisionError(null)
                    setDecisionOpen(true)
                  }}
                  onCancel={() => setCancellingBudget(selectedBudget)}
                  onRevise={() => {
                    setReviseIds(selectedBudget.items.map((line) => line.planItemId))
                    setReviseReason("")
                    setReviseError(null)
                    setReviseOpen(true)
                  }}
                  onCharge={(line) => {
                    setChargeAmount(String((line.priceCents ?? 0) / 100))
                    setChargeError(null)
                    setChargeLine(line)
                  }}
                  revisionAvailable={["presentado", "aceptado", "parcial", "pospuesto"].includes(
                    selectedBudget.status,
                  )}
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

      {decisionOpen && selectedBudget ? (
        <DecideBudgetDialog
          uid={uid}
          lines={selectedBudget.items}
          initialAccepted={acceptedIds}
          initialNote={decisionNote}
          deciders={deciders}
          deciderId={decisionByContactId}
          onDeciderChange={setDecisionByContactId}
          error={decisionError}
          pending={decideMutation.isPending}
          onClose={() => setDecisionOpen(false)}
          onSubmit={(decisions, decisionNote) =>
            decideMutation.mutate({
              decisions,
              decisionNote,
              decidedByContactId: decisionByContactId || null,
            })
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

      <FormDrawer
        open={chargeLine != null}
        title={`Generar cargo: ${chargeLine?.title ?? ""}`}
        description="El cargo conserva la línea de la propuesta y su tratamiento, y no puede superar el importe pendiente de esa línea."
        error={chargeLine ? chargeError : null}
        isSubmitting={chargeMutation.isPending}
        submitLabel="Generar cargo"
        onClose={() => {
          if (!chargeMutation.isPending) setChargeLine(null)
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (centsFromInput(chargeAmount) == null) {
            setChargeError("Indica un importe positivo con hasta dos decimales.")
            return
          }
          chargeMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-charge-amount`}>Importe del cargo</FieldLabel>
          <Input
            id={`${uid}-charge-amount`}
            value={chargeAmount}
            onChange={(event) => setChargeAmount(event.target.value)}
          />
        </Field>
      </FormDrawer>
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
  onRevise,
  onCharge,
  revisionAvailable,
  lineTable,
}: {
  budget: BudgetWithTotals
  canWrite: boolean
  writeBlocked: boolean
  onEdit: () => void
  onPresent: () => void
  onDecide: () => void
  onCancel: () => void
  onRevise: () => void
  onCharge: (line: BudgetLine) => void
  /** Revisión vigente o decisiones ya tomadas: la revisión se ofrece después de presentar. */
  revisionAvailable: boolean
  lineTable: Table<BudgetLine>
}) {
  const isDraft = budget.status === "borrador"
  const isPresented = budget.status === "presentado"
  const canCancel = isDraft || isPresented
  const acceptedLines = budget.items.filter(
    (line) => line.decision === "aceptado" && line.priceCents != null,
  )
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
      {canWrite && acceptedLines.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <span className="text-sm font-medium">Cargos desde líneas aceptadas</span>
          <p className="text-xs text-muted-foreground">
            Aceptar la propuesta no genera cargos: cada cargo se emite explícitamente y conserva la
            línea y el tratamiento de su origen.
          </p>
          <ul className="flex flex-col gap-2">
            {acceptedLines.map((line) => (
              <li key={line.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span>{line.title}</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatMoney(line.priceCents ?? 0, line.currency)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={writeBlocked}
                  onClick={() => onCharge(line)}
                >
                  Generar cargo
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
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
          {revisionAvailable ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={writeBlocked}
              onClick={onRevise}
            >
              Crear revisión
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
  initialNote,
  deciders,
  deciderId,
  onDeciderChange,
  error,
  pending,
  onClose,
  onSubmit,
}: {
  uid: string
  lines: BudgetLine[]
  initialAccepted: string[]
  initialNote: string
  /** Quién puede asumir la decisión: el paciente o su representante legal vigente. */
  deciders: Array<{ id: string; label: string }>
  deciderId: string
  onDeciderChange: (contactId: string) => void
  error: string | null
  pending: boolean
  onClose: () => void
  onSubmit: (decisions: DecideBudgetBody["decisions"], decisionNote: string | null) => void
}) {
  const [decisions, setDecisions] = useState<
    Record<string, "aceptado" | "rechazado" | "pospuesto">
  >(
    Object.fromEntries(
      lines.map((line) => [
        line.planItemId,
        initialAccepted.includes(line.planItemId) ? "aceptado" : "pospuesto",
      ]),
    ),
  )
  const [note, setNote] = useState(initialNote)
  return (
    <div
      role="dialog"
      aria-label="Registrar decisión"
      className="flex flex-col gap-3 rounded-xl border p-4"
    >
      <h4 className="font-semibold">Registrar decisión</h4>
      <p className="text-sm text-muted-foreground">
        Registra una decisión por tratamiento. La aceptación no equivale a ejecución ni cobro.
      </p>
      <ul className="flex flex-col gap-2">
        {lines.map((line) => (
          <li key={line.id} className="flex items-start gap-2">
            <select
              aria-label={`Decisión: ${line.title}`}
              value={decisions[line.planItemId]}
              onChange={(event) =>
                setDecisions((current) => ({
                  ...current,
                  [line.planItemId]: event.target.value as "aceptado" | "rechazado" | "pospuesto",
                }))
              }
            >
              <option value="aceptado">Aceptado</option>
              <option value="rechazado">Rechazado</option>
              <option value="pospuesto">Pospuesto</option>
            </select>
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
        <FieldLabel htmlFor={`${uid}-decide-by`}>Quién decide</FieldLabel>
        <select
          id={`${uid}-decide-by`}
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={deciderId}
          onChange={(event) => onDeciderChange(event.target.value)}
        >
          <option value="">Sin responsable registrado</option>
          {deciders.map((decider) => (
            <option key={decider.id} value={decider.id}>
              {decider.label}
            </option>
          ))}
        </select>
        {deciders.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Para registrar quién decide, vincula al paciente y asigna el rol de representante legal
            en Responsables.
          </p>
        ) : null}
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
          onClick={() =>
            onSubmit(
              lines.map((line) => ({
                planItemId: line.planItemId,
                decision: decisions[line.planItemId] ?? "pospuesto",
              })),
              note.trim() || null,
            )
          }
        >
          {pending ? "Guardando…" : "Registrar"}
        </Button>
      </div>
    </div>
  )
}
