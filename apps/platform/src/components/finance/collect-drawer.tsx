/**
 * Cobrar en un paso: qué paga, cuánto y con qué medio, en un solo formulario
 * que llama al cobro atómico (`POST /patients/:id/collect`). El servidor cobra
 * de lo más antiguo a lo más nuevo, usa solo el saldo a favor y devuelve el
 * ticket numerado. Sin datos clínicos: solo conceptos económicos pendientes.
 *
 * Un concepto se corrige en la misma lista: nuevo importe con motivo, quitarlo,
 * o la promoción vigente de su servicio (el precio lo resuelve el servidor).
 * Paga el paciente salvo que se elija a uno de sus responsables vigentes.
 *
 * Moneda de la clínica (prop requerida) y formato del perfil; dinero con el
 * módulo compartido `@odentia/clinical`. Nada fijo de un país.
 */
import { formatMoney, formatMoneyInput, parseMoney } from "@odentia/clinical"
import {
  Button,
  Checkbox,
  cn,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
} from "@odentia/ui"
import { EmptyState, ErrorState, FormDrawer, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { MoreHorizontal, Plus, X } from "lucide-react"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { ChoiceSelect } from "../ui/choice-select"
import { useActiveBranch } from "../../lib/active-branch"
import { fetchResponsibilities, RESPONSIBILITY_KIND_LABELS } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { collectFailureMessage, financeErrorMessage } from "../../lib/finance"
import {
  CASH_TYPE_CODE,
  collectApi,
  createManualChargeApi,
  currencySymbol,
  editChargeConceptApi,
  fetchActivePromotions,
  fetchPatientAccount3,
  fetchPaymentMethods,
  formatAmountPlain,
  searchPatientsApi,
  voidChargeApi,
  type AccountPendingItem,
  type CollectResultBody,
  type PaymentMethodOption,
  type PromotionItem,
  type PromotionOption,
} from "../../lib/finance-collect"

const MAX_REASON = 2000
const MAX_REFERENCE = 200

/** Quién puede figurar como pagador además del paciente. */
const PAYER_KINDS: readonly string[] = ["responsable_economico", "representante_legal"]

/** Lectura de formulario: null si el texto no es un importe válido. */
export function parseMoneyOrNull(raw: string, currency: string, locale: string): number | null {
  try {
    return parseMoney(raw, currency, locale)
  } catch {
    return null
  }
}

/** «el paciente» / «la paciente» según el sexo registrado; sin dato no se supone. */
export function patientNoun(sex: string | null | undefined): string {
  if (sex === "F") return "la paciente"
  if (sex === "M") return "el paciente"
  return "paciente"
}

/** Enter dentro de un bloque en línea guarda ese bloque: no envía el cobro. */
function onEnter(action: () => void) {
  return (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return
    event.preventDefault()
    action()
  }
}

/** Campo de importe con el símbolo y el formato de la clínica. */
export function MoneyInput({
  id,
  value,
  onChange,
  currency,
  locale,
  onKeyDown,
  disabled,
  autoFocus,
  invalid,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  currency: string
  locale: string
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void
  disabled?: boolean
  autoFocus?: boolean
  invalid?: boolean
  "aria-label"?: string
  "aria-describedby"?: string
}): React.JSX.Element {
  return (
    <InputGroup>
      <InputGroupAddon>{currencySymbol(currency, locale)}</InputGroupAddon>
      <InputGroupInput
        id={id}
        inputMode="decimal"
        autoComplete="off"
        className="tabular-nums"
        placeholder={formatMoneyInput(0, currency, locale)}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
    </InputGroup>
  )
}

/** Medios de pago activos como botones, en el orden que la clínica les dio. */
export function PaymentMethodButtons({
  labelId,
  methods,
  value,
  onChange,
  disabled,
}: {
  labelId: string
  methods: PaymentMethodOption[]
  value: string
  onChange: (id: string) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-2">
      {methods.map((method) => {
        const selected = method.id === value
        return (
          <Button
            key={method.id}
            type="button"
            variant={selected ? "default" : "outline"}
            aria-pressed={selected}
            disabled={disabled}
            className="min-h-10"
            onClick={() => onChange(method.id)}
          >
            {method.name}
          </Button>
        )
      })}
    </div>
  )
}

/** Un medio dentro de un cobro con varios medios. */
interface SplitLine {
  key: number
  paymentMethodId: string
  amountText: string
  reference: string
  /** Absorbe la diferencia con el importe hasta que la persona escribe el suyo. */
  auto: boolean
}

/** Con una sola línea «automática», esta completa lo que falta para el importe. */
function rebalance(
  lines: SplitLine[],
  totalCents: number | null,
  currency: string,
  locale: string,
): SplitLine[] {
  if (totalCents === null) return lines
  if (lines.filter((line) => line.auto).length !== 1) return lines
  const fixed = lines
    .filter((line) => !line.auto)
    .reduce((sum, line) => sum + (parseMoneyOrNull(line.amountText, currency, locale) ?? 0), 0)
  const rest = totalCents - fixed
  return lines.map((line) =>
    line.auto
      ? { ...line, amountText: rest > 0 ? formatMoneyInput(rest, currency, locale) : "" }
      : line,
  )
}

/** Bloque abierto bajo un concepto: corregir el importe o poner el precio de una promoción «desde». */
type Editor =
  | { kind: "amount"; chargeId: string; amountText: string; reason: string; confirmRemove: boolean }
  | {
      kind: "promo"
      chargeId: string
      promotionId: string
      promotionName: string
      floorCents: number
      amountText: string
      reason: string
    }

/** Cambio sobre un concepto: quién muestra el progreso, qué se llama y qué pasa al terminar. */
interface ConceptJob {
  target: string
  errorAt: string
  run: () => Promise<unknown>
  done?: (result: unknown) => void
}

export function CollectDrawer({
  patientId,
  patientName,
  patientDocument,
  patientSex,
  branchId,
  branchName,
  currency,
  presetChargeIds,
  locale,
  open,
  onClose,
  onCollected,
}: {
  patientId: string | null
  patientName?: string
  /** Documento ya conocido por quien abre el cobro («DNI 45678912»). */
  patientDocument?: string | null
  /** Sexo registrado, solo para escribir «el/la paciente». */
  patientSex?: string | null
  branchId: string
  /** Nombre de la sede; si no llega se busca entre las sedes activas. */
  branchName?: string
  /** Moneda de la clínica: el servidor solo cobra conceptos en ella. */
  currency: string
  presetChargeIds?: string[]
  locale: string
  open: boolean
  onClose: () => void
  onCollected: (result: CollectResultBody, patientId: string) => void
}): React.JSX.Element {
  const uid = useId()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canWrite = usePermission("finance.write")
  const canConfigure = usePermission("settings.write")
  const sede = useActiveBranch()

  const [search, setSearch] = useState("")
  const [chosen, setChosen] = useState<{
    id: string
    name: string
    document: string | null
    sex: string | null
  } | null>(null)
  const effectiveId = patientId ?? chosen?.id ?? null

  const [selected, setSelected] = useState<string[]>([])
  const [selectInit, setSelectInit] = useState(false)
  const [advanceMode, setAdvanceMode] = useState(false)
  const [amountText, setAmountText] = useState("")
  const [amountTouched, setAmountTouched] = useState(false)
  const [methodId, setMethodId] = useState("")
  const [reference, setReference] = useState("")
  const [split, setSplit] = useState<SplitLine[] | null>(null)
  const [cashReceived, setCashReceived] = useState("")
  const [payerContactId, setPayerContactId] = useState("")
  const [payerOpen, setPayerOpen] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [adding, setAdding] = useState<{ description: string; amountText: string } | null>(null)
  const [inlineError, setInlineError] = useState<{ at: string; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const keySeq = useRef(1)

  const resetDraft = useCallback(() => {
    setSelected([])
    setSelectInit(false)
    setAdvanceMode(false)
    setAmountText("")
    setAmountTouched(false)
    setMethodId("")
    setReference("")
    setSplit(null)
    setCashReceived("")
    setPayerContactId("")
    setPayerOpen(false)
    setEditor(null)
    setAdding(null)
    setInlineError(null)
    setError(null)
  }, [])

  // Sesión nueva al abrir: borrador limpio y clave de cobro nueva.
  useEffect(() => {
    if (!open) return
    setSearch("")
    setChosen(null)
    resetDraft()
    setDirty(false)
    setRequestId(crypto.randomUUID())
  }, [open, patientId, resetDraft])

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
    queryKey: ["responsibilities", effectiveId],
    queryFn: () => fetchResponsibilities(effectiveId as string),
    enabled: open && effectiveId !== null,
  })
  const searchText = search.trim()
  const searchQuery = useQuery({
    queryKey: ["patients-search", searchText],
    queryFn: () => searchPatientsApi(searchText),
    enabled: open && patientId === null && chosen === null && searchText.length >= 2,
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
    () =>
      (data?.pendiente ?? []).filter((item) => item.saldoCents > 0 && item.currency !== currency)
        .length,
    [data, currency],
  )
  const offersPromotions = canWrite && pending.some((item) => item.serviceId !== null)
  const promotions = useQuery({
    queryKey: ["active-promotions"],
    queryFn: () => fetchActivePromotions(),
    enabled: open && offersPromotions,
  })
  const methodList = methods.data?.data ?? []
  const method = methodList.find((item) => item.id === methodId) ?? methodList[0] ?? null
  const methodById = (id: string) => methodList.find((item) => item.id === id)
  const isCash = (id: string) => methodById(id)?.typeCode === CASH_TYPE_CODE

  // Selección inicial: lo pendiente, o lo que pidió quien abrió el cobro.
  // Sin nada pendiente el cobro nace como adelanto.
  useEffect(() => {
    if (!open || selectInit || !data) return
    const ids = pending.map((item) => item.chargeId)
    const preset = (presetChargeIds ?? []).filter((id) => ids.includes(id))
    setSelected(preset.length > 0 ? preset : ids)
    if (pending.length === 0) setAdvanceMode(true)
    setSelectInit(true)
  }, [open, selectInit, data, pending, presetChargeIds])

  const selectedItems = pending.filter((item) => selected.includes(item.chargeId))
  const selectedTotal = selectedItems.reduce((sum, item) => sum + item.saldoCents, 0)
  const autoCredit = advanceMode ? 0 : Math.min(favor, selectedTotal)
  /** Lo que falta pagar de lo marcado, ya descontado el saldo a favor. */
  const due = advanceMode ? 0 : Math.max(0, selectedTotal - autoCredit)
  const creditOnly = !advanceMode && selectedItems.length > 0 && due === 0
  const amountCents = parseMoneyOrNull(amountText, currency, locale)

  // El importe sigue a lo marcado hasta que la persona escribe otro.
  useEffect(() => {
    if (!open || amountTouched || advanceMode) return
    setAmountText(due > 0 ? formatMoneyInput(due, currency, locale) : "")
    setSplit((current) => (current ? rebalance(current, due > 0 ? due : null, currency, locale) : current))
  }, [open, amountTouched, advanceMode, due, currency, locale])

  const lineCents = (text: string) => parseMoneyOrNull(text, currency, locale) ?? 0
  const splitTotal = split ? split.reduce((sum, line) => sum + lineCents(line.amountText), 0) : 0
  const hasCash = split
    ? split.some((line) => isCash(line.paymentMethodId))
    : method?.typeCode === CASH_TYPE_CODE
  const cashPortion = split
    ? split.reduce(
        (sum, line) => sum + (isCash(line.paymentMethodId) ? lineCents(line.amountText) : 0),
        0,
      )
    : hasCash
      ? (amountCents ?? 0)
      : 0
  const receivedCents = cashReceived.trim() ? parseMoneyOrNull(cashReceived, currency, locale) : null
  const change = hasCash && receivedCents !== null ? receivedCents - cashPortion : null

  const refreshAccount = async (id: string) => {
    await queryClient.invalidateQueries({ queryKey: ["patient-account3", id] })
    void queryClient.invalidateQueries({ queryKey: ["patient-account", id] })
    void queryClient.invalidateQueries({ queryKey: ["finance-debts"] })
  }

  // Corregir, quitar, agregar o aplicar promoción: una sola mutación a la vez.
  const conceptMutation = useMutation({
    mutationFn: (job: ConceptJob) => job.run(),
    onSuccess: async (result, job) => {
      setEditor(null)
      setAdding(null)
      setInlineError(null)
      setError(null)
      // El precio cambió: el importe vuelve a seguir a lo marcado.
      setAmountTouched(false)
      setDirty(true)
      job.done?.(result)
      await refreshAccount(effectiveId as string)
    },
    onError: (err, job) => setInlineError({ at: job.errorAt, message: financeErrorMessage(err) }),
  })
  const conceptBusy = (target: string) =>
    conceptMutation.isPending && conceptMutation.variables?.target === target

  const collectMutation = useMutation({
    mutationFn: async () => {
      const id = effectiveId as string
      const base = { branchId, payerContactId: payerContactId || null, requestId }
      // Sin medios el servidor usa solo el saldo a favor.
      const payments = creditOnly
        ? undefined
        : split
          ? split.map((line) => ({
              paymentMethodId: line.paymentMethodId,
              amountCents: lineCents(line.amountText),
              ...(line.reference.trim() ? { reference: line.reference.trim() } : {}),
            }))
          : [
              {
                paymentMethodId: (method as PaymentMethodOption).id,
                amountCents: amountCents as number,
                ...(!hasCash && reference.trim() ? { reference: reference.trim() } : {}),
              },
            ]
      const cash =
        !creditOnly && hasCash && receivedCents !== null ? { cashReceivedCents: receivedCents } : {}
      const result = advanceMode
        ? await collectApi(id, { ...base, advanceCents: amountCents as number, payments, ...cash })
        : await collectApi(id, {
            ...base,
            chargeIds: selectedItems.map((item) => item.chargeId),
            ...(payments ? { payments } : {}),
            ...cash,
          })
      return result.data
    },
    onSuccess: (result) => {
      const id = effectiveId as string
      // La respuesta ya trae la cuenta al día: el ticket la lee sin esperar.
      queryClient.setQueryData(["patient-account3", id], { data: result.account })
      void queryClient.invalidateQueries({ queryKey: ["patient-account", id] })
      void queryClient.invalidateQueries({ queryKey: ["finance-debts"] })
      void queryClient.invalidateQueries({ queryKey: ["finance-cash"] })
      void queryClient.invalidateQueries({ queryKey: ["finance-movements"] })
      void queryClient.invalidateQueries({ queryKey: ["finance-closures"] })
      setDirty(false)
      setRequestId(crypto.randomUUID())
      onCollected(result, id)
      onClose()
    },
    onError: (err) => setError(collectFailureMessage(err)),
  })

  const busy = conceptMutation.isPending || collectMutation.isPending
  const inlineOpen = editor !== null || adding !== null
  const noMethods = methods.isSuccess && methodList.length === 0

  // Lo que ya sabe quien abre el cobro manda (sin parpadeo); lo demás lo trae la cuenta.
  const known = data?.patient ?? null
  const knownDocument = known?.docNumber
    ? `${known.docType ? `${known.docType} ` : ""}${known.docNumber}`
    : null
  const displayName = (patientId !== null ? patientName : chosen?.name) || known?.displayName || ""
  const displayDocument = (patientId !== null ? patientDocument : chosen?.document) || knownDocument
  const displaySex = (patientId !== null ? patientSex : chosen?.sex) ?? known?.sex ?? null
  // Quién atendió hoy: el profesional de los conceptos de hoy (solo su nombre).
  const attendedToday = [
    ...new Set(
      pending
        .filter(
          (item) =>
            item.attendedBy &&
            item.attendedAt &&
            new Date(item.attendedAt).toDateString() === new Date().toDateString(),
        )
        .map((item) => item.attendedBy as string),
    ),
  ]
  const attendedLine =
    attendedToday.length === 0
      ? null
      : displaySex === "F"
        ? `atendida hoy por ${attendedToday.join(" y ")}`
        : displaySex === "M"
          ? `atendido hoy por ${attendedToday.join(" y ")}`
          : `atención de hoy con ${attendedToday.join(" y ")}`
  const headerLine = [displayDocument, attendedLine].filter(Boolean).join(" · ")
  const sedeName = branchName || sede.branches.find((item) => item.id === branchId)?.name || ""

  const payerOptions = useMemo(() => {
    const seen = new Map<string, { name: string; role: string }>()
    for (const row of responsibilities.data?.data ?? []) {
      if (!row.isCurrent || !PAYER_KINDS.includes(row.kind)) continue
      // Si tiene los dos papeles, basta el primero: el contacto es uno.
      if (seen.has(row.contactId)) continue
      seen.set(row.contactId, {
        name: row.contact.displayName,
        role: (RESPONSIBILITY_KIND_LABELS[row.kind] ?? row.kind).toLowerCase(),
      })
    }
    return [...seen.entries()].map(([contactId, value]) => ({ contactId, ...value }))
  }, [responsibilities.data])
  const payer = payerOptions.find((option) => option.contactId === payerContactId) ?? null

  /** Promociones vigentes que incluyen el servicio del concepto, en la moneda de la clínica. */
  const offersFor = (item: AccountPendingItem): Array<{ promo: PromotionOption; price: PromotionItem }> => {
    if (!item.serviceId) return []
    return (promotions.data ?? []).flatMap((promo) =>
      promo.items
        .filter(
          (price) =>
            price.serviceId === item.serviceId &&
            price.currency === currency &&
            price.priceCents !== null,
        )
        .map((price) => ({ promo, price })),
    )
  }

  const toggleConcept = (chargeId: string) => {
    setSelected((current) =>
      current.includes(chargeId) ? current.filter((id) => id !== chargeId) : [...current, chargeId],
    )
    setAmountTouched(false)
    setDirty(true)
  }

  const closeInline = () => {
    setEditor(null)
    setAdding(null)
    setInlineError(null)
  }

  const saveAmount = () => {
    if (editor?.kind !== "amount") return
    const charge = pending.find((item) => item.chargeId === editor.chargeId)
    if (!charge) return
    const cents = parseMoneyOrNull(editor.amountText, currency, locale)
    if (cents === null || cents <= 0) {
      setInlineError({ at: charge.chargeId, message: "Escribe el nuevo importe." })
      return
    }
    if (cents === charge.totalCents) {
      setInlineError({ at: charge.chargeId, message: "Es el mismo importe: no hay nada que guardar." })
      return
    }
    if (!editor.reason.trim()) {
      setInlineError({ at: charge.chargeId, message: "Escribe el motivo del cambio." })
      return
    }
    conceptMutation.mutate({
      target: `guardar-${charge.chargeId}`,
      errorAt: charge.chargeId,
      run: () =>
        editChargeConceptApi(effectiveId as string, charge.chargeId, {
          amountCents: cents,
          reason: editor.reason.trim(),
        }),
    })
  }

  const removeConcept = () => {
    if (editor?.kind !== "amount") return
    const chargeId = editor.chargeId
    if (!editor.reason.trim()) {
      setEditor({ ...editor, confirmRemove: false })
      setInlineError({ at: chargeId, message: "Escribe el motivo para quitarlo." })
      return
    }
    if (!editor.confirmRemove) {
      setInlineError(null)
      setEditor({ ...editor, confirmRemove: true })
      return
    }
    conceptMutation.mutate({
      target: `quitar-${chargeId}`,
      errorAt: chargeId,
      run: () => voidChargeApi(effectiveId as string, chargeId, editor.reason.trim()),
      done: () => setSelected((current) => current.filter((id) => id !== chargeId)),
    })
  }

  const applyPromotion = (item: AccountPendingItem, promo: PromotionOption, price: PromotionItem) => {
    if (price.mode === "from") {
      // «Desde» anuncia un mínimo: el precio final lo pone quien cobra, empezando ahí.
      setAdding(null)
      setInlineError(null)
      setEditor({
        kind: "promo",
        chargeId: item.chargeId,
        promotionId: promo.id,
        promotionName: promo.name,
        floorCents: price.priceCents ?? 0,
        amountText: formatMoneyInput(price.priceCents ?? 0, currency, locale),
        reason: "",
      })
      return
    }
    conceptMutation.mutate({
      target: `promo-${item.chargeId}-${promo.id}`,
      errorAt: item.chargeId,
      run: () =>
        editChargeConceptApi(effectiveId as string, item.chargeId, { promotionId: promo.id }),
    })
  }

  const savePromotionPrice = () => {
    if (editor?.kind !== "promo") return
    const cents = parseMoneyOrNull(editor.amountText, currency, locale)
    if (cents === null || cents <= 0) {
      setInlineError({ at: editor.chargeId, message: "Escribe el precio final." })
      return
    }
    if (cents < editor.floorCents && !editor.reason.trim()) {
      setInlineError({
        at: editor.chargeId,
        message: `El precio baja de ${formatMoney(editor.floorCents, currency, locale)}: escribe el motivo.`,
      })
      return
    }
    conceptMutation.mutate({
      target: `guardar-${editor.chargeId}`,
      errorAt: editor.chargeId,
      run: () =>
        editChargeConceptApi(effectiveId as string, editor.chargeId, {
          promotionId: editor.promotionId,
          amountCents: cents,
          ...(editor.reason.trim() ? { reason: editor.reason.trim() } : {}),
        }),
    })
  }

  const removePromotion = (item: AccountPendingItem) => {
    conceptMutation.mutate({
      target: `sin-promo-${item.chargeId}`,
      errorAt: item.chargeId,
      run: () => editChargeConceptApi(effectiveId as string, item.chargeId, { promotionId: null }),
    })
  }

  const addConcept = () => {
    if (!adding) return
    if (!branchId) {
      setInlineError({ at: "agregar", message: "Elige la sede antes de agregar un concepto." })
      return
    }
    const description = adding.description.trim()
    const cents = parseMoneyOrNull(adding.amountText, currency, locale)
    if (!description) {
      setInlineError({ at: "agregar", message: "Escribe qué es lo que se cobra." })
      return
    }
    if (cents === null || cents <= 0) {
      setInlineError({ at: "agregar", message: "Escribe el importe." })
      return
    }
    conceptMutation.mutate({
      target: "agregar",
      errorAt: "agregar",
      run: () =>
        createManualChargeApi(effectiveId as string, { branchId, description, amountCents: cents }),
      done: (result) => {
        const created = (result as { data?: { id?: string } }).data?.id
        if (created) setSelected((current) => [...current, created])
        setAdvanceMode(false)
      },
    })
  }

  const changeAmount = (value: string) => {
    setAmountText(value)
    setAmountTouched(true)
    setDirty(true)
    if (split) {
      setSplit(rebalance(split, parseMoneyOrNull(value, currency, locale), currency, locale))
    }
  }

  const addSplitLine = () => {
    const used = new Set(split ? split.map((line) => line.paymentMethodId) : method ? [method.id] : [])
    const next = methodList.find((item) => !used.has(item.id))
    const extra: SplitLine = {
      key: keySeq.current++,
      paymentMethodId: next?.id ?? "",
      amountText: "",
      reference: "",
      auto: true,
    }
    const current: SplitLine[] = split
      ? split.map((line) => ({ ...line, auto: false }))
      : [
          {
            key: keySeq.current++,
            paymentMethodId: method?.id ?? "",
            amountText,
            reference: hasCash ? "" : reference,
            auto: false,
          },
        ]
    setSplit(rebalance([...current, extra], amountCents, currency, locale))
    setDirty(true)
  }

  const patchSplitLine = (key: number, patch: Partial<SplitLine>) => {
    if (!split) return
    const next = split.map((line) => (line.key === key ? { ...line, ...patch } : line))
    setSplit("amountText" in patch ? rebalance(next, amountCents, currency, locale) : next)
    setDirty(true)
  }

  const removeSplitLine = (key: number) => {
    if (!split) return
    const rest = split.filter((line) => line.key !== key)
    if (rest.length > 1) {
      setSplit(rebalance(rest, amountCents, currency, locale))
    } else {
      // Con un solo medio vuelve la forma simple: botones y un importe.
      setSplit(null)
      if (rest[0]) {
        setMethodId(rest[0].paymentMethodId)
        setReference(rest[0].reference)
      }
    }
    setDirty(true)
  }

  const submitCollect = () => {
    if (!canWrite) {
      setError("Tu rol no cobra. Pídeselo a caja.")
      return
    }
    if (!effectiveId) {
      setError("Busca y elige al paciente que paga.")
      return
    }
    if (!branchId) {
      setError("Elige la sede a cuya caja entra el cobro.")
      return
    }
    if (inlineOpen) {
      setError("Guarda o cancela el cambio del concepto antes de cobrar.")
      return
    }
    if (!advanceMode && selectedItems.length === 0) {
      setError("Marca al menos un concepto o cobra un adelanto.")
      return
    }
    if (!creditOnly) {
      if (amountCents === null || amountCents <= 0) {
        setError(advanceMode ? "Escribe el importe del adelanto." : "Escribe el importe que paga ahora.")
        return
      }
      if (!advanceMode && amountCents > due) {
        setError(
          `El importe supera lo que falta de lo marcado (${formatMoney(due, currency, locale)}). Para dejar dinero a favor, cobra un adelanto.`,
        )
        return
      }
      if (split) {
        for (const line of split) {
          if (!methodById(line.paymentMethodId)) {
            setError("Elige el medio de pago de cada parte.")
            return
          }
          const cents = parseMoneyOrNull(line.amountText, currency, locale)
          if (cents === null || cents <= 0) {
            setError("Escribe el importe de cada medio de pago.")
            return
          }
        }
        if (splitTotal !== amountCents) {
          setError(
            `Los medios suman ${formatMoney(splitTotal, currency, locale)} y el importe es ${formatMoney(amountCents, currency, locale)}.`,
          )
          return
        }
      } else if (!method) {
        setError("Elige el medio de pago.")
        return
      }
      if (hasCash && cashReceived.trim() && (receivedCents === null || receivedCents < cashPortion)) {
        setError("Lo que recibes en efectivo no cubre la parte en efectivo.")
        return
      }
    }
    setError(null)
    collectMutation.mutate()
  }

  const submitLabel = creditOnly
    ? "Usar saldo a favor"
    : amountCents !== null && amountCents > 0
      ? `Cobrar ${formatMoney(amountCents, currency, locale)}`
      : "Cobrar"

  const editorFor = (item: AccountPendingItem) => {
    if (!editor || editor.chargeId !== item.chargeId) return null
    const errorText = inlineError?.at === item.chargeId ? inlineError.message : null
    const patch = (change: Partial<Editor>) => setEditor({ ...editor, ...change } as Editor)
    if (editor.kind === "promo") {
      const cents = parseMoneyOrNull(editor.amountText, currency, locale)
      const belowFloor = cents !== null && cents < editor.floorCents
      return (
        <div
          id={`${uid}-editor-${item.chargeId}`}
          className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-3"
        >
          <p className="text-sm font-medium">Promoción: {editor.promotionName}</p>
          <Field>
            <FieldLabel htmlFor={`${uid}-promo-precio`}>Precio final</FieldLabel>
            <MoneyInput
              id={`${uid}-promo-precio`}
              autoFocus
              currency={currency}
              locale={locale}
              value={editor.amountText}
              onChange={(value) => patch({ amountText: value })}
              onKeyDown={onEnter(savePromotionPrice)}
            />
            <FieldDescription>
              Solo pide un motivo si el precio baja de{" "}
              {formatMoney(editor.floorCents, currency, locale)}.
            </FieldDescription>
          </Field>
          {belowFloor ? (
            <Field>
              <FieldLabel htmlFor={`${uid}-promo-motivo`}>Motivo</FieldLabel>
              <Input
                id={`${uid}-promo-motivo`}
                maxLength={MAX_REASON}
                value={editor.reason}
                onChange={(event) => patch({ reason: event.target.value })}
                onKeyDown={onEnter(savePromotionPrice)}
              />
            </Field>
          ) : null}
          {errorText ? (
            <p role="alert" className="text-sm text-destructive">
              {errorText}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton
              size="sm"
              pending={conceptBusy(`guardar-${item.chargeId}`)}
              disabled={conceptMutation.isPending}
              onClick={savePromotionPrice}
            >
              Aplicar promoción
            </SubmitButton>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={conceptMutation.isPending}
              onClick={closeInline}
            >
              Cancelar
            </Button>
          </div>
        </div>
      )
    }
    return (
      <div
        id={`${uid}-editor-${item.chargeId}`}
        className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-3"
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-nuevo-importe`}>Nuevo importe</FieldLabel>
          <MoneyInput
            id={`${uid}-nuevo-importe`}
            autoFocus
            currency={currency}
            locale={locale}
            value={editor.amountText}
            onChange={(value) => patch({ amountText: value, confirmRemove: false })}
            onKeyDown={onEnter(saveAmount)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${uid}-motivo`}>Motivo</FieldLabel>
          <Input
            id={`${uid}-motivo`}
            maxLength={MAX_REASON}
            value={editor.reason}
            onChange={(event) => patch({ reason: event.target.value, confirmRemove: false })}
            onKeyDown={onEnter(saveAmount)}
          />
        </Field>
        {errorText ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText}
          </p>
        ) : null}
        {editor.confirmRemove ? (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirmar quitar concepto">
            <p className="min-w-0 flex-1 basis-full text-sm sm:basis-0">
              Se quita de la cuenta y queda en el historial. ¿Lo quitas?
            </p>
            <SubmitButton
              size="sm"
              variant="destructive"
              pending={conceptBusy(`quitar-${item.chargeId}`)}
              disabled={conceptMutation.isPending}
              onClick={removeConcept}
            >
              Sí, quitar
            </SubmitButton>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={conceptMutation.isPending}
              onClick={() => patch({ confirmRemove: false })}
            >
              No
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton
              size="sm"
              pending={conceptBusy(`guardar-${item.chargeId}`)}
              disabled={conceptMutation.isPending}
              onClick={saveAmount}
            >
              Guardar cambio
            </SubmitButton>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={conceptMutation.isPending}
              onClick={closeInline}
            >
              Cancelar
            </Button>
            <span className="flex-1" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={conceptMutation.isPending}
              onClick={removeConcept}
            >
              Quitar concepto
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Queda registrado quién lo cambió, cuándo y por qué.
        </p>
      </div>
    )
  }

  const promotionFor = (item: AccountPendingItem) => {
    if (item.promotionName) {
      return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="min-w-0 flex-1 text-muted-foreground">Promoción: {item.promotionName}</span>
          {item.budgetItemId ? (
            <span className="text-xs text-muted-foreground">Viene del presupuesto aceptado</span>
          ) : (
            <SubmitButton
              size="sm"
              variant="ghost"
              pending={conceptBusy(`sin-promo-${item.chargeId}`)}
              disabled={busy || inlineOpen}
              onClick={() => removePromotion(item)}
            >
              Quitar
            </SubmitButton>
          )}
        </div>
      )
    }
    const offers = offersFor(item)
    if (offers.length === 0) return null
    return (
      <ul className="flex flex-col gap-1">
        {offers.map(({ promo, price }) => (
          <li
            key={`${promo.id}-${price.serviceId}`}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-muted/60 px-3 py-2 text-sm"
          >
            <span className="min-w-0 flex-1">
              {promo.name}:{" "}
              {price.mode === "from"
                ? "tú pones el precio final"
                : price.priceCents === 0
                  ? "quedaría sin costo"
                  : `quedaría en ${formatAmountPlain(price.priceCents ?? 0, currency, locale)}`}
            </span>
            <SubmitButton
              size="sm"
              variant="outline"
              pending={conceptBusy(`promo-${item.chargeId}-${promo.id}`)}
              disabled={busy || inlineOpen}
              onClick={() => applyPromotion(item, promo, price)}
            >
              Aplicar
            </SubmitButton>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <FormDrawer
      open={open}
      title="Cobrar"
      headerContent={
        displayName ? (
          <div className="flex min-w-0 flex-col">
            <p className="break-words font-heading text-lg font-semibold">{displayName}</p>
            {headerLine ? (
              <p className="break-words text-sm text-muted-foreground">
                {headerLine.charAt(0).toUpperCase() + headerLine.slice(1)}
              </p>
            ) : null}
          </div>
        ) : undefined
      }
      error={error}
      isSubmitting={collectMutation.isPending}
      isLoading={Boolean(effectiveId) && account.isPending}
      isDirty={dirty}
      submitLabel={submitLabel}
      submitDisabled={
        !canWrite || !data || inlineOpen || conceptMutation.isPending || (noMethods && !creditOnly)
      }
      onClose={() => {
        if (!busy) onClose()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        submitCollect()
      }}
    >
      <div className="flex flex-col gap-6">
        {patientId === null ? (
          <Field>
            <FieldLabel htmlFor={`${uid}-paciente`}>Paciente</FieldLabel>
            <Input
              id={`${uid}-paciente`}
              autoComplete="off"
              placeholder="Nombre o documento"
              value={chosen ? chosen.name : search}
              onChange={(event) => {
                setSearch(event.target.value)
                if (chosen) {
                  setChosen(null)
                  resetDraft()
                }
              }}
              onKeyDown={onEnter(() => undefined)}
            />
            {!chosen && searchText.length >= 2 ? (
              searchQuery.isPending ? (
                <div className="flex flex-col gap-2" aria-busy="true">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : searchQuery.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {financeErrorMessage(searchQuery.error)}{" "}
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={() => void searchQuery.refetch()}
                  >
                    Reintentar
                  </Button>
                </p>
              ) : searchQuery.data.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nadie coincide con «{searchText}». Prueba con otro nombre o con su documento.
                </p>
              ) : (
                <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                  {searchQuery.data.data.map((row) => {
                    const document = row.docNumber
                      ? `${row.docType ? `${row.docType} ` : ""}${row.docNumber}`
                      : null
                    return (
                      <li key={row.id}>
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-auto min-h-10 w-full justify-between gap-3 whitespace-normal py-2 text-left"
                          onClick={() => {
                            resetDraft()
                            setChosen({
                              id: row.id,
                              name: row.displayName,
                              document,
                              sex: row.sex ?? null,
                            })
                            setDirty(true)
                          }}
                        >
                          <span className="min-w-0 break-words">{row.displayName}</span>
                          {document ? (
                            <span className="shrink-0 text-xs text-muted-foreground">{document}</span>
                          ) : null}
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              )
            ) : null}
          </Field>
        ) : null}

        {!effectiveId ? (
          <EmptyState
            title="Elige a quién le cobras"
            description="Escribe su nombre o su documento para ver lo que tiene pendiente."
          />
        ) : account.isError ? (
          <ErrorState
            title="No se pudo abrir la cuenta"
            message={financeErrorMessage(account.error)}
            onRetry={() => void account.refetch()}
          />
        ) : data ? (
          <>
            <fieldset className="flex min-w-0 flex-col gap-3">
              <legend className="mb-2 text-sm font-semibold">Qué paga</legend>
              {advanceMode ? (
                <p className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
                  Adelanto: no paga un concepto. Queda como saldo a favor y se usa solo en el
                  próximo cobro.
                </p>
              ) : pending.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tiene nada pendiente.</p>
              ) : (
                <ul className="flex flex-col divide-y rounded-xl border">
                  {pending.map((item) => {
                    const checked = selected.includes(item.chargeId)
                    // Con pagos aplicados el concepto ya no se corrige: se cobra lo que falta.
                    const editable = canWrite && item.paidCents === 0
                    const editing = editor?.chargeId === item.chargeId
                    const promotion = editable ? promotionFor(item) : null
                    const rowError =
                      !editing && inlineError?.at === item.chargeId ? inlineError.message : null
                    return (
                      <li key={item.chargeId} className="flex flex-col gap-2 px-3 py-2.5">
                        <div className="flex items-start gap-2">
                          <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-sm">
                            <Checkbox
                              className="mt-0.5"
                              checked={checked}
                              disabled={busy}
                              onCheckedChange={() => toggleConcept(item.chargeId)}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block break-words font-medium">
                                {item.description}
                                {item.visitNumber && item.visitsPlanned
                                  ? `, visita ${item.visitNumber} de ${item.visitsPlanned}`
                                  : ""}
                              </span>
                              {item.paidCents > 0 ? (
                                <span className="block text-xs text-muted-foreground">
                                  Costó {formatAmountPlain(item.totalCents, currency, locale)} · pagó{" "}
                                  {formatAmountPlain(item.paidCents, currency, locale)}
                                </span>
                              ) : null}
                              {!editable && item.promotionName ? (
                                <span className="block text-xs text-muted-foreground">
                                  Promoción: {item.promotionName}
                                </span>
                              ) : null}
                            </span>
                            <span className="shrink-0 font-semibold tabular-nums">
                              {formatAmountPlain(item.saldoCents, currency, locale)}
                            </span>
                          </label>
                          {editable ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="-my-1 -mr-1 shrink-0"
                              aria-label={`Cambiar ${item.description}`}
                              aria-expanded={editing}
                              aria-controls={editing ? `${uid}-editor-${item.chargeId}` : undefined}
                              disabled={busy}
                              onClick={() => {
                                setInlineError(null)
                                setAdding(null)
                                setEditor(
                                  editing
                                    ? null
                                    : {
                                        kind: "amount",
                                        chargeId: item.chargeId,
                                        amountText: formatMoneyInput(item.totalCents, currency, locale),
                                        reason: "",
                                        confirmRemove: false,
                                      },
                                )
                              }}
                            >
                              <MoreHorizontal aria-hidden />
                            </Button>
                          ) : null}
                        </div>
                        {promotion}
                        {rowError ? (
                          <p role="alert" className="text-sm text-destructive">
                            {rowError}
                          </p>
                        ) : null}
                        {editorFor(item)}
                      </li>
                    )
                  })}
                </ul>
              )}
              {promotions.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  No se pudieron consultar las promociones vigentes.{" "}
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={() => void promotions.refetch()}
                  >
                    Reintentar
                  </Button>
                </p>
              ) : null}
              {autoCredit > 0 ? (
                <p className="flex items-center justify-between gap-3 rounded-xl bg-muted/60 px-3 py-2 text-sm">
                  <span>Se usa su saldo a favor</span>
                  <span className="font-medium tabular-nums">
                    − {formatAmountPlain(autoCredit, currency, locale)}
                  </span>
                </p>
              ) : null}
              {otherCurrencyCount > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {otherCurrencyCount === 1
                    ? "Tiene 1 concepto en otra moneda, que no entra en este cobro."
                    : `Tiene ${otherCurrencyCount} conceptos en otra moneda, que no entran en este cobro.`}
                </p>
              ) : null}
              {adding ? (
                <div className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-3">
                  <Field>
                    <FieldLabel htmlFor={`${uid}-otro-concepto`}>Concepto</FieldLabel>
                    <Input
                      id={`${uid}-otro-concepto`}
                      autoFocus
                      maxLength={MAX_REASON}
                      value={adding.description}
                      onChange={(event) => setAdding({ ...adding, description: event.target.value })}
                      onKeyDown={onEnter(addConcept)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${uid}-otro-importe`}>Importe</FieldLabel>
                    <MoneyInput
                      id={`${uid}-otro-importe`}
                      currency={currency}
                      locale={locale}
                      value={adding.amountText}
                      onChange={(value) => setAdding({ ...adding, amountText: value })}
                      onKeyDown={onEnter(addConcept)}
                    />
                  </Field>
                  {inlineError?.at === "agregar" ? (
                    <p role="alert" className="text-sm text-destructive">
                      {inlineError.message}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <SubmitButton
                      size="sm"
                      pending={conceptBusy("agregar")}
                      disabled={conceptMutation.isPending}
                      onClick={addConcept}
                    >
                      Agregar
                    </SubmitButton>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={conceptMutation.isPending}
                      onClick={closeInline}
                    >
                      Cancelar
                    </Button>
                  </div>
                </div>
              ) : canWrite ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setEditor(null)
                      setInlineError(null)
                      setAdding({ description: "", amountText: "" })
                    }}
                  >
                    <Plus aria-hidden />
                    Agregar otro concepto
                  </Button>
                  {advanceMode ? (
                    pending.length > 0 ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setAdvanceMode(false)
                          setAmountTouched(false)
                          setDirty(true)
                        }}
                      >
                        Cobrar lo pendiente
                      </Button>
                    ) : null
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        closeInline()
                        setAdvanceMode(true)
                        setAmountText("")
                        setAmountTouched(false)
                        setSplit(null)
                        setDirty(true)
                      }}
                    >
                      Cobrar un adelanto
                    </Button>
                  )}
                </div>
              ) : null}
            </fieldset>

            {creditOnly ? (
              <p className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
                Su saldo a favor cubre todo lo marcado: no hace falta otro medio de pago.
              </p>
            ) : methods.isPending ? (
              <div className="flex flex-col gap-2" aria-busy="true">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-10 w-2/3" />
              </div>
            ) : methods.isError ? (
              <ErrorState
                title="No se pudieron consultar los medios de pago"
                message={financeErrorMessage(methods.error)}
                onRetry={() => void methods.refetch()}
              />
            ) : noMethods ? (
              <EmptyState
                title="No hay medios de pago activos"
                description={
                  canConfigure
                    ? "Hace falta al menos uno para cobrar."
                    : "Hace falta al menos uno para cobrar. Pídeselo a quien administra la clínica."
                }
                actionLabel={canConfigure ? "Ir a Medios de pago" : undefined}
                onAction={
                  canConfigure
                    ? () => {
                        onClose()
                        void navigate({ to: "/settings/payment-methods" })
                      }
                    : undefined
                }
              />
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor={`${uid}-importe`}>Importe</FieldLabel>
                  <MoneyInput
                    id={`${uid}-importe`}
                    currency={currency}
                    locale={locale}
                    value={amountText}
                    onChange={changeAmount}
                    aria-describedby={`${uid}-importe-ayuda`}
                  />
                  <FieldDescription id={`${uid}-importe-ayuda`}>
                    {advanceMode
                      ? "Todo queda como saldo a favor."
                      : "Si paga una parte, el resto queda por cobrar."}
                  </FieldDescription>
                </Field>

                <div className="flex flex-col gap-3">
                  <span id={`${uid}-medio`} className="text-sm font-medium">
                    {split ? "Medios de pago" : "Medio de pago"}
                  </span>
                  {split ? (
                    <>
                      <ul className="flex flex-col gap-3" aria-labelledby={`${uid}-medio`}>
                        {split.map((line, index) => {
                          const lineMethod = methodById(line.paymentMethodId)
                          const lineName = lineMethod?.name ?? `medio ${index + 1}`
                          return (
                            <li key={line.key} className="flex flex-col gap-2 rounded-xl border p-3">
                              <div className="flex items-center gap-2">
                                <ChoiceSelect
                                  aria-label={`Medio de pago ${index + 1}`}
                                  className="min-w-0 flex-1"
                                  placeholder="Elige el medio"
                                  value={line.paymentMethodId}
                                  onChange={(event) =>
                                    patchSplitLine(line.key, { paymentMethodId: event.target.value })
                                  }
                                >
                                  {methodList.map((item) => (
                                    <option key={item.id} value={item.id}>
                                      {item.name}
                                    </option>
                                  ))}
                                </ChoiceSelect>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  className="shrink-0"
                                  aria-label={`Quitar ${lineName}`}
                                  onClick={() => removeSplitLine(line.key)}
                                >
                                  <X aria-hidden />
                                </Button>
                              </div>
                              <MoneyInput
                                aria-label={`Importe por ${lineName}`}
                                currency={currency}
                                locale={locale}
                                value={line.amountText}
                                onChange={(value) =>
                                  patchSplitLine(line.key, { amountText: value, auto: false })
                                }
                              />
                              {lineMethod && lineMethod.typeCode !== CASH_TYPE_CODE ? (
                                <Field>
                                  <FieldLabel htmlFor={`${uid}-operacion-${line.key}`}>
                                    N.º de operación (opcional)
                                  </FieldLabel>
                                  <Input
                                    id={`${uid}-operacion-${line.key}`}
                                    autoComplete="off"
                                    maxLength={MAX_REFERENCE}
                                    value={line.reference}
                                    onChange={(event) =>
                                      patchSplitLine(line.key, { reference: event.target.value })
                                    }
                                  />
                                </Field>
                              ) : null}
                            </li>
                          )
                        })}
                      </ul>
                      <p
                        className={cn(
                          "text-sm tabular-nums",
                          amountCents !== null && splitTotal !== amountCents
                            ? "text-destructive"
                            : "text-muted-foreground",
                        )}
                        role="status"
                      >
                        Suman {formatMoney(splitTotal, currency, locale)}
                        {amountCents !== null && splitTotal < amountCents
                          ? ` · faltan ${formatMoney(amountCents - splitTotal, currency, locale)}`
                          : amountCents !== null && splitTotal > amountCents
                            ? ` · sobran ${formatMoney(splitTotal - amountCents, currency, locale)}`
                            : ""}
                      </p>
                    </>
                  ) : (
                    <>
                      <PaymentMethodButtons
                        labelId={`${uid}-medio`}
                        methods={methodList}
                        value={method?.id ?? ""}
                        onChange={(id) => {
                          setMethodId(id)
                          setDirty(true)
                        }}
                      />
                      {method && !hasCash ? (
                        <Field>
                          <FieldLabel htmlFor={`${uid}-operacion`}>
                            N.º de operación (opcional)
                          </FieldLabel>
                          <Input
                            id={`${uid}-operacion`}
                            autoComplete="off"
                            maxLength={MAX_REFERENCE}
                            value={reference}
                            onChange={(event) => {
                              setReference(event.target.value)
                              setDirty(true)
                            }}
                          />
                        </Field>
                      ) : null}
                    </>
                  )}
                  {hasCash ? (
                    <div className="grid grid-cols-2 items-end gap-3">
                      <Field>
                        <FieldLabel htmlFor={`${uid}-recibes`}>Recibes en efectivo</FieldLabel>
                        <MoneyInput
                          id={`${uid}-recibes`}
                          currency={currency}
                          locale={locale}
                          value={cashReceived}
                          invalid={change !== null && change < 0}
                          onChange={(value) => {
                            setCashReceived(value)
                            setDirty(true)
                          }}
                        />
                      </Field>
                      <div className="flex min-h-9 flex-col justify-center" role="status">
                        <span className="text-sm text-muted-foreground">
                          {change !== null && change < 0 ? "Falta" : "Vuelto"}
                        </span>
                        <span
                          className={cn(
                            "text-base font-semibold tabular-nums",
                            change !== null && change < 0 && "text-destructive",
                          )}
                        >
                          {change === null ? "—" : formatMoney(Math.abs(change), currency, locale)}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  {methodList.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="self-start"
                      onClick={addSplitLine}
                    >
                      <Plus aria-hidden />
                      Añadir otro medio
                    </Button>
                  ) : null}
                </div>
              </>
            )}

            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0 break-words">
                  Paga{" "}
                  <strong className="font-semibold">
                    {payer ? payer.name : displayName || "el paciente"}
                  </strong>
                  {payer ? `, ${payer.role}` : displayName ? `, ${patientNoun(displaySex)}` : ""}
                </span>
                {payerOptions.length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-expanded={payerOpen}
                    aria-controls={payerOpen ? `${uid}-quien-paga` : undefined}
                    onClick={() => setPayerOpen((value) => !value)}
                  >
                    Cambiar
                  </Button>
                ) : null}
              </div>
              {payerOpen ? (
                <RadioGroup
                  id={`${uid}-quien-paga`}
                  aria-label="Quién paga"
                  value={payerContactId || "paciente"}
                  onValueChange={(next) => {
                    setPayerContactId(next === "paciente" ? "" : String(next))
                    setPayerOpen(false)
                    setDirty(true)
                  }}
                >
                  {[
                    {
                      value: "paciente",
                      label: `${displayName || "El paciente"}, ${patientNoun(displaySex)}`,
                    },
                    ...payerOptions.map((option) => ({
                      value: option.contactId,
                      label: `${option.name}, ${option.role}`,
                    })),
                  ].map((option) => (
                    <FieldLabel
                      key={option.value}
                      className={cn(
                        "flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-xl border px-3 text-sm font-normal",
                        (payerContactId || "paciente") === option.value &&
                          "border-primary bg-primary-soft",
                      )}
                    >
                      <RadioGroupItem value={option.value} />
                      <span className="min-w-0 break-words">{option.label}</span>
                    </FieldLabel>
                  ))}
                </RadioGroup>
              ) : null}
              {responsibilities.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  No se pudieron consultar sus responsables.{" "}
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={() => void responsibilities.refetch()}
                  >
                    Reintentar
                  </Button>
                </p>
              ) : null}
            </div>

            <p className="text-sm text-muted-foreground">
              {creditOnly
                ? "No entra dinero a la caja: solo se usa su saldo a favor."
                : `${sedeName ? `Entra a la caja de ${sedeName}.` : ""}${split ? " Sale un solo ticket." : ""}`.trim()}
            </p>
          </>
        ) : null}
      </div>
    </FormDrawer>
  )
}
