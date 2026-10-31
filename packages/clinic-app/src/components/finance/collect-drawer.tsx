/**
 * Cobrar en un paso: qué paga, cuánto y con qué medio, en un solo formulario
 * que llama al cobro atómico (`POST /patients/:id/collect`). El servidor cobra
 * de lo más antiguo a lo más nuevo, usa solo el saldo a favor y devuelve el
 * ticket numerado. Sin datos clínicos: solo conceptos económicos pendientes.
 *
 * Un concepto se corrige en la misma lista: nuevo importe con motivo, quitarlo,
 * o la promoción vigente de su servicio (el precio lo resuelve el servidor).
 * «+ Agregar producto» (ADR 0067) cobra algo que se vende: el concepto toma su
 * precio de venta × la cantidad y el producto sale de la sede del cobro al
 * agregarlo, aunque se pague después; si no había, queda como faltante.
 * Paga el paciente salvo que se elija a uno de sus responsables vigentes.
 *
 * Cada error se dice junto a lo que hay que corregir: el concepto, el importe,
 * el medio (o la parte con varios medios), lo recibido o quién paga; lo que no
 * es de ningún dato, junto a los botones. Cada bloque en línea (cambiar un
 * concepto, su promoción, otro concepto, un producto) es su propio formulario
 * con su error en su campo.
 *
 * Moneda de la clínica (prop requerida) y formato del perfil; dinero con el
 * módulo compartido `@odentia/clinical`. Nada fijo de un país.
 */
import { documentText, formatMoney, formatMoneyInput, parseMoney, unitFor } from "@odentia/clinical"
import {
  Button,
  Checkbox,
  cn,
  Field,
  FieldError,
  FieldLabel,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
} from "@odentia/ui"
import {
  EmptyState,
  ErrorState,
  FormDrawer,
  ResourceSelect,
  SubmitButton,
  submitForm,
  useAppForm,
  useFieldContext,
  useFieldControl,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { MoreHorizontal, Plus, X } from "lucide-react"
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { useActiveBranch } from "../../lib/active-branch"
import { fetchResponsibilities, RESPONSIBILITY_KIND_LABELS } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { collectFormMessage, financeErrorMessage, financeFormMessage } from "../../lib/finance"
import {
  type AccountPendingItem,
  CASH_TYPE_CODE,
  type CollectInput,
  type CollectResultBody,
  collectApi,
  createManualChargeApi,
  createProductChargeApi,
  currencySymbol,
  editChargeConceptApi,
  fetchActivePromotions,
  fetchPatientAccount3,
  fetchPaymentMethods,
  fetchSaleProducts,
  formatAmountPlain,
  type PaymentMethodOption,
  type ProductCharge,
  type PromotionItem,
  type PromotionOption,
  type SaleProduct,
  voidChargeApi,
} from "../../lib/finance-collect"
import { parseWholeQuantity, saleDeductionWords, saleStockNote } from "../../lib/materials"
import { PersonPicker } from "../person-picker"
import { ChoiceSelect } from "../ui/choice-select"

/** Lo más que se vende de un producto en un concepto (el tope del servidor). */
const SALE_QUANTITY_MAX = 9999

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
  onBlur,
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
  onBlur?: () => void
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
        onBlur={onBlur}
      />
    </InputGroup>
  )
}

/**
 * Medios de pago activos como botones, en el orden que la clínica les dio.
 * Dentro de un `field.Group` el nombre lo da su leyenda (sin `labelId`) y el
 * grupo se marca con `invalid` y `aria-describedby`.
 */
