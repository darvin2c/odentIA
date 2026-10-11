/**
 * Finanzas: caja por sede/turno, gastos y proveedores, cuentas por cobrar con
 * planes de cuotas, comisiones y resumen. La API exige `finance.read` para
 * leer y `finance.write` para mutar (owner/admin/cajero); sin acceso se
 * muestra el aviso y ninguna acción.
 *
 * Sin emisor fiscal ni pasarela: no hay emisión de comprobantes ni cobro
 * online en esta pantalla.
 */
import { Badge, Button, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import { EmptyState, FormDrawer, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { useOrgMembers, usePermission } from "../../lib/crm"
import {
  addMovementApi,
  centsFromSoles,
  closeShiftApi,
  createExpenseApi,
  createPlanApi,
  createSupplierApi,
  fetchCommissionRules,
  fetchExpenses,
  fetchFinanceOverview,
  fetchPlans,
  fetchReceivables,
  fetchSettlementDetail,
  fetchSettlements,
  fetchShiftDetail,
  fetchShifts,
  fetchSuppliers,
  financeErrorMessage,
  formatCents,
  formatDateTimeShort,
  MOVEMENT_KIND_LABELS,
  openShiftApi,
  previewCommissionsApi,
  QUOTA_STATUS_LABELS,
  registerPaymentApi,
  settleCommissionsApi,
  upsertRuleApi,
  voidExpenseApi,
  voidMovementApi,
  voidPlanApi,
  voidSettlementApi,
  type CashShift,
  type CommissionPreview,
  type ShiftDetail,
} from "../../lib/finance"
import { formatMoney } from "../../lib/services"
import { sameDraft, usePageDraftGuard } from "../../lib/page-draft-guard"

export const Route = createFileRoute("/_org/finance")({
  component: FinancePage,
})

type Tab = "caja" | "gastos" | "cobros" | "comisiones" | "resumen"

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "caja", label: "Caja" },
  { key: "gastos", label: "Gastos" },
  { key: "cobros", label: "Cuentas por cobrar" },
  { key: "comisiones", label: "Comisiones" },
  { key: "resumen", label: "Resumen" },
]

function useBranches() {
  return useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Array<{ id: string; name: string }> }>("/api/branches"),
  })
}

function AccessDenied({ message }: { message: string }) {
  return (
    <EmptyState
      title="Sin acceso a finanzas"
      description={message || "Tu rol no tiene permiso de caja. Pide a un administrador el rol de cajero."}
    />
  )
}

function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403
}

