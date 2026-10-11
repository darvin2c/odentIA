/**
 * Cobrar en un paso: qué paga, cuánto y con qué medio. Un solo formulario que
 * llama al cobro atómico (`POST /patients/:id/collect`); el servidor reparte,
 * consume el saldo a favor solo y devuelve el ticket con número único.
 * Sin datos clínicos: solo conceptos económicos pendientes.
 *
 * Desde aquí también se agrega otro concepto (cargo manual de caja), se
 * aplica una promoción vigente al concepto con servicio (el precio lo resuelve
 * el servidor) y se aplica solo el saldo a favor sin medios. El responsable
 * que paga sale de sus responsabilidades vigentes, no de todos los contactos.
 *
 * Moneda de la clínica (prop requerida) y locale del perfil; dinero con el
 * módulo compartido `@odentia/clinical`. Nada fijo.
 */
import { formatMoney, formatMoneyInput, parseMoney } from "@odentia/clinical"
import { Badge, Button, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import { EmptyState, FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { ChoiceSelect } from "../ui/choice-select"
import { apiFetch } from "../../lib/api"
import { fetchBudgets } from "../../lib/budgets"
import { RESPONSIBILITY_KIND_LABELS } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import {
  CASH_TYPE_CODE,
  collectApi,
  createManualChargeApi,
  editChargeConceptApi,
  fetchPatientAccount3,
  fetchPaymentMethods,
  fetchActivePromotions,
  fetchResponsibilities,
  voidChargeApi,
  type AccountPendingItem,
  type CollectResultBody,
  type PromotionOption,
} from "../../lib/finance-collect"
import { collectErrorMessage } from "../../lib/finance"

const MAX_REASON = 2000

const PAYER_KINDS = ["responsable_economico", "representante_legal"] as const

interface MedioLine {
  key: number
  paymentMethodId: string
  amountText: string
  reference: string
}

/** Lectura de formulario: null si el texto no es un importe válido. */
function parseOrNull(raw: string, currency: string, locale: string): number | null {
  try {
    return parseMoney(raw, currency, locale)
  } catch {
    return null
  }
}

export function CollectDrawer({
  patientId,
  patientName,
  branchId,
  currency,
  presetChargeIds,
  locale,
  open,
  onClose,
  onCollected,
}: {
  patientId: string | null
  patientName?: string
  branchId: string
  /** Moneda de la clínica: el servidor solo cobra conceptos en ella. */
  currency: string
  presetChargeIds?: string[]
  locale: string
  open: boolean
  onClose: () => void
  onCollected: (result: CollectResultBody, patientId: string) => void
}): React.JSX.Element {
  const uid = useRef(`cobrar-${Math.random().toString(36).slice(2)}`).current
  const queryClient = useQueryClient()
  const canWrite = usePermission("finance.write")

  const [search, setSearch] = useState("")
  const [chosenId, setChosenId] = useState<string | null>(null)
  const [chosenName, setChosenName] = useState("")
  const effectiveId = patientId ?? chosenId

  const [selected, setSelected] = useState<string[]>([])
  const [selectInit, setSelectInit] = useState(false)
  const [advanceMode, setAdvanceMode] = useState(false)
  const [advanceText, setAdvanceText] = useState("")
  const [medios, setMedios] = useState<MedioLine[]>([])
  const [mediosTouched, setMediosTouched] = useState(false)
  const [cashReceived, setCashReceived] = useState("")
  const [payerContactId, setPayerContactId] = useState("")
  const [editing, setEditing] = useState<{ charge: AccountPendingItem; amountText: string; description: string } | null>(null)
  const [removing, setRemoving] = useState<AccountPendingItem | null>(null)
  const [adding, setAdding] = useState(false)
  const [newDescription, setNewDescription] = useState("")
  const [newAmount, setNewAmount] = useState("")
  const [promo, setPromo] = useState<{ charge: AccountPendingItem; serviceId: string } | null>(null)
  const [promotionId, setPromotionId] = useState("")
  const [promoFinal, setPromoFinal] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const keySeq = useRef(1)

  // Sesión nueva al abrir: borrador limpio e idempotencia nueva.
  useEffect(() => {
    if (!open) return
    setSearch("")
    setChosenId(null)
    setChosenName("")
    setSelected([])
    setSelectInit(false)
    setAdvanceMode(false)
    setAdvanceText("")
    setMedios([])
    setMediosTouched(false)
    setCashReceived("")
    setPayerContactId("")
    setEditing(null)
    setRemoving(null)
    setAdding(false)
    setNewDescription("")
    setNewAmount("")
    setPromo(null)
    setPromotionId("")
    setPromoFinal("")
    setReason("")
    setError(null)
    setDirty(false)
    setRequestId(crypto.randomUUID())
  }, [open, patientId])

  const account = useQuery({
    queryKey: ["patient-account3", effectiveId],
    queryFn: () => fetchPatientAccount3(effectiveId as string),
    enabled: open && effectiveId !== null,
  })
  const methods = useQuery({
    queryKey: ["org-payment-methods"],
    queryFn: fetchPaymentMethods,
    enabled: open,
  })
  const responsibilities = useQuery({
    queryKey: ["patient-responsibilities", effectiveId],
    queryFn: () => fetchResponsibilities(effectiveId as string),
    enabled: open && effectiveId !== null,
  })
  const budgets = useQuery({
    queryKey: ["budgets", effectiveId],
    queryFn: () => fetchBudgets(effectiveId as string),
    enabled: open && effectiveId !== null,
  })
  const promoOptions = useQuery({
    queryKey: ["active-promotions", promo?.serviceId],
    queryFn: () => fetchActivePromotions(promo!.serviceId),
    enabled: open && promo !== null,
  })
  const searchQuery = useQuery({
    queryKey: ["patients-search", search.trim()],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; displayName: string }> }>(
        `/api/patients?q=${encodeURIComponent(search.trim())}&limit=10`,
      ),
    enabled: open && patientId === null && search.trim().length >= 2,
    retry: false,
  })

  const data = account.data?.data ?? null
  const favor = data?.byCurrency.find((row) => row.currency === currency)?.aFavor ?? 0
  const pending = useMemo(
    () =>
      (data?.pendiente ?? []).filter((item) => item.saldoCents > 0 && item.currency === currency),
    [data, currency],
  )
  const otherCurrencyCount = useMemo(
    () => (data?.pendiente ?? []).filter((item) => item.saldoCents > 0 && item.currency !== currency).length,
    [data, currency],
  )
  const methodList = methods.data?.data ?? []
  const serviceByBudgetItem = useMemo(() => {
    const map = new Map<string, string>()
    for (const budget of budgets.data?.data ?? []) {
      for (const line of budget.items) {
        if (line.serviceId) map.set(line.id, line.serviceId)
      }
    }
    return map
  }, [budgets.data])
  const serviceOf = (item: AccountPendingItem): string | null =>
    (item.budgetItemId && serviceByBudgetItem.get(item.budgetItemId)) || null

  // Selección inicial: lo pendiente o lo pedido por quien abrió el cobro.
  // Sin pendiente, el cobro nace como adelanto.
  useEffect(() => {
    if (!open || selectInit || !data) return
    const ids = new Set(pending.map((item) => item.chargeId))
    const preset = (presetChargeIds ?? []).filter((id) => ids.has(id))
    setSelected(preset.length > 0 ? preset : [...ids])
    if (pending.length === 0) setAdvanceMode(true)
    setSelectInit(true)
  }, [open, selectInit, data, pending, presetChargeIds])

  const selectedItems = pending.filter((item) => selected.includes(item.chargeId))
  const selectedTotal = selectedItems.reduce((sum, item) => sum + item.saldoCents, 0)
  const autoCredit = advanceMode ? 0 : Math.min(favor, selectedTotal)
  const advanceCents = advanceMode ? (parseOrNull(advanceText, currency, locale) ?? 0) : 0
  const remainder = advanceMode ? advanceCents : Math.max(0, selectedTotal - autoCredit)
  const creditOnly = !advanceMode && selected.length > 0 && remainder <= 0

  const methodById = (id: string) => methodList.find((item) => item.id === id)
  const lineCents = (text: string) => parseOrNull(text, currency, locale) ?? 0
  const cashPortion = medios.reduce(
    (sum, line) =>
      sum + (methodById(line.paymentMethodId)?.typeCode === CASH_TYPE_CODE ? lineCents(line.amountText) : 0),
    0,
  )
  const mediosTotal = medios.reduce((sum, line) => sum + lineCents(line.amountText), 0)
  const hasCash = medios.some(
    (line) => methodById(line.paymentMethodId)?.typeCode === CASH_TYPE_CODE,
  )
  const receivedCents = hasCash ? parseOrNull(cashReceived, currency, locale) : null
  const change = hasCash && receivedCents !== null ? receivedCents - cashPortion : null

  // Medio por defecto: cubre el restante hasta que la persona lo toca.
  useEffect(() => {
    if (!open || mediosTouched || methodList.length === 0) return
    if (remainder <= 0 && !advanceMode) {
      setMedios([])
      return
    }
    const cash = methodList.find((item) => item.typeCode === CASH_TYPE_CODE) ?? methodList[0]
    setMedios([
      {
        key: keySeq.current++,
        paymentMethodId: cash.id,
        amountText: formatMoneyInput(remainder, currency, locale),
        reference: "",
      },
    ])
  }, [open, mediosTouched, methodList, currency, locale, remainder, advanceMode])

  const invalidateAccount = (id: string) => {
    void queryClient.invalidateQueries({ queryKey: ["patient-account3", id] })
    void queryClient.invalidateQueries({ queryKey: ["finance-debts"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-cash"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-movements"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-closures"] })
  }

  const createMutation = useMutation({
    mutationFn: () =>
      createManualChargeApi(effectiveId as string, {
        branchId,
        description: newDescription.trim(),
        amountCents: parseOrNull(newAmount, currency, locale) as number,
      }),
    onSuccess: (result) => {
      setSelected((current) => [...current, result.data.id])
      setAdding(false)
      setNewDescription("")
      setNewAmount("")
      setError(null)
      setDirty(true)
      invalidateAccount(effectiveId as string)
    },
    onError: (err) => setError(collectErrorMessage(err)),
  })

  const editMutation = useMutation({
    mutationFn: () => {
      const charge = editing!.charge
      const body: { amountCents?: number; description?: string; reason: string } = {
        reason: reason.trim(),
      }
      const cents = parseOrNull(editing!.amountText, currency, locale) as number
      if (cents !== charge.totalCents) body.amountCents = cents
      if (editing!.description.trim() && editing!.description.trim() !== charge.description) {
        body.description = editing!.description.trim()
      }
      return editChargeConceptApi(effectiveId as string, charge.chargeId, body)
    },
    onSuccess: () => {
      setEditing(null)
      setReason("")
      setError(null)
      invalidateAccount(effectiveId as string)
    },
    onError: (err) => setError(collectErrorMessage(err)),
  })

  const promoMutation = useMutation({
    mutationFn: () => {
      const body: { promotionId: string; amountCents?: number; reason: string } = {
        promotionId,
        reason: reason.trim(),
      }
      const selectedPromo = (promoOptions.data ?? []).find((item) => item.id === promotionId)
      const item = selectedPromo?.items.find((entry) => entry.serviceId === promo!.serviceId)
      if (item?.mode === "from") {
        body.amountCents = parseOrNull(promoFinal, currency, locale) as number
      }
      return editChargeConceptApi(effectiveId as string, promo!.charge.chargeId, body)
    },
    onSuccess: () => {
      setPromo(null)
      setPromotionId("")
      setPromoFinal("")
      setReason("")
      setError(null)
      invalidateAccount(effectiveId as string)
    },
    onError: (err) => setError(collectErrorMessage(err)),
  })

  const removeMutation = useMutation({
    mutationFn: () => voidChargeApi(effectiveId as string, removing!.chargeId, reason.trim()),
    onSuccess: () => {
      setSelected((current) => current.filter((id) => id !== removing!.chargeId))
      setRemoving(null)
      setReason("")
      setError(null)
      invalidateAccount(effectiveId as string)
    },
    onError: (err) => setError(collectErrorMessage(err)),
  })

  const collectMutation = useMutation({
    mutationFn: async () => {
      const id = effectiveId as string
      const base = {
        branchId,
        payerContactId: payerContactId || null,
        requestId,
      }
      // Sin medios el servidor consume solo el saldo a favor.
      const payments =
        creditOnly || medios.length === 0
          ? undefined
          : medios.map((line) => ({
              paymentMethodId: line.paymentMethodId,
              amountCents: parseOrNull(line.amountText, currency, locale) as number,
              ...(line.reference.trim() ? { reference: line.reference.trim() } : {}),
            }))
      const cash = hasCash && !creditOnly ? { cashReceivedCents: receivedCents as number } : {}
      const result = advanceMode
        ? await collectApi(id, { ...base, advanceCents, payments, ...cash })
        : await collectApi(id, { ...base, chargeIds: selected, ...(payments ? { payments } : {}), ...cash })
      return result.data
    },
    onSuccess: (result) => {
      invalidateAccount(effectiveId as string)
      setDirty(false)
      setRequestId(crypto.randomUUID())
      onCollected(result, effectiveId as string)
      onClose()
    },
    onError: (err) => setError(collectErrorMessage(err)),
  })

  const busy =
    createMutation.isPending ||
    editMutation.isPending ||
    promoMutation.isPending ||
    removeMutation.isPending ||
    collectMutation.isPending
  const modalOpen = editing !== null || removing !== null || adding || promo !== null
  const displayName = patientId !== null ? (patientName ?? "") : chosenName
  const payerOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const row of responsibilities.data?.data ?? []) {
      if (!row.isCurrent) continue
      if (!(PAYER_KINDS as readonly string[]).includes(row.kind)) continue
      const label = RESPONSIBILITY_KIND_LABELS[row.kind as keyof typeof RESPONSIBILITY_KIND_LABELS] ?? row.kind
      seen.set(row.contactId, `${row.contact.displayName} · ${label}`)
    }
    return [...seen.entries()].map(([contactId, label]) => ({ contactId, label }))
  }, [responsibilities.data])
  const selectedPromo: PromotionOption | undefined = (promoOptions.data ?? []).find(
    (item) => item.id === promotionId,
  )
  const selectedPromoItem = selectedPromo?.items.find((entry) => entry.serviceId === promo?.serviceId)
  const promoNeedsFinal = selectedPromoItem?.mode === "from"

  const submitCollect = () => {
    if (!canWrite) {
      setError("Tu rol no tiene permiso de caja.")
      return
    }
    if (!effectiveId) {
      setError("Busca y elige al paciente que paga.")
      return
    }
    if (advanceMode) {
      if (advanceCents <= 0) {
        setError("Indica el importe del adelanto.")
        return
      }
    } else if (selected.length === 0) {
      setError("Elige al menos un concepto o registra un adelanto.")
      return
    }
    if (!creditOnly) {
      if (medios.length === 0 || remainder <= 0) {
        setError(
          advanceMode
            ? "Agrega al menos un medio de pago."
            : "El saldo a favor cubre todo: aplica el saldo o agrega medios.",
        )
        return
      }
      for (const line of medios) {
        const cents = parseOrNull(line.amountText, currency, locale)
        if (cents === null || cents <= 0) {
          setError("Revisa los importes de cada medio de pago.")
          return
        }
        const method = methodById(line.paymentMethodId)
        if (!method) {
          setError("Elige el medio de pago de cada línea.")
          return
        }
        if (method.typeCode !== CASH_TYPE_CODE && !line.reference.trim()) {
          setError(`El medio ${method.name} pide número de operación.`)
          return
        }
      }
      if (mediosTotal > remainder) {
        setError(
          `Los medios suman ${formatMoney(mediosTotal, currency, locale)} y superan lo seleccionado (${formatMoney(remainder, currency, locale)}).`,
        )
        return
      }
      if (hasCash && (receivedCents === null || (change !== null && change < 0))) {
        setError("Indica cuánto efectivo recibes; debe cubrir la parte en efectivo.")
        return
      }
    }
    setError(null)
    collectMutation.mutate()
  }

  return (
    <>
      <FormDrawer
        open={open}
        title={displayName ? `Cobrar · ${displayName}` : "Cobrar"}
        description="Qué paga, cuánto y con qué medio. Puedes cobrar una parte: el resto queda por cobrar. El saldo a favor se descuenta solo."
        error={modalOpen ? null : error}
        isSubmitting={collectMutation.isPending}
        isLoading={Boolean(effectiveId) && account.isPending}
        isDirty={dirty}
        submitLabel={
          creditOnly
            ? "Aplicar saldo a favor"
            : mediosTotal > 0 && mediosTotal !== remainder
              ? `Cobrar ${formatMoney(mediosTotal, currency, locale)}`
              : remainder > 0
                ? `Cobrar ${formatMoney(remainder, currency, locale)}`
                : "Cobrar"
        }
        submitDisabled={!canWrite || modalOpen}
        onClose={() => {
          if (!busy) onClose()
        }}
        onSubmit={(event) => {
          event.preventDefault()
          submitCollect()
        }}
      >
        <div className="flex flex-col gap-5">
          {patientId === null ? (
            <Field>
              <FieldLabel htmlFor={`${uid}-patient`}>Paciente que paga</FieldLabel>
              <Input
                id={`${uid}-patient`}
                placeholder="Escribe al menos 2 letras del nombre"
                value={chosenId ? chosenName : search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  setChosenId(null)
                  setChosenName("")
                  setDirty(true)
                }}
              />
              {!chosenId && search.trim().length >= 2 ? (
                <ul className="mt-1 flex max-h-40 flex-col divide-y overflow-y-auto rounded-md border">
                  {searchQuery.data?.data.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
                        onClick={() => {
                          setChosenId(row.id)
                          setChosenName(row.displayName)
                          setDirty(true)
                        }}
                      >
                        {row.displayName}
                      </button>
                    </li>
                  )) ?? null}
                  {searchQuery.data?.data.length === 0 && !searchQuery.isPending ? (
                    <li className="px-3 py-2 text-sm text-muted-foreground">Sin resultados.</li>
                  ) : null}
                </ul>
              ) : null}
            </Field>
          ) : null}

          {!effectiveId ? (
            <EmptyState
              title="Elige al paciente"
              description="Busca por nombre para ver lo pendiente y cobrar en un paso."
            />
          ) : account.isError ? (
            <div className="flex flex-col gap-2">
              <p role="alert" className="text-sm text-destructive">
                {collectErrorMessage(account.error)}
              </p>
              <Button type="button" variant="outline" onClick={() => void account.refetch()}>
                Reintentar
              </Button>
            </div>
          ) : data ? (
            <>
              <section className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Qué paga</h3>
                  {canWrite ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setNewDescription("")
                        setNewAmount("")
                        setError(null)
                        setAdding(true)
                      }}
                    >
                      Agregar otro concepto
                    </Button>
                  ) : null}
                </div>
                {pending.length === 0 && !advanceMode ? (
                  <p className="text-sm text-muted-foreground">
                    Sin conceptos pendientes en {currency}. Puedes registrar un adelanto.
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y rounded-md border">
                    {pending.map((item) => {
                      const checked = selected.includes(item.chargeId)
                      const serviceId = serviceOf(item)
                      return (
                        <li key={item.chargeId} className="flex flex-col gap-1 px-3 py-2">
                          <label className="flex cursor-pointer items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={checked}
                              disabled={advanceMode}
                              onChange={() => {
                                setSelected((current) =>
                                  checked
                                    ? current.filter((id) => id !== item.chargeId)
                                    : [...current, item.chargeId],
                                )
                                setDirty(true)
                              }}
                            />
                            <span className="flex-1 text-sm">
                              <span className="font-medium">{item.description}</span>
                              {item.promotionName ? (
                                <Badge className="ml-2">{item.promotionName}</Badge>
                              ) : null}
                              <span className="block text-xs text-muted-foreground">
                                Costó {formatMoney(item.totalCents, item.currency, locale)} · pagó{" "}
                                {formatMoney(item.paidCents, item.currency, locale)}
                              </span>
                            </span>
                            <span className="text-sm font-semibold tabular-nums">
                              {formatMoney(item.saldoCents, item.currency, locale)}
                            </span>
                          </label>
                          {canWrite && !advanceMode ? (
                            <span className="flex flex-wrap gap-2 pl-6">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setEditing({
                                    charge: item,
                                    amountText: formatMoneyInput(item.totalCents, currency, locale),
                                    description: item.description,
                                  })
                                  setReason("")
                                  setError(null)
                                }}
                              >
                                Nuevo importe
                              </Button>
                              {serviceId && !item.promotionName ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setPromo({ charge: item, serviceId })
                                    setPromotionId("")
                                    setPromoFinal("")
                                    setReason("")
                                    setError(null)
                                  }}
                                >
                                  Aplicar promoción
                                </Button>
                              ) : null}
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setRemoving(item)
                                  setReason("")
                                  setError(null)
                                }}
                              >
                                Quitar concepto
                              </Button>
                            </span>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                )}
                {otherCurrencyCount > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {otherCurrencyCount} {otherCurrencyCount === 1 ? "concepto en otra moneda no entra" : "conceptos en otra moneda no entran"} a este cobro.
                  </p>
                ) : null}
                {pending.length > 0 ? (
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={advanceMode}
                      onChange={() => {
                        setAdvanceMode((value) => !value)
                        setDirty(true)
                      }}
                    />
                    Es un adelanto (sin concepto, queda a favor)
                  </label>
                ) : null}
                {advanceMode ? (
                  <Field>
                    <FieldLabel htmlFor={`${uid}-advance`}>Importe del adelanto</FieldLabel>
                    <Input
                      id={`${uid}-advance`}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={advanceText}
                      onChange={(event) => {
                        setAdvanceText(event.target.value)
                        setDirty(true)
                      }}
                    />
                  </Field>
                ) : null}
                {favor > 0 && !advanceMode ? (
                  <p className="text-sm text-muted-foreground">
                    Tiene {formatMoney(favor, currency, locale)} a favor: se descuenta solo
                    al cobrar
                    {autoCredit > 0 ? ` (−${formatMoney(autoCredit, currency, locale)})` : ""}.
                  </p>
                ) : null}
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">Con qué medio</h3>
                {creditOnly ? (
                  <p className="rounded-md bg-muted p-3 text-sm">
                    El saldo a favor cubre {formatMoney(selectedTotal, currency, locale)}: al
                    confirmar se aplica sin medios de pago.
                  </p>
                ) : (
                  <>
                    {methods.isError ? (
                      <div className="flex flex-col gap-2">
                        <p role="alert" className="text-sm text-destructive">
                          {collectErrorMessage(methods.error)}
                        </p>
                        <Button type="button" variant="outline" onClick={() => void methods.refetch()}>
                          Reintentar
                        </Button>
                      </div>
                    ) : (
                      <ul className="flex flex-col gap-3">
                        {medios.map((line, index) => {
                          const method = methodById(line.paymentMethodId)
                          const needsRef = method !== undefined && method.typeCode !== CASH_TYPE_CODE
                          return (
                            <li key={line.key} className="flex flex-col gap-2 rounded-md border p-3">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-medium">Medio {index + 1}</span>
                                {medios.length > 1 ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      setMedios((current) =>
                                        current.filter((item) => item.key !== line.key),
                                      )
                                      setDirty(true)
                                    }}
                                  >
                                    Quitar
                                  </Button>
                                ) : null}
                              </div>
                              <Field>
                                <FieldLabel htmlFor={`${uid}-medio-${line.key}`}>Medio de pago</FieldLabel>
                                <ChoiceSelect
                                  id={`${uid}-medio-${line.key}`}
                                  className="w-full"
                                  value={line.paymentMethodId}
                                  onChange={(event) => {
                                    setMedios((current) =>
                                      current.map((item) =>
                                        item.key === line.key
                                          ? { ...item, paymentMethodId: event.target.value }
                                          : item,
                                      ),
                                    )
                                    setDirty(true)
                                  }}
                                >
                                  <option value="">Seleccionar medio</option>
                                  {methodList.map((item) => (
                                    <option key={item.id} value={item.id}>
                                      {item.name}
                                    </option>
                                  ))}
                                </ChoiceSelect>
                              </Field>
                              <Field>
                                <FieldLabel htmlFor={`${uid}-importe-${line.key}`}>Importe</FieldLabel>
                                <Input
                                  id={`${uid}-importe-${line.key}`}
                                  inputMode="decimal"
                                  placeholder="0.00"
                                  value={line.amountText}
                                  onChange={(event) => {
                                    setMedios((current) =>
                                      current.map((item) =>
                                        item.key === line.key
                                          ? { ...item, amountText: event.target.value }
                                          : item,
                                      ),
                                    )
                                    setMediosTouched(true)
                                    setDirty(true)
                                  }}
                                />
                              </Field>
                              {needsRef ? (
                                <Field>
                                  <FieldLabel htmlFor={`${uid}-ref-${line.key}`}>
                                    Número de operación
                                  </FieldLabel>
                                  <Input
                                    id={`${uid}-ref-${line.key}`}
                                    value={line.reference}
                                    onChange={(event) => {
                                      setMedios((current) =>
                                        current.map((item) =>
                                          item.key === line.key
                                            ? { ...item, reference: event.target.value }
                                            : item,
                                        ),
                                      )
                                      setDirty(true)
                                    }}
                                  />
                                </Field>
                              ) : null}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setMedios((current) => [
                          ...current,
                          {
                            key: keySeq.current++,
                            paymentMethodId: "",
                            amountText: "",
                            reference: "",
                          },
                        ])
                        setMediosTouched(true)
                        setDirty(true)
                      }}
                    >
                      Añadir otro medio
                    </Button>
                    <p className="text-sm text-muted-foreground">
                      Medios suman {formatMoney(mediosTotal, currency, locale)} · queda por cobrar{" "}
                      {formatMoney(Math.max(0, remainder - mediosTotal), currency, locale)}
                    </p>
                    {hasCash ? (
                      <div className="flex flex-col gap-2 rounded-md border p-3">
                        <Field>
                          <FieldLabel htmlFor={`${uid}-recibido`}>Efectivo recibido</FieldLabel>
                          <Input
                            id={`${uid}-recibido`}
                            inputMode="decimal"
                            placeholder="0.00"
                            value={cashReceived}
                            onChange={(event) => {
                              setCashReceived(event.target.value)
                              setDirty(true)
                            }}
                          />
                        </Field>
                        <p className="text-sm">
                          Vuelto:{" "}
                          {change === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <strong className="tabular-nums">
                              {formatMoney(change, currency, locale)}
                            </strong>
                          )}
                        </p>
                      </div>
                    ) : null}
                  </>
                )}
              </section>

              <Field>
                <FieldLabel htmlFor={`${uid}-payer`}>Responsable que paga (opcional)</FieldLabel>
                <ChoiceSelect
                  id={`${uid}-payer`}
                  className="w-full"
                  value={payerContactId}
                  onChange={(event) => {
                    setPayerContactId(event.target.value)
                    setDirty(true)
                  }}
                >
                  <option value="">Sin especificar</option>
                  {payerOptions.map((option) => (
                    <option key={option.contactId} value={option.contactId}>
                      {option.label}
                    </option>
                  ))}
                </ChoiceSelect>
                {responsibilities.isError ? (
                  <p role="alert" className="text-xs text-destructive">
                    No se pudieron cargar los responsables.{" "}
                    <button type="button" className="underline" onClick={() => void responsibilities.refetch()}>
                      Reintentar
                    </button>
                  </p>
                ) : null}
              </Field>
              <p className="text-xs text-muted-foreground">
                Entra a la caja de la sede elegida. Si algo falla a mitad del cobro, reintenta
                con el mismo código: no se duplica.
              </p>
            </>
          ) : null}
        </div>
      </FormDrawer>

      <FormDrawer
        open={adding}
        title="Agregar otro concepto"
        description="Cargo manual de caja, fuera del tarifario. Queda pendiente y seleccionado para este cobro."
        error={adding ? error : null}
        isSubmitting={createMutation.isPending}
        submitLabel="Agregar concepto"
        onClose={() => {
          if (!createMutation.isPending) {
            setAdding(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!newDescription.trim()) {
            setError("Describe el concepto.")
            return
          }
          if (parseOrNull(newAmount, currency, locale) === null) {
            setError("Indica un importe positivo válido.")
            return
          }
          createMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={`${uid}-new-desc`}>Concepto</FieldLabel>
            <Input
              id={`${uid}-new-desc`}
              maxLength={MAX_REASON}
              value={newDescription}
              onChange={(event) => setNewDescription(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-new-amount`}>Importe</FieldLabel>
            <Input
              id={`${uid}-new-amount`}
              inputMode="decimal"
              placeholder="0.00"
              value={newAmount}
              onChange={(event) => setNewAmount(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        open={editing !== null}
        title={`Nuevo importe · ${editing?.charge.description ?? ""}`}
        description="Queda registrado quién lo cambió, cuándo y por qué. Solo sin aplicaciones activas."
        error={editing ? error : null}
        isSubmitting={editMutation.isPending}
        submitLabel="Guardar cambio"
        onClose={() => {
          if (!editMutation.isPending) {
            setEditing(null)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!editing) return
          const cents = parseOrNull(editing.amountText, currency, locale)
          if (cents === null || cents <= 0) {
            setError("Indica un importe positivo válido.")
            return
          }
          const sameAmount = cents === editing.charge.totalCents
          const sameDescription =
            editing.description.trim() === "" || editing.description.trim() === editing.charge.description
          if (sameAmount && sameDescription) {
            setError("No hay cambios que guardar.")
            return
          }
          if (!reason.trim()) {
            setError("Indica el motivo del cambio.")
            return
          }
          editMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={`${uid}-edit-amount`}>Nuevo importe</FieldLabel>
            <Input
              id={`${uid}-edit-amount`}
              inputMode="decimal"
              value={editing?.amountText ?? ""}
              onChange={(event) =>
                editing &&
                setEditing({ ...editing, amountText: event.target.value })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-edit-desc`}>Concepto</FieldLabel>
            <Input
              id={`${uid}-edit-desc`}
              maxLength={MAX_REASON}
              value={editing?.description ?? ""}
              onChange={(event) =>
                editing && setEditing({ ...editing, description: event.target.value })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-edit-reason`}>Motivo</FieldLabel>
            <Textarea
              id={`${uid}-edit-reason`}
              maxLength={MAX_REASON}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        open={promo !== null}
        title={`Aplicar promoción · ${promo?.charge.description ?? ""}`}
        description="Solo promociones vigentes del servicio. El precio final lo resuelve el servidor."
        error={promo ? error : null}
        isSubmitting={promoMutation.isPending}
        isLoading={promoOptions.isPending}
        submitLabel="Aplicar promoción"
        onClose={() => {
          if (!promoMutation.isPending) {
            setPromo(null)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!promo || !promotionId) {
            setError("Elige la promoción a aplicar.")
            return
          }
          if (promoNeedsFinal && parseOrNull(promoFinal, currency, locale) === null) {
            setError("Esta promoción pide el precio final: indícalo.")
            return
          }
          if (!reason.trim()) {
            setError("Indica el motivo.")
            return
          }
          promoMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          {promoOptions.isError ? (
            <div className="flex flex-col gap-2">
              <p role="alert" className="text-sm text-destructive">
                {collectErrorMessage(promoOptions.error)}
              </p>
              <Button type="button" variant="outline" onClick={() => void promoOptions.refetch()}>
                Reintentar
              </Button>
            </div>
          ) : (promoOptions.data ?? []).length === 0 && !promoOptions.isPending ? (
            <p className="text-sm text-muted-foreground">Sin promociones vigentes para este servicio.</p>
          ) : (
            <Field>
              <FieldLabel htmlFor={`${uid}-promo`}>Promoción vigente</FieldLabel>
              <ChoiceSelect
                id={`${uid}-promo`}
                className="w-full"
                value={promotionId}
                onChange={(event) => {
                  setPromotionId(event.target.value)
                  setPromoFinal("")
                }}
              >
                <option value="">Seleccionar promoción</option>
                {(promoOptions.data ?? []).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                    {option.conditions ? ` · ${option.conditions}` : ""}
                  </option>
                ))}
              </ChoiceSelect>
            </Field>
          )}
          {promoNeedsFinal ? (
            <Field>
              <FieldLabel htmlFor={`${uid}-promo-final`}>Precio final acordado</FieldLabel>
              <Input
                id={`${uid}-promo-final`}
                inputMode="decimal"
                placeholder="0.00"
                value={promoFinal}
                onChange={(event) => setPromoFinal(event.target.value)}
              />
            </Field>
          ) : null}
          <Field>
            <FieldLabel htmlFor={`${uid}-promo-reason`}>Motivo</FieldLabel>
            <Textarea
              id={`${uid}-promo-reason`}
              maxLength={MAX_REASON}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        dock={false}
        open={removing !== null}
        title="Quitar concepto"
        description="El concepto se anula con motivo y queda en el historial; no se borra."
        error={removing ? error : null}
        isSubmitting={removeMutation.isPending}
        submitLabel="Quitar concepto"
        onClose={() => {
          if (!removeMutation.isPending) {
            setRemoving(null)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!reason.trim()) {
            setError("Indica el motivo.")
            return
          }
          removeMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-remove-reason`}>Motivo</FieldLabel>
          <Textarea
            id={`${uid}-remove-reason`}
            maxLength={MAX_REASON}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </FormDrawer>
    </>
  )
}