export function PaymentMethodButtons({
  id,
  labelId,
  methods,
  value,
  onChange,
  onBlur,
  disabled,
  invalid,
  "aria-describedby": describedBy,
}: {
  id?: string
  labelId?: string
  methods: PaymentMethodOption[]
  value: string
  onChange: (id: string) => void
  /** Al salir el foco del grupo. */
  onBlur?: () => void
  disabled?: boolean
  invalid?: boolean
  "aria-describedby"?: string
}): React.JSX.Element {
  return (
    <div
      id={id}
      role="group"
      aria-labelledby={labelId}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className="flex flex-wrap gap-2"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onBlur?.()
      }}
    >
      {methods.map((method) => {
        const selected = method.id === value
        return (
          <Button
            key={method.id}
            type="button"
            variant={selected ? "default" : "outline"}
            aria-pressed={selected}
            disabled={disabled}
            className={cn("min-h-10", invalid && !selected && "border-destructive")}
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
  methodId: string
  amount: string
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
    .reduce((sum, line) => sum + (parseMoneyOrNull(line.amount, currency, locale) ?? 0), 0)
  const rest = totalCents - fixed
  return lines.map((line) =>
    line.auto ? { ...line, amount: rest > 0 ? formatMoneyInput(rest, currency, locale) : "" } : line,
  )
}

/** El paciente elegido en el buscador, cuando el cobro no llega con uno. */
interface PickedPatient {
  id: string
  name: string
  document: string | null
  sex: string | null
}

/** El borrador del cobro. Sin varios medios, `payments` va vacío y manda `methodId`. */
interface CollectDraft {
  patient: PickedPatient | null
  chargeIds: string[]
  /** Adelanto: no paga conceptos, queda a favor. */
  advance: boolean
  amount: string
  methodId: string
  reference: string
  payments: SplitLine[]
  cashReceived: string
  payerContactId: string
}

const EMPTY_DRAFT: CollectDraft = {
  patient: null,
  chargeIds: [],
  advance: false,
  amount: "",
  methodId: "",
  reference: "",
  payments: [],
  cashReceived: "",
  payerContactId: "",
}

/** Lo que el borrador necesita de la pantalla para calcularse y validarse. */
interface CollectRules {
  needsPatient: boolean
  /** Lo pendiente en la moneda de la clínica. */
  pending: AccountPendingItem[]
  favor: number
  methods: PaymentMethodOption[]
  currency: string
  locale: string
}

/** Las cifras del cobro a partir del borrador: lo que se ve y lo que se envía. */
function collectFigures(value: CollectDraft, rules: CollectRules) {
  const { pending, favor, methods, currency, locale } = rules
  const money = (text: string) => parseMoneyOrNull(text, currency, locale)
  const lineCents = (text: string) => money(text) ?? 0
  const methodById = (id: string) => methods.find((item) => item.id === id)
  const isCash = (id: string) => methodById(id)?.typeCode === CASH_TYPE_CODE
  const selectedItems = pending.filter((item) => value.chargeIds.includes(item.chargeId))
  const selectedTotal = selectedItems.reduce((sum, item) => sum + item.saldoCents, 0)
  const autoCredit = value.advance ? 0 : Math.min(favor, selectedTotal)
  /** Lo que falta pagar de lo marcado, ya descontado el saldo a favor. */
  const due = value.advance ? 0 : Math.max(0, selectedTotal - autoCredit)
  const creditOnly = !value.advance && selectedItems.length > 0 && due === 0
  const amountCents = money(value.amount)
  const split = value.payments.length > 0
  const method = methodById(value.methodId) ?? methods[0] ?? null
  const splitTotal = value.payments.reduce((sum, line) => sum + lineCents(line.amount), 0)
  const hasCash = split ? value.payments.some((line) => isCash(line.methodId)) : method?.typeCode === CASH_TYPE_CODE
  const cashPortion = split
    ? value.payments.reduce((sum, line) => sum + (isCash(line.methodId) ? lineCents(line.amount) : 0), 0)
    : hasCash
      ? (amountCents ?? 0)
      : 0
  const receivedCents = value.cashReceived.trim() ? money(value.cashReceived) : null
  const change = hasCash && receivedCents !== null ? receivedCents - cashPortion : null
  return {
    money,
    lineCents,
    methodById,
    selectedItems,
    autoCredit,
    due,
    creditOnly,
    amountCents,
    split,
    method,
    splitTotal,
    hasCash,
    cashPortion,
    receivedCents,
    change,
  }
}

const lineSchema = z.object({
  key: z.number(),
  methodId: z.string(),
  amount: z.string(),
  reference: z.string().max(MAX_REFERENCE, `Escribe como mucho ${MAX_REFERENCE} caracteres.`),
  auto: z.boolean(),
})

/** Las reglas del cobro, cada una en el dato que hay que corregir. */
function collectSchema(rules: () => CollectRules) {
  return z
    .object({
      patient: z.custom<PickedPatient | null>(),
      chargeIds: z.array(z.string()),
      advance: z.boolean(),
      amount: z.string(),
      methodId: z.string(),
      reference: z.string().max(MAX_REFERENCE, `Escribe como mucho ${MAX_REFERENCE} caracteres.`),
      payments: z.array(lineSchema),
      cashReceived: z.string(),
      payerContactId: z.string(),
    })
    .superRefine((value, ctx) => {
      const current = rules()
      const { currency, locale } = current
      const issue = (path: Array<string | number>, message: string) => ctx.addIssue({ code: "custom", path, message })
      if (current.needsPatient && !value.patient) {
        issue(["patient"], "Busca y elige al paciente que paga.")
        return
      }
      const figures = collectFigures(value, current)
      if (!value.advance && figures.selectedItems.length === 0) {
        issue(["chargeIds"], "Marca al menos un concepto o cobra un adelanto.")
        return
      }
      if (figures.creditOnly) return
      const amountCents = figures.amountCents
      const amountOk = amountCents !== null && amountCents > 0
      if (!amountOk) {
        issue(["amount"], value.advance ? "Escribe el importe del adelanto." : "Escribe el importe que paga ahora.")
      } else if (!value.advance && amountCents > figures.due) {
        issue(
          ["amount"],
          `El importe supera lo que falta de lo marcado (${formatMoney(figures.due, currency, locale)}). Para dejar dinero a favor, cobra un adelanto.`,
        )
      }
      if (figures.split) {
        let linesOk = true
        value.payments.forEach((line, index) => {
          if (!figures.methodById(line.methodId)) {
            issue(["payments", index, "methodId"], "Elige el medio de pago de cada parte.")
            linesOk = false
          }
          const cents = figures.money(line.amount)
          if (cents === null || cents <= 0) {
            issue(["payments", index, "amount"], "Escribe el importe de cada medio de pago.")
            linesOk = false
          }
        })
        if (amountOk && linesOk && figures.splitTotal !== amountCents) {
          issue(
            ["payments"],
            `Los medios suman ${formatMoney(figures.splitTotal, currency, locale)} y el importe es ${formatMoney(amountCents, currency, locale)}.`,
          )
        }
      } else if (!figures.method) {
        issue(["methodId"], "Elige el medio de pago.")
      }
      if (
        figures.hasCash &&
        value.cashReceived.trim() &&
        (figures.receivedCents === null || figures.receivedCents < figures.cashPortion)
      ) {
        issue(["cashReceived"], "Lo que recibes en efectivo no cubre la parte en efectivo.")
      }
    })
}

/** Bloque abierto bajo un concepto: corregir el importe o poner el precio de una promoción «desde». */
type Editor =
  | { kind: "amount"; chargeId: string }
  | { kind: "promo"; chargeId: string; promotionId: string; promotionName: string; floorCents: number }

/** Cambio sobre un concepto: quién muestra el progreso, qué se llama y qué pasa al terminar. */
interface ConceptJob {
  target: string
  run: () => Promise<unknown>
  done?: () => void
}

/** Lo que el servidor llama distinto en los bloques de un concepto. */
const CONCEPT_FIELDS = { amountCents: "amount" }

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

  const [selectInit, setSelectInit] = useState(false)
  /** El importe sigue a lo marcado hasta que la persona escribe otro. */
  const [amountTouched, setAmountTouched] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [adding, setAdding] = useState(false)
  const [addingProduct, setAddingProduct] = useState(false)
  /** El rechazo de una acción suelta sobre un concepto (aplicar o quitar una promoción). */
  const [rowError, setRowError] = useState<{ chargeId: string; message: string } | null>(null)
  /**
   * Lo vendido en este cobro, por concepto: con esto se dice «15.00 c/u · se
   * descuentan 2 de Sede Miraflores» bajo su línea (la cuenta no lo trae).
   */
  const [soldHere, setSoldHere] = useState<
    Record<string, { quantity: number; unitPriceCents: number; branchName: string }>
  >({})
  /**
   * La clave del cobro: la misma mientras el cajón siga abierto y no se cobre.
   * Si la respuesta no llega, volver a pulsar «Cobrar» sin cambiar nada
   * devuelve el mismo ticket en vez de cobrar dos veces.
   */
  const requestId = useRef<string>(crypto.randomUUID())
  const keySeq = useRef(1)
  const rules = useRef<CollectRules>({
    needsPatient: patientId === null,
    pending: [],
    favor: 0,
    methods: [],
    currency,
    locale,
  })
  const schema = useMemo(() => collectSchema(() => rules.current), [])

  const collect = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: CollectInput }) => (await collectApi(id, body)).data,
    onSuccess: (result, { id }) => {
      // La respuesta ya trae la cuenta al día: el ticket la lee sin esperar.
      queryClient.setQueryData(["patient-account3", id], { data: result.account })
      void queryClient.invalidateQueries({ queryKey: ["patient-account", id] })
      void queryClient.invalidateQueries({ queryKey: ["finance-debts"] })
      void queryClient.invalidateQueries({ queryKey: ["finance-cash"] })
      void queryClient.invalidateQueries({ queryKey: ["finance-movements"] })
      void queryClient.invalidateQueries({ queryKey: ["finance-closures"] })
      requestId.current = crypto.randomUUID()
      onCollected(result, id)
      onClose()
    },
  })

  const form = useAppForm({
    defaultValues: EMPTY_DRAFT,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const id = patientId ?? value.patient?.id
      if (!id) return
      const figures = collectFigures(value, rules.current)
      // El esquema ya exige importe y medio: aquí solo se arma el cuerpo.
      const amountCents = figures.amountCents ?? 0
      const single = figures.method
      const base = { branchId, payerContactId: value.payerContactId || null, requestId: requestId.current }
      // Sin medios el servidor usa solo el saldo a favor.
      const payments = figures.creditOnly
        ? undefined
        : figures.split
          ? value.payments.map((line) => ({
              paymentMethodId: line.methodId,
              amountCents: figures.lineCents(line.amount),
              ...(line.reference.trim() ? { reference: line.reference.trim() } : {}),
            }))
          : single
            ? [
                {
                  paymentMethodId: single.id,
                  amountCents,
                  ...(!figures.hasCash && value.reference.trim() ? { reference: value.reference.trim() } : {}),
                },
              ]
            : []
      const cash =
        !figures.creditOnly && figures.hasCash && figures.receivedCents !== null
          ? { cashReceivedCents: figures.receivedCents }
          : {}
      await collect.mutateAsync({
        id,
        body: value.advance
          ? { ...base, advanceCents: amountCents, payments, ...cash }
          : {
              ...base,
              chargeIds: figures.selectedItems.map((item) => item.chargeId),
              ...(payments ? { payments } : {}),
              ...cash,
            },
      })
    },
  })
  const surface = useFormSurface(form, {
    formMessage: collectFormMessage,
    // El servidor nombra los datos del cuerpo; con un solo medio, su medio e
    // importe son los del formulario simple.
    fieldMap: (key) => {
      if (key === "chargeIds" || key.startsWith("chargeIds[")) return "chargeIds"
      if (key === "advanceCents") return "amount"
      if (key === "cashReceivedCents") return "cashReceived"
      const part = /^payments\[(\d+)\]\.(paymentMethodId|amountCents|reference)$/.exec(key)
      if (!part) return undefined
      const name = part[2] === "paymentMethodId" ? "methodId" : part[2] === "amountCents" ? "amount" : "reference"
      return form.state.values.payments.length > 0 ? `payments[${part[1]}].${name}` : name
    },
  })

  const values = useStore(form.store, (state) => state.values)
  const chosen = values.patient
  const effectiveId = patientId ?? chosen?.id ?? null

  const closeInline = () => {
    setEditor(null)
    setAdding(false)
    setAddingProduct(false)
  }

  // Sesión nueva al abrir: borrador limpio y clave de cobro nueva.
  useEffect(() => {
    if (!open) return
    form.reset()
    setSelectInit(false)
    setAmountTouched(false)
    setEditor(null)
    setAdding(false)
    setAddingProduct(false)
    setRowError(null)
    setSoldHere({})
    requestId.current = crypto.randomUUID()
  }, [open, patientId, form])

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

  rules.current = { needsPatient: patientId === null, pending, favor, methods: methodList, currency, locale }
  const figures = collectFigures(values, rules.current)
  const { autoCredit, due, creditOnly, amountCents, split, method, splitTotal, hasCash, change } =
    figures

  // Selección inicial: lo pendiente, o lo que pidió quien abrió el cobro.
  // Sin nada pendiente el cobro nace como adelanto.
  useEffect(() => {
    if (!open || selectInit || !data) return
    const ids = pending.map((item) => item.chargeId)
    const preset = (presetChargeIds ?? []).filter((id) => ids.includes(id))
    form.setFieldValue("chargeIds", preset.length > 0 ? preset : ids, { dontUpdateMeta: true })
    if (pending.length === 0) form.setFieldValue("advance", true, { dontUpdateMeta: true })
    setSelectInit(true)
  }, [open, selectInit, data, pending, presetChargeIds, form])

  /** Con una línea «automática», esta completa lo que falta para `totalCents`. */
  // Memorizada: el efecto del importe la usa sin volver a correr en cada render.
  const followAmount = useCallback(
    (totalCents: number | null) => {
      const lines = form.state.values.payments
      if (lines.length === 0) return
      rebalance(lines, totalCents, currency, locale).forEach((line, index) => {
        if (line.amount !== lines[index]?.amount) {
          form.setFieldValue(`payments[${index}].amount`, line.amount, { dontUpdateMeta: true })
        }
      })
    },
    [form, currency, locale],
  )

  // El importe sigue a lo marcado hasta que la persona escribe otro.
  useEffect(() => {
    if (!open || amountTouched || values.advance) return
    const text = due > 0 ? formatMoneyInput(due, currency, locale) : ""
    if (form.state.values.amount !== text) form.setFieldValue("amount", text, { dontUpdateMeta: true })
    followAmount(due > 0 ? due : null)
  }, [open, amountTouched, values.advance, due, currency, locale, form, followAmount])

  const refreshAccount = async (id: string) => {
    await queryClient.invalidateQueries({ queryKey: ["patient-account3", id] })
    void queryClient.invalidateQueries({ queryKey: ["patient-account", id] })
    void queryClient.invalidateQueries({ queryKey: ["finance-debts"] })
  }

  // Corregir, quitar, agregar o aplicar promoción: una sola mutación a la vez.
  const conceptMutation = useMutation({
    mutationFn: (job: ConceptJob) => job.run(),
    onSuccess: async (_result, job) => {
      closeInline()
      setRowError(null)
      // El precio cambió: el importe vuelve a seguir a lo marcado.
      setAmountTouched(false)
      job.done?.()
      await refreshAccount(effectiveId as string)
    },
  })
  const conceptBusy = (target: string) =>
    conceptMutation.isPending && conceptMutation.variables?.target === target
  const runConcept = (job: ConceptJob) => conceptMutation.mutateAsync(job)

  const busy = conceptMutation.isPending || surface.isSubmitting
  const inlineOpen = editor !== null || adding || addingProduct
  const noMethods = methods.isSuccess && methodList.length === 0

  // Lo que ya sabe quien abre el cobro manda (sin parpadeo); lo demás lo trae la cuenta.
  const known = data?.patient ?? null
  const knownDocument = known?.docNumber ? documentText(known.docType, known.docNumber) : null
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

  /** Marca o desmarca un concepto: los marcados vuelven a fijar el importe. */
  const addCharge = (chargeId: string) => {
    form.setFieldValue("chargeIds", (current) => (current.includes(chargeId) ? current : [...current, chargeId]))
    form.setFieldValue("advance", false)
  }

  const saveAmount = (item: AccountPendingItem, cents: number, reason: string) =>
    runConcept({
      target: `guardar-${item.chargeId}`,
      run: () => editChargeConceptApi(effectiveId as string, item.chargeId, { amountCents: cents, reason }),
    })

  const removeConcept = (item: AccountPendingItem, reason: string) =>
    runConcept({
      target: `quitar-${item.chargeId}`,
      run: () => voidChargeApi(effectiveId as string, item.chargeId, reason),
      done: () => {
        form.setFieldValue("chargeIds", (current) => current.filter((id) => id !== item.chargeId))
        // Si era un producto, volvió a la sede.
        void queryClient.invalidateQueries({ queryKey: ["sale-products"] })
        void queryClient.invalidateQueries({ queryKey: ["inventory"] })
      },
    })

  const applyPromotion = (item: AccountPendingItem, promo: PromotionOption, price: PromotionItem) => {
    setRowError(null)
    if (price.mode === "from") {
      // «Desde» anuncia un mínimo: el precio final lo pone quien cobra, empezando ahí.
      setAdding(false)
      setAddingProduct(false)
      setEditor({
        kind: "promo",
        chargeId: item.chargeId,
        promotionId: promo.id,
        promotionName: promo.name,
        floorCents: price.priceCents ?? 0,
      })
      return
    }
    conceptMutation.mutate(
      {
        target: `promo-${item.chargeId}-${promo.id}`,
        run: () => editChargeConceptApi(effectiveId as string, item.chargeId, { promotionId: promo.id }),
      },
      { onError: (err) => setRowError({ chargeId: item.chargeId, message: financeErrorMessage(err) }) },
    )
  }

  const savePromotionPrice = (
    target: Extract<Editor, { kind: "promo" }>,
    cents: number,
    reason: string,
  ) =>
    runConcept({
      target: `guardar-${target.chargeId}`,
      run: () =>
        editChargeConceptApi(effectiveId as string, target.chargeId, {
          promotionId: target.promotionId,
          amountCents: cents,
          ...(reason ? { reason } : {}),
        }),
    })

  const removePromotion = (item: AccountPendingItem) => {
    setRowError(null)
    conceptMutation.mutate(
      {
        target: `sin-promo-${item.chargeId}`,
        run: () => editChargeConceptApi(effectiveId as string, item.chargeId, { promotionId: null }),
      },
      { onError: (err) => setRowError({ chargeId: item.chargeId, message: financeErrorMessage(err) }) },
    )
  }

  const addConcept = (description: string, cents: number) => {
    let created: string | null = null
    return runConcept({
      target: "agregar",
      run: async () => {
        created = (await createManualChargeApi(effectiveId as string, { branchId, description, amountCents: cents }))
          .data.id
      },
      done: () => {
        if (created) addCharge(created)
        else form.setFieldValue("advance", false)
      },
    })
  }

  const addProduct = (product: SaleProduct, quantity: number, saleKey: string) => {
    const unitPriceCents = product.salePriceCents ?? 0
    let created: ProductCharge | null = null
    return runConcept({
      target: "producto",
      run: async () => {
        created = (
          await createProductChargeApi(effectiveId as string, {
            productId: product.productId,
            quantity,
            branchId,
            requestId: saleKey,
          })
        ).data
      },
      done: () => {
        const charge: ProductCharge | null = created
        if (charge) {
          addCharge(charge.id)
          setSoldHere((current) => ({
            ...current,
            [charge.id]: { quantity, unitPriceCents, branchName: sedeName || "la sede" },
          }))
        } else form.setFieldValue("advance", false)
        // Salió de la sede: lo que hay cambia en la lista y en Inventario.
        void queryClient.invalidateQueries({ queryKey: ["sale-products"] })
        void queryClient.invalidateQueries({ queryKey: ["inventory"] })
      },
    })
  }

  const addSplitLine = () => {
    const current = form.state.values
    const used = new Set(split ? current.payments.map((line) => line.methodId) : method ? [method.id] : [])
    const next = methodList.find((item) => !used.has(item.id))
    const extra: SplitLine = {
      key: keySeq.current++,
      methodId: next?.id ?? "",
      amount: "",
      reference: "",
      auto: true,
    }
    const lines: SplitLine[] = split
      ? current.payments.map((line) => ({ ...line, auto: false }))
      : [
          {
            key: keySeq.current++,
            methodId: method?.id ?? "",
            amount: current.amount,
            reference: hasCash ? "" : current.reference,
            auto: false,
          },
        ]
    form.setFieldValue("payments", rebalance([...lines, extra], amountCents, currency, locale))
  }

  const removeSplitLine = (index: number) => {
    const rest = form.state.values.payments.filter((_, at) => at !== index)
    if (rest.length > 1) {
      void form.removeFieldValue("payments", index)
      followAmount(amountCents)
      return
    }
    // Con un solo medio vuelve la forma simple: botones y un importe.
    form.setFieldValue("payments", [])
    if (rest[0]) {
      form.setFieldValue("methodId", rest[0].methodId)
      form.setFieldValue("reference", rest[0].reference)
    }
  }

  /** Lo que impide cobrar sin depender de lo escrito, dicho junto al pie. */
  const blockedReason = !canWrite
    ? "Tu rol no cobra. Pídeselo a caja."
    : !branchId
      ? "Elige la sede a cuya caja entra el cobro."
      : inlineOpen
        ? "Guarda o cancela el cambio del concepto antes de cobrar."
        : null

  const submitLabel = creditOnly
    ? "Usar saldo a favor"
    : amountCents !== null && amountCents > 0
      ? `Cobrar ${formatMoney(amountCents, currency, locale)}`
      : "Cobrar"

  const editorFor = (item: AccountPendingItem) => {
    if (!editor || editor.chargeId !== item.chargeId) return null
    if (editor.kind === "promo") {
      return (
        <PromoPriceEditor
          key={`promo-${editor.promotionId}`}
          idPrefix={uid}
          editorId={`${uid}-editor-${item.chargeId}`}
          promotionName={editor.promotionName}
          floorCents={editor.floorCents}
          currency={currency}
          locale={locale}
          busy={conceptMutation.isPending}
          pending={conceptBusy(`guardar-${item.chargeId}`)}
          onSave={(cents, reason) => savePromotionPrice(editor, cents, reason)}
          onCancel={closeInline}
        />
      )
    }
    return (
      <AmountEditor
        key="importe"
        idPrefix={uid}
        editorId={`${uid}-editor-${item.chargeId}`}
        item={item}
        currency={currency}
        locale={locale}
        removeQuestion={
          // Un producto vendido vuelve a la sede de donde salió.
          item.productId && item.productQuantity
            ? `Se quita de la cuenta y ${item.productQuantity === 1 ? "vuelve 1" : `vuelven ${item.productQuantity}`} a ${item.branchId === branchId && sedeName ? sedeName : "la sede"}. ¿Lo quitas?`
            : "Se quita de la cuenta y queda en el historial. ¿Lo quitas?"
        }
        busy={conceptMutation.isPending}
        savePending={conceptBusy(`guardar-${item.chargeId}`)}
        removePending={conceptBusy(`quitar-${item.chargeId}`)}
        onSave={(cents, reason) => saveAmount(item, cents, reason)}
        onRemove={(reason) => removeConcept(item, reason)}
        onCancel={closeInline}
      />
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
      {...surface}
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
      isLoading={Boolean(effectiveId) && account.isPending}
      submitLabel={submitLabel}
      submitDisabled={
        !data ||
        blockedReason !== null ||
        conceptMutation.isPending ||
        (!creditOnly && (!methods.isSuccess || noMethods))
      }
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <div className="flex flex-col gap-6">
        {patientId === null ? (
          // El buscador de personas de toda la aplicación, solo con pacientes (ADR 0029).
          <form.AppField name="patient">
            {(field) => (
              <field.Control label="Paciente" id={`${uid}-paciente`}>
                {(control) => (
                  <PersonPicker
                    id={control.id}
                    label="Paciente"
                    patientsOnly
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    value={
                      field.state.value
                        ? {
                            id: `ficha:${field.state.value.id}`,
                            name: field.state.value.name,
                            patientId: field.state.value.id,
                            document: field.state.value.document,
                          }
                        : null
                    }
                    onChange={(person) => {
                      // Otro paciente: borrador nuevo, con la misma clave de cobro.
                      form.reset()
                      setSelectInit(false)
                      setAmountTouched(false)
                      closeInline()
                      setRowError(null)
                      field.handleChange(
                        person?.patientId
                          ? {
                              id: person.patientId,
                              name: person.name,
                              document: person.document ?? null,
                              sex: person.sex ?? null,
                            }
                          : null,
                      )
                    }}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
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
            <form.AppField name="chargeIds">
              {(chargesField) => (
                <chargesField.Group legend="Qué paga" className="min-w-0 gap-3">
                  {(chargesControl) => (
                    <>
                      {values.advance ? (
                        <p className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
                          Adelanto: no paga un concepto. Queda como saldo a favor y se usa solo en el
                          próximo cobro.
                        </p>
                      ) : pending.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No tiene nada pendiente.</p>
                      ) : (
                        <ul className="flex flex-col divide-y rounded-xl border">
                          {pending.map((item) => {
                            const checked = chargesField.state.value.includes(item.chargeId)
                            // Un producto vendido: «15.00 c/u · salieron 2 de …», agregado ahora o antes.
                            const sold =
                              soldHere[item.chargeId] ??
                              (item.productId && item.productQuantity
                                ? {
                                    quantity: item.productQuantity,
                                    unitPriceCents: Math.round(item.totalCents / item.productQuantity),
                                    branchName: item.branchId === branchId && sedeName ? sedeName : "la sede",
                                  }
                                : undefined)
                            // Con pagos aplicados el concepto ya no se corrige: se cobra lo que falta.
                            const editable = canWrite && item.paidCents === 0
                            const editing = editor?.chargeId === item.chargeId
                            const promotion = editable ? promotionFor(item) : null
                            const itemError =
                              !editing && rowError?.chargeId === item.chargeId ? rowError.message : null
                            return (
                              <li key={item.chargeId} className="flex flex-col gap-2 px-3 py-2.5">
                                <div className="flex items-start gap-2">
                                  <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-sm">
                                    <Checkbox
                                      className="mt-0.5"
                                      checked={checked}
                                      disabled={busy}
                                      aria-invalid={chargesControl.invalid || undefined}
                                      aria-describedby={chargesControl.describedBy}
                                      onCheckedChange={() => {
                                        chargesField.handleChange(
                                          checked
                                            ? chargesField.state.value.filter((id) => id !== item.chargeId)
                                            : [...chargesField.state.value, item.chargeId],
                                        )
                                        setAmountTouched(false)
                                      }}
                                    />
                                    <span className="min-w-0 flex-1">
                                      <span className="block break-words font-medium">
                                        {item.description}
                                        {item.visitNumber && item.visitsPlanned
                                          ? `, visita ${item.visitNumber} de ${item.visitsPlanned}`
                                          : ""}
                                      </span>
                                      {sold ? (
                                        <span className="block text-xs text-muted-foreground">
                                          {sold.quantity > 1
                                            ? `${formatAmountPlain(sold.unitPriceCents, currency, locale)} c/u · `
                                            : ""}
                                          {saleDeductionWords(sold.quantity, sold.branchName)}
                                        </span>
                                      ) : null}
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
                                        setRowError(null)
                                        setAdding(false)
                                        setAddingProduct(false)
                                        setEditor(editing ? null : { kind: "amount", chargeId: item.chargeId })
                                      }}
                                    >
                                      <MoreHorizontal aria-hidden />
                                    </Button>
                                  ) : null}
                                </div>
                                {promotion}
                                {itemError ? (
                                  <p role="alert" className="text-sm text-destructive">
                                    {itemError}
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
                        <OtherConceptForm
                          idPrefix={uid}
                          currency={currency}
                          locale={locale}
                          branchId={branchId}
                          busy={conceptMutation.isPending}
                          pending={conceptBusy("agregar")}
                          onAdd={addConcept}
                          onCancel={closeInline}
                        />
                      ) : addingProduct ? (
                        <ProductForm
                          idPrefix={uid}
                          open={open}
                          branchId={branchId}
                          sedeName={sedeName}
                          locale={locale}
                          busy={conceptMutation.isPending}
                          pending={conceptBusy("producto")}
                          onAdd={addProduct}
                          onCancel={closeInline}
                        />
                      ) : canWrite ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              setEditor(null)
                              setAdding(false)
                              setRowError(null)
                              setAddingProduct(true)
                            }}
                          >
                            <Plus aria-hidden />
                            Agregar producto
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              setEditor(null)
                              setAddingProduct(false)
                              setRowError(null)
                              setAdding(true)
                            }}
                          >
                            <Plus aria-hidden />
                            Agregar otro concepto
                          </Button>
                          {values.advance ? (
                            pending.length > 0 ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => {
                                  form.setFieldValue("advance", false)
                                  setAmountTouched(false)
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
                                form.setFieldValue("advance", true)
                                form.setFieldValue("amount", "")
                                form.setFieldValue("payments", [])
                                setAmountTouched(false)
                              }}
                            >
                              Cobrar un adelanto
                            </Button>
                          )}
                        </div>
                      ) : null}
                    </>
                  )}
                </chargesField.Group>
              )}
            </form.AppField>

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
                <form.AppField name="amount">
                  {(field) => (
                    <field.Control
                      label="Importe"
                      id={`${uid}-importe`}
                      description={
                        values.advance ? "Todo queda como saldo a favor." : "Si paga una parte, el resto queda por cobrar."
                      }
                    >
                      {(control) => (
                        <MoneyInput
                          id={control.id}
                          currency={currency}
                          locale={locale}
                          value={field.state.value}
                          invalid={control.invalid}
                          aria-describedby={control.describedBy}
                          onBlur={control.onBlur}
                          onChange={(value) => {
                            field.handleChange(value)
                            setAmountTouched(true)
                            followAmount(parseMoneyOrNull(value, currency, locale))
                          }}
                        />
                      )}
                    </field.Control>
                  )}
                </form.AppField>

                <div className="flex flex-col gap-3">
                  {split ? (
                    <form.AppField name="payments" mode="array">
                      {(paymentsField) => (
                        <paymentsField.Group legend="Medios de pago" className="gap-3">
                          {() => (
                            <>
                              <ul className="flex flex-col gap-3">
                                {paymentsField.state.value.map((line, index) => {
                                  const lineMethod = figures.methodById(line.methodId)
                                  const lineName = lineMethod?.name ?? `medio ${index + 1}`
                                  return (
                                    <li key={line.key} className="flex flex-col gap-2 rounded-xl border p-3">
                                      <div className="flex items-start gap-2">
                                        <form.AppField name={`payments[${index}].methodId`}>
                                          {(field) => (
                                            <field.Control
                                              label={`Medio de pago ${index + 1}`}
                                              hideLabel
                                              id={`${uid}-medio-${line.key}`}
                                              className="min-w-0 flex-1"
                                            >
                                              {(control) => (
                                                <ChoiceSelect
                                                  id={control.id}
                                                  aria-invalid={control.invalid || undefined}
                                                  aria-describedby={control.describedBy}
                                                  placeholder="Elige el medio"
                                                  onBlur={control.onBlur}
                                                  value={field.state.value}
                                                  onChange={(event) => field.handleChange(event.target.value)}
                                                >
                                                  {methodList.map((item) => (
                                                    <option key={item.id} value={item.id}>
                                                      {item.name}
                                                    </option>
                                                  ))}
                                                </ChoiceSelect>
                                              )}
                                            </field.Control>
                                          )}
                                        </form.AppField>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon-sm"
                                          className="mt-0.5 shrink-0"
                                          aria-label={`Quitar ${lineName}`}
                                          onClick={() => removeSplitLine(index)}
                                        >
                                          <X aria-hidden />
                                        </Button>
                                      </div>
                                      <form.AppField name={`payments[${index}].amount`}>
                                        {(field) => (
                                          <field.Control
                                            label={`Importe por ${lineName}`}
                                            hideLabel
                                            id={`${uid}-importe-${line.key}`}
                                          >
                                            {(control) => (
                                              <MoneyInput
                                                id={control.id}
                                                currency={currency}
                                                locale={locale}
                                                value={field.state.value}
                                                invalid={control.invalid}
                                                aria-describedby={control.describedBy}
                                                onBlur={control.onBlur}
                                                onChange={(value) => {
                                                  field.handleChange(value)
                                                  form.setFieldValue(`payments[${index}].auto`, false, {
                                                    dontUpdateMeta: true,
                                                  })
                                                  followAmount(parseMoneyOrNull(form.state.values.amount, currency, locale))
                                                }}
                                              />
                                            )}
                                          </field.Control>
                                        )}
                                      </form.AppField>
                                      {lineMethod && lineMethod.typeCode !== CASH_TYPE_CODE ? (
                                        <form.AppField name={`payments[${index}].reference`}>
                                          {(field) => (
                                            <field.TextField
                                              label="N.º de operación (opcional)"
                                              id={`${uid}-operacion-${line.key}`}
                                              autoComplete="off"
                                              maxLength={MAX_REFERENCE}
                                            />
                                          )}
                                        </form.AppField>
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
                          )}
                        </paymentsField.Group>
                      )}
                    </form.AppField>
                  ) : (
                    <>
                      <form.AppField name="methodId">
                        {(field) => (
                          <field.Group legend="Medio de pago" className="gap-3">
                            {(control) => (
                              <PaymentMethodButtons
                                id={control.id}
                                methods={methodList}
                                value={method?.id ?? ""}
                                invalid={control.invalid}
                                aria-describedby={control.describedBy}
                                onBlur={control.onBlur}
                                onChange={(id) => field.handleChange(id)}
                              />
                            )}
                          </field.Group>
                        )}
                      </form.AppField>
                      {method && !hasCash ? (
                        <form.AppField name="reference">
                          {(field) => (
                            <field.TextField
                              label="N.º de operación (opcional)"
                              id={`${uid}-operacion`}
                              autoComplete="off"
                              maxLength={MAX_REFERENCE}
                            />
                          )}
                        </form.AppField>
                      ) : null}
                    </>
                  )}
                  {hasCash ? (
                    <div className="grid grid-cols-2 items-end gap-3">
                      <form.AppField name="cashReceived">
                        {(field) => (
                          <field.Control label="Recibes en efectivo" id={`${uid}-recibes`}>
                            {(control) => (
                              <MoneyInput
                                id={control.id}
                                currency={currency}
                                locale={locale}
                                value={field.state.value}
                                invalid={control.invalid || (change !== null && change < 0)}
                                aria-describedby={control.describedBy}
                                onBlur={control.onBlur}
                                onChange={(value) => field.handleChange(value)}
                              />
                            )}
                          </field.Control>
                        )}
                      </form.AppField>
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
              <form.AppField name="payerContactId">
                {() => (
                  <PayerField
                    id={`${uid}-quien-paga`}
                    options={payerOptions}
                    displayName={displayName}
                    displaySex={displaySex}
                  />
                )}
              </form.AppField>
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

        {blockedReason ? (
          // «Cobrar» queda deshabilitado por esto: se dice al final, junto al pie.
          <p role="status" className="text-sm font-medium">
            {blockedReason}
          </p>
        ) : null}
      </div>
    </FormDrawer>
  )
}

/** «Paga …» y, al tocar «Cambiar», quién paga: el paciente o uno de sus responsables vigentes. */
function PayerField({
  id,
  options,
  displayName,
  displaySex,
}: {
  id: string
  options: Array<{ contactId: string; name: string; role: string }>
  displayName: string
  displaySex: string | null
}) {
  const field = useFieldContext<string>()
  const { control, errors, errorId } = useFieldControl({ id, hasDescription: false })
  const [open, setOpen] = useState(false)
  const value = field.state.value
  const payer = options.find((option) => option.contactId === value) ?? null
  // Con un rechazo del servidor la elección queda a la vista para corregirla.
  const expanded = open || control.invalid
  return (
    <div className="flex flex-col gap-2" data-invalid={control.invalid || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="min-w-0 break-words">
          Paga{" "}
          <strong className="font-semibold">{payer ? payer.name : displayName || "el paciente"}</strong>
          {payer ? `, ${payer.role}` : displayName ? `, ${patientNoun(displaySex)}` : ""}
        </span>
        {options.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={expanded ? control.id : undefined}
            onClick={() => setOpen((current) => !current)}
          >
            Cambiar
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <RadioGroup
          id={control.id}
          aria-label="Quién paga"
          aria-invalid={control.invalid || undefined}
          aria-describedby={control.describedBy}
          value={value || "paciente"}
          onValueChange={(next) => {
            field.handleChange(next === "paciente" ? "" : String(next))
            field.handleBlur()
            setOpen(false)
          }}
        >
          {[
            {
              value: "paciente",
              label: `${displayName || "El paciente"}, ${patientNoun(displaySex)}`,
            },
            ...options.map((option) => ({
              value: option.contactId,
              label: `${option.name}, ${option.role}`,
            })),
          ].map((option) => (
            <FieldLabel
              key={option.value}
              className={cn(
                "flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-xl border px-3 text-sm font-normal",
                (value || "paciente") === option.value && "border-primary bg-primary-soft",
              )}
            >
              <RadioGroupItem value={option.value} />
              <span className="min-w-0 break-words">{option.label}</span>
            </FieldLabel>
          ))}
        </RadioGroup>
      ) : null}
      {control.invalid ? <FieldError id={errorId} errors={errors.map((message) => ({ message }))} /> : null}
    </div>
  )
}

/** El error general de un bloque en línea, junto a sus botones. */
function InlineFormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  )
}

/** Corregir el importe de un concepto (con motivo) o quitarlo. */
function AmountEditor({
  idPrefix,
  editorId,
  item,
  currency,
  locale,
  removeQuestion,
  busy,
  savePending,
  removePending,
  onSave,
  onRemove,
  onCancel,
}: {
  idPrefix: string
  editorId: string
  item: AccountPendingItem
  currency: string
  locale: string
  removeQuestion: string
  busy: boolean
  savePending: boolean
  removePending: boolean
  onSave: (cents: number, reason: string) => Promise<unknown>
  onRemove: (reason: string) => Promise<unknown>
  onCancel: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  /** «Guardar cambio» pide importe y motivo; «Quitar concepto», solo el motivo. */
  const intent = useRef<"save" | "remove">("save")
  const [confirmRemove, setConfirmRemove] = useState(false)
  const form = useAppForm({
    defaultValues: { amount: formatMoneyInput(item.totalCents, currency, locale), reason: "" },
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (intent.current === "save") {
          const cents = parseMoneyOrNull(value.amount, currency, locale)
          if (cents === null || cents <= 0) fields.amount = "Escribe el nuevo importe."
          else if (cents === item.totalCents) fields.amount = "Es el mismo importe: no hay nada que guardar."
          if (!value.reason.trim()) fields.reason = "Escribe el motivo del cambio."
        } else if (!value.reason.trim()) {
          fields.reason = "Escribe el motivo para quitarlo."
        }
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      if (intent.current === "remove") {
        // Primero se pregunta; «Sí, quitar» lo quita.
        if (!confirmRemove) {
          setConfirmRemove(true)
          return
        }
        await onRemove(value.reason.trim())
        return
      }
      await onSave(parseMoneyOrNull(value.amount, currency, locale) as number, value.reason.trim())
    },
  })
  const error = useFormSubmitError(form)
  const run = (next: "save" | "remove") => {
    intent.current = next
    void submitForm(form, { fieldMap: CONCEPT_FIELDS, formMessage: financeFormMessage, root: root.current })
  }
  const unconfirm = { onChange: () => setConfirmRemove(false) }
  return (
    <div ref={root} id={editorId} className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-3">
      <form.AppField name="amount" listeners={unconfirm}>
        {(field) => (
          <field.Control label="Nuevo importe" id={`${idPrefix}-nuevo-importe`}>
            {(control) => (
              <MoneyInput
                id={control.id}
                autoFocus
                currency={currency}
                locale={locale}
                value={field.state.value}
                invalid={control.invalid}
                aria-describedby={control.describedBy}
                onBlur={control.onBlur}
                onChange={(value) => field.handleChange(value)}
                onKeyDown={onEnter(() => run("save"))}
              />
            )}
          </field.Control>
        )}
      </form.AppField>
      <form.AppField name="reason" listeners={unconfirm}>
        {(field) => (
          <field.TextField
            label="Motivo"
            id={`${idPrefix}-motivo`}
            maxLength={MAX_REASON}
            onKeyDown={onEnter(() => run("save"))}
          />
        )}
      </form.AppField>
      <InlineFormError message={error} />
      {confirmRemove ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirmar quitar concepto">
          <p className="min-w-0 flex-1 basis-full text-sm sm:basis-0">{removeQuestion}</p>
          <SubmitButton
            size="sm"
            variant="destructive"
            pending={removePending}
            disabled={busy}
            onClick={() => run("remove")}
          >
            Sí, quitar
          </SubmitButton>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRemove(false)}>
            No
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton size="sm" pending={savePending} disabled={busy} onClick={() => run("save")}>
            Guardar cambio
          </SubmitButton>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            Cancelar
          </Button>
          <span className="flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => run("remove")}
          >
            Quitar concepto
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Queda registrado quién lo cambió, cuándo y por qué.</p>
    </div>
  )
}

/** El precio final de una promoción «desde»: el motivo solo si baja del mínimo. */
function PromoPriceEditor({
  idPrefix,
  editorId,
  promotionName,
  floorCents,
  currency,
  locale,
  busy,
  pending,
  onSave,
  onCancel,
}: {
  idPrefix: string
  editorId: string
  promotionName: string
  floorCents: number
  currency: string
  locale: string
  busy: boolean
  pending: boolean
  onSave: (cents: number, reason: string) => Promise<unknown>
  onCancel: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const form = useAppForm({
    defaultValues: { amount: formatMoneyInput(floorCents, currency, locale), reason: "" },
    validators: {
      onSubmit: ({ value }) => {
        const cents = parseMoneyOrNull(value.amount, currency, locale)
        if (cents === null || cents <= 0) return { fields: { amount: "Escribe el precio final." } }
        if (cents < floorCents && !value.reason.trim()) {
          return {
            fields: { reason: `El precio baja de ${formatMoney(floorCents, currency, locale)}: escribe el motivo.` },
          }
        }
        return undefined
      },
    },
    onSubmit: async ({ value }) => {
      await onSave(parseMoneyOrNull(value.amount, currency, locale) as number, value.reason.trim())
    },
  })
  const error = useFormSubmitError(form)
  const typed = useStore(form.store, (state) => parseMoneyOrNull(state.values.amount, currency, locale))
  const belowFloor = typed !== null && typed < floorCents
  const save = () =>
    void submitForm(form, { fieldMap: CONCEPT_FIELDS, formMessage: financeFormMessage, root: root.current })
  return (
    <div ref={root} id={editorId} className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-3">
      <p className="text-sm font-medium">Promoción: {promotionName}</p>
      <form.AppField name="amount">
        {(field) => (
          <field.Control
            label="Precio final"
            id={`${idPrefix}-promo-precio`}
            description={`Solo pide un motivo si el precio baja de ${formatMoney(floorCents, currency, locale)}.`}
          >
            {(control) => (
              <MoneyInput
                id={control.id}
                autoFocus
                currency={currency}
                locale={locale}
                value={field.state.value}
                invalid={control.invalid}
                aria-describedby={control.describedBy}
                onBlur={control.onBlur}
                onChange={(value) => field.handleChange(value)}
                onKeyDown={onEnter(save)}
              />
            )}
          </field.Control>
        )}
      </form.AppField>
      {belowFloor ? (
        <form.AppField name="reason">
          {(field) => (
            <field.TextField
              label="Motivo"
              id={`${idPrefix}-promo-motivo`}
              maxLength={MAX_REASON}
              onKeyDown={onEnter(save)}
            />
          )}
        </form.AppField>
      ) : null}
      <InlineFormError message={error} />
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton size="sm" pending={pending} disabled={busy} onClick={save}>
          Aplicar promoción
        </SubmitButton>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}

/** «+ Agregar otro concepto»: qué se cobra y cuánto. */
function OtherConceptForm({
  idPrefix,
  currency,
  locale,
  branchId,
  busy,
  pending,
  onAdd,
  onCancel,
}: {
  idPrefix: string
  currency: string
  locale: string
  branchId: string
  busy: boolean
  pending: boolean
  onAdd: (description: string, cents: number) => Promise<unknown>
  onCancel: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const form = useAppForm({
    defaultValues: { description: "", amount: "" },
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (!value.description.trim()) fields.description = "Escribe qué es lo que se cobra."
        const cents = parseMoneyOrNull(value.amount, currency, locale)
        if (cents === null || cents <= 0) fields.amount = "Escribe el importe."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      if (!branchId) throw new Error("Elige la sede antes de agregar un concepto.")
      await onAdd(value.description.trim(), parseMoneyOrNull(value.amount, currency, locale) as number)
    },
  })
  const error = useFormSubmitError(form)
  const add = () =>
    void submitForm(form, { fieldMap: CONCEPT_FIELDS, formMessage: financeFormMessage, root: root.current })
  return (
    <div ref={root} className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-3">
      <form.AppField name="description">
        {(field) => (
          <field.TextField
            label="Concepto"
            id={`${idPrefix}-otro-concepto`}
            autoFocus
            maxLength={MAX_REASON}
            onKeyDown={onEnter(add)}
          />
        )}
      </form.AppField>
      <form.AppField name="amount">
        {(field) => (
          <field.Control label="Importe" id={`${idPrefix}-otro-importe`}>
            {(control) => (
              <MoneyInput
                id={control.id}
                currency={currency}
                locale={locale}
                value={field.state.value}
                invalid={control.invalid}
                aria-describedby={control.describedBy}
                onBlur={control.onBlur}
                onChange={(value) => field.handleChange(value)}
                onKeyDown={onEnter(add)}
              />
            )}
          </field.Control>
        )}
      </form.AppField>
      <InlineFormError message={error} />
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton size="sm" pending={pending} disabled={busy} onClick={add}>
          Agregar
        </SubmitButton>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}

const NO_SALE_PRICE = "Ponle precio de venta en Inventario: sin precio no se puede cobrar."

/**
 * «+ Agregar producto» (tablero 19): lo que se vende, con su precio y lo que
 * hay en la sede del cobro; el importe se calcula. Cada vez que se abre lleva
 * su clave: si se corta la red y se vuelve a tocar «Agregar», el servidor
 * devuelve la misma venta sin descontar otra vez.
 */
function ProductForm({
  idPrefix,
  open,
  branchId,
  sedeName,
  locale,
  busy,
  pending,
  onAdd,
  onCancel,
}: {
  idPrefix: string
  open: boolean
  branchId: string
  sedeName: string
  locale: string
  busy: boolean
  pending: boolean
  onAdd: (product: SaleProduct, quantity: number, requestId: string) => Promise<unknown>
  onCancel: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const saleKey = useRef<string>(crypto.randomUUID())
  const [productQuery, setProductQuery] = useState("")
  // Busca en el servidor lo que se vende en la sede del cobro (la misma de los conceptos).
  const productSearch = useDeferredValue(productQuery.trim())
  const saleProducts = useQuery({
    queryKey: ["sale-products", branchId, productSearch],
    queryFn: () => fetchSaleProducts({ branchId, q: productSearch || undefined, limit: 20 }),
    enabled: open && Boolean(branchId),
    placeholderData: (previous) => previous,
    staleTime: 15_000,
  })
  const form = useAppForm({
    defaultValues: { product: null as SaleProduct | null, quantity: "1" },
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (!value.product) fields.product = "Busca y elige el producto."
        else if (value.product.salePriceCents === null) fields.product = NO_SALE_PRICE
        const quantity = parseWholeQuantity(value.quantity, locale)
        if (quantity === null || quantity < 1 || quantity > SALE_QUANTITY_MAX) {
          fields.quantity = `La cantidad va de 1 a ${SALE_QUANTITY_MAX}, sin decimales.`
        }
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      if (!branchId) throw new Error("Elige la sede antes de agregar un producto.")
      await onAdd(value.product as SaleProduct, parseWholeQuantity(value.quantity, locale) as number, saleKey.current)
    },
  })
  const error = useFormSubmitError(form)
  const chosenProduct = useStore(form.store, (state) => state.values.product)
  const quantityText = useStore(form.store, (state) => state.values.quantity)
  const productQuantity = parseWholeQuantity(quantityText, locale)
  const productAmount =
    chosenProduct && chosenProduct.salePriceCents !== null && productQuantity !== null && productQuantity > 0
      ? chosenProduct.salePriceCents * productQuantity
      : null
  const productStockNote =
    chosenProduct && chosenProduct.salePriceCents !== null
      ? saleStockNote(chosenProduct, productQuantity ?? 1, sedeName || "esta sede")
      : null
  const saleDetail = (item: SaleProduct) =>
    [
      item.salePriceCents !== null && item.currency
        ? formatMoney(item.salePriceCents, item.currency, locale)
        : "Sin precio de venta",
      item.onHandText ? `hay ${item.onHandText}` : `no hay en ${sedeName || "esta sede"}`,
    ].join(" · ")
  const add = () =>
    void submitForm(form, { fieldMap: { productId: "product" }, formMessage: financeFormMessage, root: root.current })
  return (
    <div ref={root} className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-3">
      <form.AppField
        name="product"
        validators={{ onChange: ({ value }) => (value && value.salePriceCents === null ? NO_SALE_PRICE : undefined) }}
      >
        {(field) => (
          <field.Control
            label="Producto"
            id={`${idPrefix}-producto`}
            description={
              productStockNote ? (
                <span role="status" className="font-medium text-warning">
                  {productStockNote}
                </span>
              ) : chosenProduct ? (
                saleDetail(chosenProduct)
              ) : (
                `Solo lo que se vende, con su precio y lo que hay en ${sedeName || "la sede del cobro"}.`
              )
            }
          >
            {(control) => (
              <ResourceSelect
                id={control.id}
                invalid={control.invalid}
                aria-describedby={control.describedBy}
                onBlur={control.onBlur}
                placeholder="Buscar producto…"
                value={field.state.value?.productId ?? ""}
                options={(saleProducts.data?.data.items ?? []).map((item) => ({
                  id: item.productId,
                  label: item.name,
                  detail: saleDetail(item),
                }))}
                onQueryChange={setProductQuery}
                onChange={(productId) => {
                  const found =
                    (saleProducts.data?.data.items ?? []).find((item) => item.productId === productId) ?? null
                  field.handleChange(found)
                  // Sin precio de venta se dice en el acto, no al pulsar «Agregar».
                  field.handleBlur()
                }}
                empty={
                  !branchId
                    ? "Elige la sede del cobro para ver lo que se vende."
                    : saleProducts.isPending
                      ? "Buscando productos…"
                      : productSearch
                        ? `Ningún producto a la venta coincide con «${productSearch}».`
                        : "Aún no hay productos a la venta. Se marcan con «Se vende» en Inventario."
                }
              />
            )}
          </field.Control>
        )}
      </form.AppField>
      {saleProducts.isError && !saleProducts.data ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          {financeErrorMessage(saleProducts.error)}
          <Button type="button" size="sm" variant="outline" onClick={() => void saleProducts.refetch()}>
            Reintentar
          </Button>
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <form.AppField name="quantity">
          {(field) => (
            <field.Control
              label={
                <>
                  Cantidad
                  {chosenProduct ? <span className="sr-only">, en {unitFor(2, chosenProduct.unit)}</span> : null}
                </>
              }
              id={`${idPrefix}-producto-cantidad`}
            >
              {(control) => (
                <InputGroup>
                  <InputGroupInput
                    {...control.props}
                    inputMode="numeric"
                    autoComplete="off"
                    className="tabular-nums"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onKeyDown={onEnter(add)}
                  />
                  {chosenProduct ? (
                    <InputGroupAddon align="inline-end">{unitFor(productQuantity ?? 2, chosenProduct.unit)}</InputGroupAddon>
                  ) : null}
                </InputGroup>
              )}
            </field.Control>
          )}
        </form.AppField>
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-producto-importe`}>Importe</FieldLabel>
          <output
            id={`${idPrefix}-producto-importe`}
            aria-live="polite"
            className="flex min-h-9 items-center text-base font-semibold tabular-nums"
          >
            {productAmount !== null && chosenProduct?.currency
              ? formatMoney(productAmount, chosenProduct.currency, locale)
              : "—"}
          </output>
        </Field>
      </div>
      <InlineFormError message={error} />
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton size="sm" pending={pending} disabled={busy} onClick={add}>
          Agregar
        </SubmitButton>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}