function FinancePage() {
  const [tab, setTab] = useState<Tab>("caja")
  const canRead = usePermission("finance.read")
  const [commissionDirty, setCommissionDirty] = useState(false)
  const draftGuard = usePageDraftGuard(commissionDirty)
  if (!canRead) {
    return (
      <PageShell>
        <PageHeader title="Finanzas" subtitle="Caja por sede y turno, gastos y comisiones" />
        <AccessDenied message="Tu rol no tiene permiso de caja. Pide a un administrador el rol de cajero." />
      </PageShell>
    )
  }
  return (
    <PageShell>
      {draftGuard.dialog}
      <PageHeader
        title="Finanzas"
        subtitle="Caja por sede y turno, gastos, cuentas por cobrar y comisiones"
      />
      <div className="flex flex-wrap gap-2">
        {TABS.map((entry) => (
          <Button
            key={entry.key}
            variant={tab === entry.key ? "default" : "outline"}
            onClick={() => {
              if (tab !== entry.key) draftGuard.requestLeave(() => setTab(entry.key))
            }}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      {tab === "caja" ? <CajaTab /> : null}
      {tab === "gastos" ? <GastosTab /> : null}
      {tab === "cobros" ? <CobrosTab /> : null}
      {tab === "comisiones" ? <ComisionesTab onDirtyChange={setCommissionDirty} /> : null}
      {tab === "resumen" ? <ResumenTab /> : null}
    </PageShell>
  )
}

// --- Caja -------------------------------------------------------------------

function CajaTab() {
  const queryClient = useQueryClient()
  const canWrite = usePermission("finance.write")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openForm, setOpenForm] = useState(false)
  const branches = useBranches()
  const shiftsQuery = useQuery({ queryKey: ["finance-shifts"], queryFn: () => fetchShifts() })
  const detailQuery = useQuery({
    queryKey: ["finance-shift", selectedId],
    queryFn: () => fetchShiftDetail(selectedId as string),
    enabled: selectedId !== null,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["finance-shifts"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-shift"] })
  }

  const [branchId, setBranchId] = useState("")
  const [currency, setCurrency] = useState("PEN")
  const [opening, setOpening] = useState("")
  const [notes, setNotes] = useState("")
  const [error, setError] = useState<string | null>(null)

  const openMutation = useMutation({
    mutationFn: () =>
      openShiftApi({
        branchId,
        currency,
        openingCents: opening.trim() === "" ? 0 : (centsFromSoles(opening) ?? -1),
        notes: notes.trim() || undefined,
      }),
    onSuccess: (result) => {
      setOpenForm(false)
      setBranchId("")
      setOpening("")
      setNotes("")
      setError(null)
      setSelectedId(result.data.id)
      invalidate()
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  if (shiftsQuery.isError && isForbidden(shiftsQuery.error)) {
    return <AccessDenied message={financeErrorMessage(shiftsQuery.error)} />
  }

  const shifts: CashShift[] = shiftsQuery.data?.data ?? []
  const detail: ShiftDetail | null = detailQuery.data?.data ?? null
  const branchName = (id: string) =>
    branches.data?.data.find((b) => b.id === id)?.name ?? id.slice(0, 8)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {canWrite ? <Button onClick={() => setOpenForm(true)}>Abrir turno</Button> : null}
        {shiftsQuery.isPending ? <p className="text-sm text-muted-foreground">Cargando turnos…</p> : null}
      </div>
      {shiftsQuery.isError ? (
        <p className="text-sm text-destructive">{financeErrorMessage(shiftsQuery.error)}</p>
      ) : null}
      {shifts.length === 0 && !shiftsQuery.isPending ? (
        <EmptyState
          title="Sin turnos de caja"
          description="Abre un turno por sucursal para registrar cobros, gastos de caja chica y el arqueo de cierre."
        />
      ) : (
        <ul className="flex flex-col divide-y rounded-md border bg-card">
          {shifts.map((shift) => (
            <li key={shift.id}>
              <button
                type="button"
                className={`flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left hover:bg-muted ${selectedId === shift.id ? "bg-muted" : ""}`}
                onClick={() => setSelectedId(shift.id)}
              >
                <Badge>{shift.status === "abierta" ? "Abierta" : "Cerrada"}</Badge>
                <span className="font-medium">{branchName(shift.branchId)}</span>
                <span className="text-sm text-muted-foreground">
                  {shift.currency} · apertura {formatCents(shift.openingCents, shift.currency)}
                </span>
                <span className="text-sm text-muted-foreground">
                  {formatDateTimeShort(shift.openedAt)}
                </span>
                {shift.status === "cerrada" && shift.differenceCents !== null ? (
                  <span
                    className={`text-sm font-medium ${shift.differenceCents === 0 ? "text-success" : "text-destructive"}`}
                  >
                    Diferencia {formatCents(shift.differenceCents, shift.currency)}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      {detail ? (
        <ShiftDetailPanel
          detail={detail}
          branchLabel={branchName(detail.shift.branchId)}
          canWrite={canWrite}
          onChanged={invalidate}
        />
      ) : null}

      <FormDrawer
        open={openForm}
        title="Abrir turno de caja"
        description="Un solo turno abierto por sucursal y moneda. La apertura queda como primer movimiento."
        error={error}
        isSubmitting={openMutation.isPending}
        submitLabel="Abrir turno"
        onClose={() => {
          if (!openMutation.isPending) {
            setOpenForm(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!branchId) {
            setError("Elige la sucursal del turno.")
            return
          }
          const cents = opening.trim() === "" ? 0 : centsFromSoles(opening)
          if (cents === null || cents < 0) {
            setError("La apertura debe ser 0 o un importe válido (p. ej. 150.00).")
            return
          }
          openMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="shift-branch">Sucursal</FieldLabel>
            <select
              id="shift-branch"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
            >
              <option value="">Seleccionar sucursal</option>
              {branches.data?.data.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="shift-currency">Moneda</FieldLabel>
            <select
              id="shift-currency"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              <option value="PEN">PEN — Soles</option>
              <option value="USD">USD — Dólares</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="shift-opening">Apertura (0 si empieza vacía)</FieldLabel>
            <Input
              id="shift-opening"
              inputMode="decimal"
              placeholder="0.00"
              value={opening}
              onChange={(event) => setOpening(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="shift-notes">Notas</FieldLabel>
            <Textarea
              id="shift-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>
    </div>
  )
}

function ShiftDetailPanel({
  detail,
  branchLabel,
  canWrite,
  onChanged,
}: {
  detail: ShiftDetail
  branchLabel: string
  canWrite: boolean
  onChanged: () => void
}) {
  const queryClient = useQueryClient()
  const [movementForm, setMovementForm] = useState(false)
  const [paymentForm, setPaymentForm] = useState(false)
  const [closeForm, setCloseForm] = useState(false)
  const [voidId, setVoidId] = useState<string | null>(null)
  const [direction, setDirection] = useState<"ingreso" | "egreso">("ingreso")
  const [kind, setKind] = useState("aporte")
  const [amount, setAmount] = useState("")
  const [concept, setConcept] = useState("")
  const [paymentId, setPaymentId] = useState("")
  const [counted, setCounted] = useState("")
  const [closeNotes, setCloseNotes] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const { shift, movements, ingresosCents, electronicosCents, egresosCents, esperadoCents } = detail
  const open = shift.status === "abierta"

  const movementMutation = useMutation({
    mutationFn: () => {
      const cents = centsFromSoles(amount)
      if (cents === null) throw new Error("Importe inválido")
      return addMovementApi(shift.id, { direction, kind, amountCents: cents, concept })
    },
    onSuccess: () => {
      setMovementForm(false)
      setAmount("")
      setConcept("")
      setError(null)
      onChanged()
      void queryClient.invalidateQueries({ queryKey: ["finance-shift", shift.id] })
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const paymentMutation = useMutation({
    mutationFn: () => registerPaymentApi(shift.id, paymentId.trim()),
    onSuccess: () => {
      setPaymentForm(false)
      setPaymentId("")
      setError(null)
      onChanged()
      void queryClient.invalidateQueries({ queryKey: ["finance-shift", shift.id] })
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const closeMutation = useMutation({
    mutationFn: () => {
      const cents = centsFromSoles(counted)
      if (cents === null && counted.trim() !== "0") throw new Error("Contado inválido")
      return closeShiftApi(shift.id, {
        countedCents: counted.trim() === "0" ? 0 : (cents as number),
        notes: closeNotes.trim() || undefined,
      })
    },
    onSuccess: () => {
      setCloseForm(false)
      setError(null)
      onChanged()
      void queryClient.invalidateQueries({ queryKey: ["finance-shift", shift.id] })
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const voidMutation = useMutation({
    mutationFn: () => voidMovementApi(voidId as string, reason),
    onSuccess: () => {
      setVoidId(null)
      setReason("")
      setError(null)
      onChanged()
      void queryClient.invalidateQueries({ queryKey: ["finance-shift", shift.id] })
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  return (
    <div className="flex flex-col gap-4 elevated rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">
          Turno {branchLabel} · {shift.currency}
        </h3>
        <Badge>{open ? "Abierta" : "Cerrada"}</Badge>
        <span className="text-sm text-muted-foreground">
          Esperado en efectivo {formatCents(esperadoCents, shift.currency)} (ingresos{" "}
          {formatCents(ingresosCents, shift.currency)} − egresos{" "}
          {formatCents(egresosCents, shift.currency)}) · electrónico{" "}
          {formatCents(electronicosCents, shift.currency)} (no entra al arqueo)
        </span>
      </div>
      {open && canWrite ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setPaymentForm(true)}>
            Ingresar cobro
          </Button>
          <Button variant="outline" onClick={() => setMovementForm(true)}>
            Aporte / retiro / ajuste
          </Button>
          <Button onClick={() => setCloseForm(true)}>Cerrar con arqueo</Button>
        </div>
      ) : null}
      {!open ? (
        <p className="text-sm text-muted-foreground">
          Cerrado el {formatDateTimeShort(shift.closedAt)} · contado{" "}
          {shift.countedCents !== null ? formatCents(shift.countedCents, shift.currency) : "—"} ·
          diferencia{" "}
          {shift.differenceCents !== null ? formatCents(shift.differenceCents, shift.currency) : "—"}
          {shift.closeNotes ? ` · ${shift.closeNotes}` : ""}
        </p>
      ) : null}
      {movements.length === 0 ? (
        <EmptyState
          title="Sin movimientos"
          description="Ingresa un cobro registrado en la cuenta del paciente o un aporte manual."
        />
      ) : (
        <ul className="flex flex-col divide-y">
          {movements.map((movement) => (
            <li key={movement.id} className="flex flex-wrap items-center gap-2 py-2">
              <Badge>{MOVEMENT_KIND_LABELS[movement.kind] ?? movement.kind}</Badge>
              <span className="text-sm">{movement.concept}</span>
              <span
                className={`text-sm font-medium ${movement.direction === "ingreso" ? "text-success" : "text-destructive"}`}
              >
                {movement.direction === "ingreso" ? "+" : "−"}
                {formatCents(movement.amountCents, movement.currency)}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatDateTimeShort(movement.createdAt)}
                {movement.method ? ` · ${movement.method}` : ""}
              </span>
              {open && canWrite && movement.kind !== "apertura" ? (
                <Button variant="ghost" onClick={() => setVoidId(movement.id)}>
                  Anular
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <FormDrawer
        open={paymentForm}
        title="Ingresar cobro al turno"
        description="Pega el identificador del pago registrado en la cuenta del paciente. Cada cobro entra a caja una sola vez y en la moneda del turno."
        error={error}
        isSubmitting={paymentMutation.isPending}
        submitLabel="Ingresar cobro"
        onClose={() => {
          if (!paymentMutation.isPending) {
            setPaymentForm(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!paymentId.trim()) {
            setError("Pega el identificador del pago.")
            return
          }
          paymentMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor="shift-payment-id">Identificador del pago</FieldLabel>
          <Input
            id="shift-payment-id"
            placeholder="uuid del pago en la cuenta del paciente"
            value={paymentId}
            onChange={(event) => setPaymentId(event.target.value)}
          />
        </Field>
      </FormDrawer>

      <FormDrawer
        open={movementForm}
        title="Aporte, retiro o ajuste"
        description="Movimiento manual del turno. Los cobros y gastos usan su propio flujo."
        error={error}
        isSubmitting={movementMutation.isPending}
        submitLabel="Registrar movimiento"
        onClose={() => {
          if (!movementMutation.isPending) {
            setMovementForm(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (centsFromSoles(amount) === null) {
            setError("Ingresa un importe válido (p. ej. 50.00).")
            return
          }
          if (!concept.trim()) {
            setError("Describe el concepto del movimiento.")
            return
          }
          movementMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="movement-direction">Dirección</FieldLabel>
            <select
              id="movement-direction"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={direction}
              onChange={(event) => setDirection(event.target.value as "ingreso" | "egreso")}
            >
              <option value="ingreso">Ingreso</option>
              <option value="egreso">Egreso</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="movement-kind">Tipo</FieldLabel>
            <select
              id="movement-kind"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="aporte">Aporte</option>
              <option value="retiro">Retiro</option>
              <option value="devolucion">Devolución</option>
              <option value="ajuste">Ajuste</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="movement-amount">Importe</FieldLabel>
            <Input
              id="movement-amount"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="movement-concept">Concepto</FieldLabel>
            <Input
              id="movement-concept"
              value={concept}
              onChange={(event) => setConcept(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        open={closeForm}
        title="Cerrar turno con arqueo"
        description={`Esperado en efectivo: ${formatCents(esperadoCents, shift.currency)} (los ${formatCents(electronicosCents, shift.currency)} electrónicos no entran al arqueo). Solo dueño/admin cierran; reintentar un cierre devuelve el mismo resultado.`}
        error={error}
        isSubmitting={closeMutation.isPending}
        submitLabel="Cerrar turno"
        onClose={() => {
          if (!closeMutation.isPending) {
            setCloseForm(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          const cents = counted.trim() === "0" ? 0 : centsFromSoles(counted)
          if (cents === null || cents < 0) {
            setError("Ingresa el contado físico (p. ej. 480.00).")
            return
          }
          closeMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="close-counted">Contado físico</FieldLabel>
            <Input
              id="close-counted"
              inputMode="decimal"
              placeholder="0.00"
              value={counted}
              onChange={(event) => setCounted(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="close-notes">Notas de cierre</FieldLabel>
            <Textarea
              id="close-notes"
              value={closeNotes}
              onChange={(event) => setCloseNotes(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        dock={false}
        open={voidId !== null}
        title="Anular movimiento"
        description="La anulación queda auditada con motivo; el turno cerrado no se modifica."
        error={error}
        isSubmitting={voidMutation.isPending}
        submitLabel="Anular"
        onClose={() => {
          if (!voidMutation.isPending) {
            setVoidId(null)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!reason.trim()) {
            setError("Indica el motivo de la anulación.")
            return
          }
          voidMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor="void-reason">Motivo</FieldLabel>
          <Textarea
            id="void-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </FormDrawer>
    </div>
  )
}

// --- Gastos -------------------------------------------------------------------

function GastosTab() {
  const queryClient = useQueryClient()
  const canWrite = usePermission("finance.write")
  const [supplierForm, setSupplierForm] = useState(false)
  const [expenseForm, setExpenseForm] = useState(false)
  const [voidId, setVoidId] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [docType, setDocType] = useState("RUC")
  const [docNumber, setDocNumber] = useState("")
  const [branchId, setBranchId] = useState("")
  const [supplierId, setSupplierId] = useState("")
  const [concept, setConcept] = useState("")
  const [amount, setAmount] = useState("")
  const [currency, setCurrency] = useState("PEN")
  const [receiptKind, setReceiptKind] = useState("ninguno")
  const [receiptNumber, setReceiptNumber] = useState("")
  const [shiftId, setShiftId] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const branches = useBranches()
  const suppliersQuery = useQuery({ queryKey: ["finance-suppliers"], queryFn: fetchSuppliers })
  const expensesQuery = useQuery({ queryKey: ["finance-expenses"], queryFn: fetchExpenses })
  const shiftsQuery = useQuery({ queryKey: ["finance-shifts-open"], queryFn: () => fetchShifts("abierta") })

  if (
    (suppliersQuery.isError && isForbidden(suppliersQuery.error)) ||
    (expensesQuery.isError && isForbidden(expensesQuery.error))
  ) {
    return <AccessDenied message="Tu rol no tiene permiso de finanzas." />
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["finance-suppliers"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-expenses"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-shift"] })
  }

  const supplierMutation = useMutation({
    mutationFn: () =>
      createSupplierApi({
        name: name.trim(),
        docType,
        docNumber: docNumber.trim() || undefined,
      }),
    onSuccess: () => {
      setSupplierForm(false)
      setName("")
      setDocNumber("")
      setError(null)
      invalidate()
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const expenseMutation = useMutation({
    mutationFn: () => {
      const cents = centsFromSoles(amount)
      if (cents === null) throw new Error("Importe inválido")
      return createExpenseApi({
        branchId,
        supplierId: supplierId || null,
        concept: concept.trim(),
        amountCents: cents,
        currency,
        receiptKind,
        receiptNumber: receiptNumber.trim() || undefined,
        shiftId: shiftId || null,
      })
    },
    onSuccess: () => {
      setExpenseForm(false)
      setConcept("")
      setAmount("")
      setReceiptNumber("")
      setShiftId("")
      setError(null)
      invalidate()
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const voidMutation = useMutation({
    mutationFn: () => voidExpenseApi(voidId as string, reason),
    onSuccess: () => {
      setVoidId(null)
      setReason("")
      setError(null)
      invalidate()
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const suppliers = suppliersQuery.data?.data ?? []
  const expenses = expensesQuery.data?.data ?? []
  const openShifts = shiftsQuery.data?.data ?? []

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold">Proveedores</h3>
          {canWrite ? (
            <Button variant="outline" onClick={() => setSupplierForm(true)}>
              Nuevo proveedor
            </Button>
          ) : null}
        </div>
        {suppliers.length === 0 ? (
          <EmptyState
            title="Sin proveedores"
            description="Registra los proveedores para asociar gastos con documento y contacto."
          />
        ) : (
          <ul className="flex flex-col divide-y rounded-md border bg-card">
            {suppliers.map((supplier) => (
              <li key={supplier.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
                <span className="font-medium">{supplier.name}</span>
                <span className="text-sm text-muted-foreground">
                  {supplier.docType}
                  {supplier.docNumber ? ` ${supplier.docNumber}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold">Gastos</h3>
          {canWrite ? (
            <Button variant="outline" onClick={() => setExpenseForm(true)}>
              Registrar gasto
            </Button>
          ) : null}
        </div>
        {expenses.length === 0 ? (
          <EmptyState
            title="Sin gastos"
            description="Registra gastos directos o con cargo a la caja chica de un turno abierto."
          />
        ) : (
          <ul className="flex flex-col divide-y rounded-md border bg-card">
            {expenses.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
                <span className="font-medium">{item.concept}</span>
                <span className="text-sm font-medium text-destructive">
                  −{formatCents(item.amountCents, item.currency)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatDateTimeShort(item.spentAt)} · {item.receiptKind}
                  {item.receiptNumber ? ` ${item.receiptNumber}` : ""}
                  {item.shiftId ? " · caja chica" : " · directo"}
                </span>
                {canWrite ? (
                  <Button variant="ghost" onClick={() => setVoidId(item.id)}>
                    Anular
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <FormDrawer
        open={supplierForm}
        title="Nuevo proveedor"
        description="Solo datos declarados; nada fiscal se emite desde aquí."
        error={error}
        isSubmitting={supplierMutation.isPending}
        submitLabel="Guardar proveedor"
        onClose={() => {
          if (!supplierMutation.isPending) {
            setSupplierForm(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!name.trim()) {
            setError("Ingresa el nombre del proveedor.")
            return
          }
          supplierMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="supplier-name">Nombre</FieldLabel>
            <Input id="supplier-name" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="supplier-doc">Tipo de documento</FieldLabel>
            <select
              id="supplier-doc"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={docType}
              onChange={(event) => setDocType(event.target.value)}
            >
              <option value="RUC">RUC</option>
              <option value="DNI">DNI</option>
              <option value="CE">CE</option>
              <option value="pasaporte">Pasaporte</option>
              <option value="otro">Otro</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="supplier-doc-number">Número de documento</FieldLabel>
            <Input
              id="supplier-doc-number"
              value={docNumber}
              onChange={(event) => setDocNumber(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        open={expenseForm}
        title="Registrar gasto"
        description="Con turno, el egreso sale de su caja chica; sin turno queda como gasto directo."
        error={error}
        isSubmitting={expenseMutation.isPending}
        submitLabel="Registrar gasto"
        onClose={() => {
          if (!expenseMutation.isPending) {
            setExpenseForm(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!branchId) {
            setError("Elige la sucursal.")
            return
          }
          if (!concept.trim()) {
            setError("Describe el concepto del gasto.")
            return
          }
          if (centsFromSoles(amount) === null) {
            setError("Ingresa un importe válido.")
            return
          }
          expenseMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="expense-branch">Sucursal</FieldLabel>
            <select
              id="expense-branch"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
            >
              <option value="">Seleccionar sucursal</option>
              {branches.data?.data.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="expense-supplier">Proveedor (opcional)</FieldLabel>
            <select
              id="expense-supplier"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={supplierId}
              onChange={(event) => setSupplierId(event.target.value)}
            >
              <option value="">Sin proveedor</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="expense-concept">Concepto</FieldLabel>
            <Input
              id="expense-concept"
              value={concept}
              onChange={(event) => setConcept(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="expense-amount">Importe</FieldLabel>
            <Input
              id="expense-amount"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="expense-currency">Moneda</FieldLabel>
            <select
              id="expense-currency"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              <option value="PEN">PEN — Soles</option>
              <option value="USD">USD — Dólares</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="expense-receipt">Comprobante recibido</FieldLabel>
            <select
              id="expense-receipt"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={receiptKind}
              onChange={(event) => setReceiptKind(event.target.value)}
            >
              <option value="ninguno">Ninguno</option>
              <option value="boleta">Boleta</option>
              <option value="factura">Factura</option>
              <option value="recibo">Recibo</option>
              <option value="nota">Nota</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="expense-receipt-number">Número de comprobante</FieldLabel>
            <Input
              id="expense-receipt-number"
              value={receiptNumber}
              onChange={(event) => setReceiptNumber(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="expense-shift">Caja chica (opcional)</FieldLabel>
            <select
              id="expense-shift"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={shiftId}
              onChange={(event) => setShiftId(event.target.value)}
            >
              <option value="">Gasto directo (sin turno)</option>
              {openShifts.map((s) => (
                <option key={s.id} value={s.id}>
                  Turno {s.currency} · {s.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        dock={false}
        open={voidId !== null}
        title="Anular gasto"
        description="Si el turno sigue abierto también se anula su movimiento; si ya cerró, el movimiento queda como histórico."
        error={error}
        isSubmitting={voidMutation.isPending}
        submitLabel="Anular"
        onClose={() => {
          if (!voidMutation.isPending) {
            setVoidId(null)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!reason.trim()) {
            setError("Indica el motivo de la anulación.")
            return
          }
          voidMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor="expense-void-reason">Motivo</FieldLabel>
          <Textarea id="expense-void-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </FormDrawer>
    </div>
  )
}

// --- Cuentas por cobrar ----------------------------------------------------------

function CobrosTab() {
  const queryClient = useQueryClient()
  const canWrite = usePermission("finance.write")
  const [planForm, setPlanForm] = useState(false)
  const [voidId, setVoidId] = useState<string | null>(null)
  const [patientId, setPatientId] = useState("")
  const [chargeId, setChargeId] = useState("")
  const [installments, setInstallments] = useState("3")
  const [firstDueAt, setFirstDueAt] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const receivablesQuery = useQuery({ queryKey: ["finance-receivables"], queryFn: fetchReceivables })
  const plansQuery = useQuery({ queryKey: ["finance-plans"], queryFn: fetchPlans })

  if (
    (receivablesQuery.isError && isForbidden(receivablesQuery.error)) ||
    (plansQuery.isError && isForbidden(plansQuery.error))
  ) {
    return <AccessDenied message="Tu rol no tiene permiso de finanzas." />
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["finance-receivables"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-plans"] })
  }

  const planMutation = useMutation({
    mutationFn: () =>
      createPlanApi({
        patientId: patientId.trim(),
        chargeId: chargeId.trim(),
        installments: Number(installments),
        firstDueAt,
      }),
    onSuccess: () => {
      setPlanForm(false)
      setPatientId("")
      setChargeId("")
      setFirstDueAt("")
      setError(null)
      invalidate()
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const voidMutation = useMutation({
    mutationFn: () => voidPlanApi(voidId as string, reason),
    onSuccess: () => {
      setVoidId(null)
      setReason("")
      setError(null)
      invalidate()
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const receivables = (receivablesQuery.data?.data ?? []).filter((r) => r.outstandingCents > 0)
  const plans = plansQuery.data?.data ?? []

  return (
    <div className="flex flex-col gap-6">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <section className="flex flex-col gap-2">
        <h3 className="text-base font-semibold">Por cobrar</h3>
        {receivables.length === 0 && !receivablesQuery.isPending ? (
          <EmptyState
            title="Sin cuentas por cobrar"
            description="Los cargos pendientes de aplicar aparecen aquí por paciente y moneda."
          />
        ) : (
          <ul className="flex flex-col divide-y rounded-md border bg-card">
            {receivables.map((row) => (
              <li key={row.charge.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
                <span className="font-medium">{row.charge.description}</span>
                <span className="text-sm text-muted-foreground">
                  {formatCents(row.charge.amountCents, row.charge.currency)} · aplicado{" "}
                  {formatCents(row.appliedCents, row.charge.currency)}
                </span>
                <span className="text-sm font-medium">
                  Falta {formatCents(row.outstandingCents, row.charge.currency)}
                </span>
                <Button
                  variant="ghost"
                  nativeButton={false}
                  render={
                    <Link
                      to="/patients/$patientId"
                      params={{ patientId: row.charge.patientId }}
                      search={{ tab: "cuenta" }}
                    />
                  }
                >
                  Cuenta del paciente
                </Button>
                {canWrite ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setPatientId(row.charge.patientId)
                      setChargeId(row.charge.id)
                      setPlanForm(true)
                    }}
                  >
                    Plan de cuotas
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold">Planes de cuotas</h3>
          {canWrite ? (
            <Button variant="outline" onClick={() => setPlanForm(true)}>
              Nuevo plan
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Las cuotas calendarizan un cargo existente; el saldo real sigue en cargos menos
          aplicaciones, sin duplicar la deuda. El avance se actualiza solo al aplicar,
          anular o devolver pagos.
        </p>
        {plans.length === 0 ? (
          <EmptyState
            title="Sin planes de cuotas"
            description="Crea un plan desde un cargo pendiente para calendarizar su cobro."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {plans.map(({ plan, quotas }) => (
              <li key={plan.id} className="rounded-md border bg-card px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{plan.status}</Badge>
                  <span className="font-medium">
                    {plan.installments} cuotas · {formatCents(plan.totalCents, plan.currency)}
                  </span>
                  {canWrite ? (
                    <Button variant="ghost" onClick={() => setVoidId(plan.id)}>
                      Anular
                    </Button>
                  ) : null}
                </div>
                <ul className="mt-2 flex flex-col divide-y">
                  {quotas.map((quota) => (
                    <li key={quota.id} className="flex flex-wrap items-center gap-2 py-1 text-sm">
                      <span>
                        Cuota {quota.nro} · vence {quota.dueAt}
                      </span>
                      <Badge>{QUOTA_STATUS_LABELS[quota.status] ?? quota.status}</Badge>
                      <span className="text-muted-foreground">
                        {formatCents(quota.amountCents, plan.currency)}
                        {quota.paidCents > 0
                          ? ` · pagado ${formatCents(quota.paidCents, plan.currency)}`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <FormDrawer
        open={planForm}
        title="Nuevo plan de cuotas"
        description="El total del plan es el monto del cargo; las cuotas lo reparten sin crear deuda nueva."
        error={error}
        isSubmitting={planMutation.isPending}
        submitLabel="Crear plan"
        onClose={() => {
          if (!planMutation.isPending) {
            setPlanForm(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!patientId.trim() || !chargeId.trim()) {
            setError("Indica el paciente y el cargo a calendarizar.")
            return
          }
          const count = Number(installments)
          if (!Number.isInteger(count) || count < 1 || count > 60) {
            setError("Las cuotas deben ser entre 1 y 60.")
            return
          }
          if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDueAt)) {
            setError("Indica el primer vencimiento (AAAA-MM-DD).")
            return
          }
          planMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          {/* El plan nace de un cargo por cobrar de la lista: no se escriben identificadores. */}
          <div className="rounded-md bg-muted p-3 text-sm">
            <p className="font-medium">
              {receivables.find((row) => row.charge.id === chargeId)?.charge.description ??
                "Elige un cargo en «Por cobrar» para crear su plan de cuotas."}
            </p>
            {patientId ? (
              <Link
                to="/patients/$patientId"
                params={{ patientId }}
                search={{ tab: "cuenta" }}
                className="text-primary underline underline-offset-4"
              >
                Ver la cuenta del paciente
              </Link>
            ) : null}
          </div>
          <Field>
            <FieldLabel htmlFor="plan-count">Cuotas</FieldLabel>
            <Input
              id="plan-count"
              inputMode="numeric"
              value={installments}
              onChange={(event) => setInstallments(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="plan-first">Primer vencimiento</FieldLabel>
            <Input
              id="plan-first"
              type="date"
              value={firstDueAt}
              onChange={(event) => setFirstDueAt(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        dock={false}
        open={voidId !== null}
        title="Anular plan de cuotas"
        description="El cargo original se conserva; solo se anula su calendarización."
        error={error}
        isSubmitting={voidMutation.isPending}
        submitLabel="Anular"
        onClose={() => {
          if (!voidMutation.isPending) {
            setVoidId(null)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!reason.trim()) {
            setError("Indica el motivo de la anulación.")
            return
          }
          voidMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor="plan-void-reason">Motivo</FieldLabel>
          <Textarea id="plan-void-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </FormDrawer>
    </div>
  )
}

// --- Comisiones ---------------------------------------------------------------------

function ComisionesTab({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("finance.write")
  const members = useOrgMembers()
  const [professionalId, setProfessionalId] = useState("")
  const [base, setBase] = useState<"cobrado" | "produccion">("cobrado")
  const [rate, setRate] = useState("10")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [currency, setCurrency] = useState("PEN")
  const [preview, setPreview] = useState<CommissionPreview | null>(null)
  const [settlementId, setSettlementId] = useState<string | null>(null)
  const [voidSettlement, setVoidSettlement] = useState(false)
  const [voidReason, setVoidReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [baseline, setBaseline] = useState({ professionalId: "", base: "cobrado", rate: "10" })
  const dirty = !sameDraft({ professionalId, base, rate }, baseline)
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const rulesQuery = useQuery({ queryKey: ["finance-rules"], queryFn: fetchCommissionRules })
  const settlementsQuery = useQuery({ queryKey: ["finance-settlements"], queryFn: fetchSettlements })
  const settlementQuery = useQuery({
    queryKey: ["finance-settlement", settlementId],
    queryFn: () => fetchSettlementDetail(settlementId as string),
    enabled: settlementId !== null,
  })


  const memberName = (userId: string) =>
    members.find((m) => m.userId === userId)?.user.name ?? userId.slice(0, 8)

  const ruleMutation = useMutation({
    mutationFn: (submitted: { professionalId: string; base: "cobrado" | "produccion"; rate: string }) => {
      const percent = Number(submitted.rate.replace(",", "."))
      if (!Number.isFinite(percent) || percent < 0 || percent > 100)
        throw new Error("Tasa inválida")
      return upsertRuleApi({
        professionalUserId: submitted.professionalId,
        base: submitted.base,
        rateBps: Math.round(percent * 100),
      })
    },
    onSuccess: (_result, submitted) => {
      setBaseline(submitted)
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ["finance-rules"] })
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const previewMutation = useMutation({
    mutationFn: () =>
      previewCommissionsApi({ professionalUserId: professionalId, base, from, to, currency }),
    onSuccess: (result) => {
      setPreview(result.data)
      setError(null)
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const settleMutation = useMutation({
    mutationFn: () =>
      settleCommissionsApi({ professionalUserId: professionalId, base, from, to, currency }),
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ["finance-settlements"] })
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const voidSettlementMutation = useMutation({
    mutationFn: () => voidSettlementApi(settlementId as string, voidReason),
    onSuccess: () => {
      setVoidSettlement(false)
      setVoidReason("")
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ["finance-settlements"] })
      void queryClient.invalidateQueries({ queryKey: ["finance-settlement", settlementId] })
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  if (
    (rulesQuery.isError && isForbidden(rulesQuery.error)) ||
    (settlementsQuery.isError && isForbidden(settlementsQuery.error))
  ) {
    return <AccessDenied message="Tu rol no tiene permiso de finanzas." />
  }

  const rules = rulesQuery.data?.data ?? []
  const settlements = settlementsQuery.data?.data ?? []

  return (
    <div className="flex flex-col gap-6">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <section className="flex flex-col gap-2">
        <h3 className="text-base font-semibold">Reglas por profesional</h3>
        <p className="text-sm text-muted-foreground">
          La base es explícita: sobre lo cobrado o sobre lo producido. La tasa se guarda en
          puntos básicos exactos.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field>
            <FieldLabel htmlFor="rule-prof">Profesional</FieldLabel>
            <select
              id="rule-prof"
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={professionalId}
              onChange={(event) => setProfessionalId(event.target.value)}
            >
              <option value="">Seleccionar</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.user.name} ({m.role})
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="rule-base">Base</FieldLabel>
            <select
              id="rule-base"
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={base}
              onChange={(event) => setBase(event.target.value as "cobrado" | "produccion")}
            >
              <option value="cobrado">Cobrado</option>
              <option value="produccion">Producción</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="rule-rate">Tasa %</FieldLabel>
            <Input
              id="rule-rate"
              inputMode="decimal"
              className="w-24"
              value={rate}
              onChange={(event) => setRate(event.target.value)}
            />
          </Field>
          {canWrite ? (
            <Button
              disabled={ruleMutation.isPending}
              onClick={() => {
                if (!professionalId) {
                  setError("Elige el profesional de la regla.")
                  return
                }
                ruleMutation.mutate({ professionalId, base, rate })
              }}
            >
              Guardar regla
            </Button>
          ) : null}
        </div>
        <ul className="flex flex-col divide-y rounded-md border bg-card">
          {rules.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
              <span className="font-medium">{memberName(rule.professionalUserId)}</span>
              <Badge>{rule.base}</Badge>
              <span>{rule.rateBps / 100} %</span>
              {!rule.isActive ? <Badge>Inactiva</Badge> : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-base font-semibold">Liquidar periodo</h3>
        <div className="flex flex-wrap items-end gap-2">
          <Field>
            <FieldLabel htmlFor="settle-from">Desde</FieldLabel>
            <Input id="settle-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="settle-to">Hasta</FieldLabel>
            <Input id="settle-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="settle-currency">Moneda</FieldLabel>
            <select
              id="settle-currency"
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              <option value="PEN">PEN</option>
              <option value="USD">USD</option>
            </select>
          </Field>
          <Button
            variant="outline"
            onClick={() => {
              if (!professionalId || !from || !to) {
                setError("Elige profesional y periodo para la vista previa.")
                return
              }
              previewMutation.mutate()
            }}
          >
            Vista previa
          </Button>
          {canWrite ? (
            <Button
              onClick={() => {
                if (!professionalId || !from || !to) {
                  setError("Elige profesional y periodo para liquidar.")
                  return
                }
                settleMutation.mutate()
              }}
            >
              Liquidar
            </Button>
          ) : null}
        </div>
        {preview ? (
          <div className="rounded-md border bg-card px-4 py-3">
            <p className="text-sm font-medium">
              Base {formatMoney(preview.baseCents, currency)} · comisión{" "}
              {formatMoney(preview.commissionCents, currency)}
            </p>
            <ul className="mt-2 flex flex-col divide-y">
              {preview.lines.map((line, index) => (
                <li key={`${line.chargeId ?? "s"}-${line.paymentId ?? "s"}-${index}`} className="py-1 text-sm">
                  {line.description} · base {formatMoney(line.baseCents, currency)} ·{" "}
                  {line.rateBps / 100} % → {formatMoney(line.commissionCents, currency)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-base font-semibold">Liquidaciones</h3>
        {settlements.length === 0 ? (
          <EmptyState
            title="Sin liquidaciones"
            description="Al liquidar, las líneas trazables quedan congeladas para consulta posterior."
          />
        ) : (
          <ul className="flex flex-col divide-y rounded-md border bg-card">
            {settlements.map((settlement) => (
              <li key={settlement.id}>
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-2 px-4 py-2 text-left hover:bg-muted"
                  onClick={() => setSettlementId(settlement.id)}
                >
                  <Badge>{settlement.status}</Badge>
                  <span className="font-medium">{memberName(settlement.professionalUserId)}</span>
                  <span className="text-sm text-muted-foreground">
                    {settlement.periodFrom} al {settlement.periodTo} · {settlement.base}
                  </span>
                  <span className="text-sm font-medium">
                    {formatMoney(settlement.commissionCents, settlement.currency)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {settlementQuery.data ? (
          <div className="rounded-md border bg-card px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">
                Detalle · base {formatMoney(settlementQuery.data.data.settlement.baseCents, settlementQuery.data.data.settlement.currency)} ·
                comisión {formatMoney(settlementQuery.data.data.settlement.commissionCents, settlementQuery.data.data.settlement.currency)}
              </p>
              {canWrite && settlementQuery.data.data.settlement.status === "liquidada" ? (
                <Button variant="ghost" onClick={() => setVoidSettlement(true)}>
                  Anular liquidación
                </Button>
              ) : null}
            </div>
            <ul className="mt-2 flex flex-col divide-y">
              {settlementQuery.data.data.lines.map((line, index) => (
                <li key={index} className="py-1 text-sm">
                  {line.description} · base{" "}
                  {formatMoney(line.baseCents, settlementQuery.data.data.settlement.currency)} →{" "}
                  {formatMoney(line.commissionCents, settlementQuery.data.data.settlement.currency)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <FormDrawer
        dock={false}
        open={voidSettlement}
        title="Anular liquidación"
        description="Las líneas congeladas se conservan como histórico de la anulación."
        error={error}
        isSubmitting={voidSettlementMutation.isPending}
        submitLabel="Anular"
        onClose={() => {
          if (!voidSettlementMutation.isPending) {
            setVoidSettlement(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!voidReason.trim()) {
            setError("Indica el motivo de la anulación.")
            return
          }
          voidSettlementMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor="settlement-void-reason">Motivo</FieldLabel>
          <Textarea
            id="settlement-void-reason"
            value={voidReason}
            onChange={(event) => setVoidReason(event.target.value)}
          />
        </Field>
      </FormDrawer>
    </div>
  )
}

// --- Resumen ----------------------------------------------------------------------

function ResumenTab() {
  const overviewQuery = useQuery({ queryKey: ["finance-overview"], queryFn: fetchFinanceOverview })
  if (overviewQuery.isError && isForbidden(overviewQuery.error)) {
    return <AccessDenied message="Tu rol no tiene permiso de finanzas." />
  }
  if (overviewQuery.isPending) return <p className="text-sm text-muted-foreground">Cargando resumen…</p>
  if (overviewQuery.isError) {
    return <p className="text-sm text-destructive">{financeErrorMessage(overviewQuery.error)}</p>
  }
  const overview = overviewQuery.data.data
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {overview.openShifts} turno(s) abierto(s) · {overview.shifts} turno(s) en total
      </p>
      {overview.byCurrency.length === 0 ? (
        <EmptyState
          title="Sin movimiento"
          description="Abre un turno y registra cobros y gastos para ver el resumen por moneda."
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {overview.byCurrency.map((row) => (
            <li key={row.currency} className="rounded-md border bg-card px-4 py-3">
              <p className="font-semibold">{row.currency}</p>
              <dl className="mt-2 flex flex-col gap-1 text-sm">
                <div className="flex justify-between">
                  <dt>Ingresos en caja</dt>
                  <dd>{formatMoney(row.ingresosCents, row.currency)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Egresos en caja</dt>
                  <dd>{formatMoney(row.egresosCents, row.currency)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Balance de caja</dt>
                  <dd className="font-medium">{formatMoney(row.balanceCents, row.currency)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Gastos registrados</dt>
                  <dd>{formatMoney(row.gastosCents, row.currency)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Por cobrar</dt>
                  <dd className="font-medium">{formatMoney(row.porCobrarCents, row.currency)}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
