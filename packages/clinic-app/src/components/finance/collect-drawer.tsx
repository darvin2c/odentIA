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
 *
 * Con otra moneda (`useOrgSecondCurrency`) se abre en la moneda de la deuda: un
 * cobro cancela una moneda y entra en una, y lo que se escribe está en la que paga.
 * Las cuentas son las del servidor (`collectExchange`); aquí solo se muestran. Sin
 * otra moneda no aparece ningún control de más y el cuerpo es el de siempre.
 */
import {
  collectExchange,
  convertCents,
  currencySymbol,
  currencyWord,
  documentText,
  formatExchangeRateInput,
  formatMoney,
  formatMoneyInput,
  parseMoney,
  readExchangeRate,
  unitFor,
} from "@odentia/clinical"
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
  acceptedTotalsKey,
  amountHelpText,
  partialSplitWords,
  CASH_TYPE_CODE,
  type CollectInput,
  type CollectResultBody,
  collectApi,
  createManualChargeApi,
  createProductChargeApi,
  editChargeConceptApi,
  fetchAcceptedTotals,
  fetchActivePromotions,
  fetchPatientAccount3,
  fetchPaymentMethods,
  fetchSaleProducts,
  formatAmountPlain,
  type PaymentMethodOption,
  type ProductCharge,
  type PromotionItem,
  type PromotionOption,
  rateAuthorWords,
  type SaleProduct,
  sentence,
  treatmentLineName,
  voidChargeApi,
} from "../../lib/finance-collect"
import { parseWholeQuantity, saleDeductionWords, saleStockNote } from "../../lib/materials"
import { orgSecondCurrency, useOrgProfile } from "../../lib/org"
import { currencyChoices } from "../../lib/product-words"
import { productUi } from "../../product/product-ui"
import { BranchSwitcher } from "../branch-switcher"
import { ChoiceButtons } from "../choice-buttons"
import { PersonPicker } from "../person-picker"
import { ChoiceSelect } from "../ui/choice-select"
import { RateFarNote, RateField } from "./rate-input"

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
  /** Para qué tratamiento aceptado es el adelanto (la línea de su presupuesto); vacío, a favor. */
  advanceFor: string
  amount: string
  methodId: string
  reference: string
  payments: SplitLine[]
  cashReceived: string
  payerContactId: string
  /** Moneda de lo que cancela o a cuenta de la que queda un adelanto; vacía, la de la clínica. */
  debtCurrency: string
  /** Con qué paga: lo escrito está en ella; vacía, la de la deuda. */
  payCurrency: string
  /** El cambio de este cobro, como se escribe. */
  rate: string
  /** En qué da el vuelto; vacía, lo que corresponde según lo que paga. */
  changeCurrency: string
}

const EMPTY_DRAFT: CollectDraft = {
  patient: null,
  chargeIds: [],
  advance: false,
  advanceFor: "",
  amount: "",
  methodId: "",
  reference: "",
  payments: [],
  cashReceived: "",
  payerContactId: "",
  debtCurrency: "",
  payCurrency: "",
  rate: "",
  changeCurrency: "",
}

/** Lo que el borrador necesita de la pantalla para calcularse y validarse. */
interface CollectRules {
  needsPatient: boolean
  /** Lo pendiente en la moneda de la deuda. */
  pending: AccountPendingItem[]
  /** Lo que tiene a favor en esa moneda. */
  favor: number
  methods: PaymentMethodOption[]
  /** Moneda del negocio. */
  currency: string
  /** La otra moneda de la clínica; null si cobra en una sola. */
  second: string | null
  locale: string
  /** Lo que se puede adelantar por tratamiento, en su moneda. */
  advanceTargets: AdvanceTarget[]
}

/** Un tratamiento aceptado al que se le puede dar un adelanto. */
interface AdvanceTarget {
  budgetItemId: string
  name: string
  currency: string
  toChargeCents: number
}

/** Las cifras del cobro a partir del borrador: lo que se ve y lo que se envía. */
function collectFigures(value: CollectDraft, rules: CollectRules) {
  const { pending, favor, methods, currency: business, second, locale } = rules
  /** D: la moneda de lo que cancela. */
  const debt = value.debtCurrency || business
  /** P: la moneda en que paga; lo que se escribe está en ella. */
  const pay = value.payCurrency || debt
  const money = (text: string) => parseMoneyOrNull(text, pay, locale)
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
  // Hace falta cambio si algo no es moneda del negocio; solo saldo a favor no mueve dinero.
  const needsRate = second !== null && !creditOnly && (debt !== business || pay !== business)
  const rateText = needsRate ? (readExchangeRate(value.rate, locale).rate ?? null) : null
  // El vuelto de quien paga en otra moneda se puede dar en la del negocio. Quien paga
  // en otra que la deuda lo recibe en la del negocio, salvo que elija otra cosa, y el
  // cuerpo lo dice siempre que cruza; el servidor, si no se lo dicen, lo da en la que pagó.
  const changeChoice = hasCash && pay !== business && change !== null && change > 0
  const changeIn = value.changeCurrency || (pay === debt ? pay : business)
  /** La misma cuenta del servidor. */
  const exchange = collectExchange({
    paidCents: amountCents ?? 0,
    paidCurrency: pay,
    dueCents: due,
    currency: debt,
    businessCurrency: business,
    rate: rateText,
    changeCents: change,
    changeIn,
  })
  const { factor, crossChange, changeGiven } = exchange
  const proposed =
    pay === debt
      ? due
      : factor !== null && due > 0
        ? convertCents({
            amountCents: due,
            from: debt,
            to: pay,
            businessCurrency: business,
            factor,
          })
        : null
  /** Lo que cancela lo escrito, en la moneda de la deuda. */
  const cancels = amountCents === null || amountCents <= 0 ? null : exchange.cancels
  return {
    debt,
    pay,
    needsRate,
    rateText,
    proposed,
    cancels,
    changeChoice,
    changeIn,
    crossChange,
    changeGiven,
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
      advanceFor: z.string(),
      amount: z.string(),
      methodId: z.string(),
      reference: z.string().max(MAX_REFERENCE, `Escribe como mucho ${MAX_REFERENCE} caracteres.`),
      payments: z.array(lineSchema),
      cashReceived: z.string(),
      payerContactId: z.string(),
      debtCurrency: z.string(),
      payCurrency: z.string(),
      rate: z.string(),
      changeCurrency: z.string(),
    })
    .superRefine((value, ctx) => {
      const current = rules()
      const { locale } = current
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
      if (figures.needsRate && !figures.rateText) {
        issue(
          ["rate"],
          `${readExchangeRate(value.rate, locale).error ?? "Escribe el cambio"}.`,
        )
      }
      const amountCents = figures.amountCents
      const amountOk = amountCents !== null && amountCents > 0
      const target = value.advance && value.advanceFor
        ? current.advanceTargets.find((row) => row.budgetItemId === value.advanceFor)
        : undefined
      if (!amountOk) {
        issue(["amount"], value.advance ? "Escribe el importe del adelanto." : "Escribe el importe que paga ahora.")
      } else if (target && amountCents > target.toChargeCents) {
        issue(
          ["amount"],
          `Para ${target.name} faltan ${formatMoney(target.toChargeCents, target.currency, locale)}: el adelanto no puede pasar de eso.`,
        )
      } else if (!value.advance && figures.cancels !== null && figures.cancels > figures.due) {
        issue(
          ["amount"],
          `El importe supera lo que falta de lo marcado (${formatMoney(figures.due, figures.debt, locale)}). Para dejar dinero a favor, cobra un adelanto.`,
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
            `Los medios suman ${formatMoney(figures.splitTotal, figures.pay, locale)} y el importe es ${formatMoney(amountCents, figures.pay, locale)}.`,
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


/** El adelanto que quedó escrito para después de cobrar lo que debe, por persona (solo en esta pestaña). */
const carriedAdvance = new Map<string, { amount: string; advanceFor: string; debtCurrency: string; payCurrency: string }>()

export function CollectDrawer({
  patientId,
  patientName,
  patientDocument,
  patientSex,
  branchId,
  branchName,
  currency,
  debtCurrency,
  presetChargeIds,
  presetAdvanceFor,
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
  /** Moneda de la clínica. */
  currency: string
  /** La moneda de lo que se viene a cobrar, si quien abre el cobro la sabe. */
  debtCurrency?: string
  presetChargeIds?: string[]
  /** Abre como adelanto para ese tratamiento aceptado (la línea de su presupuesto). */
  presetAdvanceFor?: string
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
  const orgProfile = useOrgProfile()
  const second = orgSecondCurrency(orgProfile.data)
  const secondCode = second?.currency ?? null
  const orgTimeZone = orgProfile.data?.timezone ?? ""

  const [selectInit, setSelectInit] = useState(false)
  /** El importe sigue a lo marcado hasta que la persona escribe otro. */
  const [amountTouched, setAmountTouched] = useState(false)
  /**
   * El adelanto escrito antes de pasar a «Cobrar lo pendiente»: un cobro es lo
   * pendiente o un adelanto, no los dos (`collectCharge`). Se guarda y se avisa, y
   * vuelve escrito al volver a «Cobrar un adelanto» (QA del 9 nov: se borraba sin aviso).
   */
  const [advanceDraft, setAdvanceDraft] = useState<{
    amount: string
    advanceFor: string
    debtCurrency: string
    payCurrency: string
  } | null>(null)
  /**
   * El importe parcial de lo pendiente escrito antes de ir a «Cobrar un adelanto»: vuelve escrito
   * al volver (repaso del 9 nov, N3: 250 volvía a 450 y el botón cobraba 450 sin que se notara).
   */
  const [pendingDraft, setPendingDraft] = useState<{
    amount: string
    debtCurrency: string
    payCurrency: string
    chargeIds: string[]
  } | null>(null)
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
    second: null,
    locale,
    advanceTargets: [],
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
      // El adelanto que quedó escrito para después («va en un cobro aparte») vuelve al abrir el
      // próximo cobro de esta persona: no se pierde al cerrar (QA antes de entregar, entrega 9).
      if (advanceDraft && !form.state.values.advance) carriedAdvance.set(id, advanceDraft)
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
      const { debt, pay, needsRate, rateText, crossChange, changeIn } = figures
      const base = {
        branchId,
        payerContactId: value.payerContactId || null,
        requestId: requestId.current,
        // Lo de otra moneda viaja solo si hace falta: soles a soles es el cuerpo de siempre.
        ...(debt !== currency ? { currency: debt } : {}),
        ...(pay !== debt ? { tenderCurrency: pay } : {}),
        ...(needsRate && rateText ? { exchangeRate: rateText } : {}),
        ...(crossChange !== null ? { changeCurrency: changeIn } : {}),
      }
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
          ? {
              ...base,
              advanceCents: amountCents,
              ...(value.advanceFor ? { advanceForBudgetItemId: value.advanceFor } : {}),
              payments,
              ...cash,
            }
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
      if (key === "advanceCents" || key === "advanceForBudgetItemId") return "amount"
      if (key === "cashReceivedCents") return "cashReceived"
      if (key === "exchangeRate") return "rate"
      if (key === "tenderCurrency") return "payCurrency"
      if (key === "currency") return "debtCurrency"
      if (key === "changeCurrency") return "changeCurrency"
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
    // Lo que se dejó para «Cobrar un adelanto» en el cobro anterior de esta persona vuelve escrito.
    const carried = patientId ? carriedAdvance.get(patientId) : undefined
    if (patientId) carriedAdvance.delete(patientId)
    setAdvanceDraft(carried ?? null)
    setPendingDraft(null)
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
  // Para qué tratamiento es un adelanto (QA de la ficha del 8 nov): lo aceptado que aún
  // se puede cargar, de lo que se cobra por tratamiento. Lo de por sesión queda a favor.
  const canBudgets = usePermission("budgets.read")
  const acceptedTotals = useQuery({
    queryKey: acceptedTotalsKey(effectiveId),
    queryFn: () => fetchAcceptedTotals(effectiveId as string),
    enabled: open && effectiveId !== null && canBudgets,
    retry: false,
  })
  const placeName = (code: string) => {
    const site = productUi().site
    const place = Number(code)
    return site?.isPlace(place) ? site.placeName(place) : null
  }
  const advanceTargets = useMemo<AdvanceTarget[]>(
    () =>
      (acceptedTotals.data?.data ?? []).flatMap((group) =>
        group.lines
          .filter((line) => line.billingMode !== "session" && line.toChargeCents > 0)
          .map((line) => ({
            budgetItemId: line.budgetItemId,
            name: treatmentLineName(line, placeName),
            currency: group.currency,
            toChargeCents: line.toChargeCents,
          })),
      ),
    // biome-ignore lint/correctness/useExhaustiveDependencies: placeName lee el producto, que no cambia.
    [acceptedTotals.data],
  )
  const responsibilities = useQuery({
    queryKey: ["responsibilities", effectiveId],
    queryFn: () => fetchResponsibilities(effectiveId as string),
    enabled: open && effectiveId !== null,
  })

  const data = account.data?.data ?? null
  // Lo que se cobra en esta clínica, por moneda: nunca sumado.
  const orgCurrencies = useMemo(
    () => (secondCode ? [currency, secondCode] : [currency]),
    [currency, secondCode],
  )
  const debt = values.debtCurrency || currency
  const pay = values.payCurrency || debt
  const favor = data?.byCurrency.find((row) => row.currency === debt)?.aFavor ?? 0
  const pending = useMemo(
    () => (data?.pendiente ?? []).filter((item) => item.saldoCents > 0 && item.currency === debt),
    [data, debt],
  )
  const owedByCurrency = useMemo(
    () =>
      orgCurrencies.flatMap((code) => {
        const rows = (data?.pendiente ?? []).filter(
          (item) => item.saldoCents > 0 && item.currency === code,
        )
        return rows.length
          ? [
              {
                code,
                cents: rows.reduce((sum, item) => sum + item.saldoCents, 0),
                ids: rows.map((item) => item.chargeId),
              },
            ]
          : []
      }),
    [data, orgCurrencies],
  )
  /** Lo que debe en la moneda del adelanto: sin «Para», ese dinero no lo pagaría. */
  const owedInDebt = owedByCurrency.find((row) => row.code === debt) ?? null
  const otherCurrencyCount = useMemo(
    () =>
      (data?.pendiente ?? []).filter(
        (item) => item.saldoCents > 0 && !orgCurrencies.includes(item.currency),
      ).length,
    [data, orgCurrencies],
  )
  const offersPromotions = canWrite && pending.some((item) => item.serviceId !== null)
  const promotions = useQuery({
    queryKey: ["active-promotions"],
    queryFn: () => fetchActivePromotions(),
    enabled: open && offersPromotions,
  })
  const methodList = methods.data?.data ?? []

  rules.current = {
    needsPatient: patientId === null,
    pending,
    favor,
    methods: methodList,
    currency,
    second: secondCode,
    locale,
    advanceTargets,
  }
  const figures = collectFigures(values, rules.current)
  const { autoCredit, due, creditOnly, amountCents, split, method, splitTotal, hasCash, change } =
    figures

  // Selección inicial: se abre en la moneda de la deuda (la que pidió quien abre el
  // cobro o, si debe en las dos, la del negocio), con lo pendiente en ella. Sin nada
  // pendiente nace como adelanto, a cuenta de la moneda de su plan aceptado.
  const orgProfileReady = !orgProfile.isPending
  useEffect(() => {
    if (!open || selectInit || !data || !orgProfileReady) return
    const wanted = (presetChargeIds ?? []).length
      ? data.pendiente.find((item) => presetChargeIds?.includes(item.chargeId))?.currency
      : debtCurrency
    const opening =
      owedByCurrency.find((row) => row.code === wanted) ??
      owedByCurrency.find((row) => row.code === currency) ??
      owedByCurrency[0] ??
      null
    const planned =
      data.planCurrency && orgCurrencies.includes(data.planCurrency) ? data.planCurrency : currency
    const code = opening?.code ?? planned
    const ids = opening?.ids ?? []
    const preset = (presetChargeIds ?? []).filter((id) => ids.includes(id))
    form.setFieldValue("chargeIds", preset.length > 0 ? preset : ids, { dontUpdateMeta: true })
    form.setFieldValue("debtCurrency", code, { dontUpdateMeta: true })
    form.setFieldValue("payCurrency", code, { dontUpdateMeta: true })
    if (second)
      form.setFieldValue("rate", formatExchangeRateInput(second.rate, locale), {
        dontUpdateMeta: true,
      })
    if (!opening) form.setFieldValue("advance", true, { dontUpdateMeta: true })
    setSelectInit(true)
  }, [
    open,
    selectInit,
    data,
    orgProfileReady,
    owedByCurrency,
    orgCurrencies,
    presetChargeIds,
    debtCurrency,
    currency,
    second,
    locale,
    form,
  ])

  /** El adelanto guardado, con su moneda («S/ 400.00»); si no se lee como importe, tal cual. */
  const draftSaid = (draft: { amount: string; payCurrency: string }): string => {
    try {
      return formatMoney(parseMoney(draft.amount, draft.payCurrency, locale), draft.payCurrency, locale)
    } catch {
      return draft.amount
    }
  }

  /** Lo escrito estaba en otra moneda: vuelve a empezar y a seguir a lo marcado. */
  const resetWritten = () => {
    form.setFieldValue("changeCurrency", "")
    form.setFieldValue("cashReceived", "")
    form.setFieldValue("amount", "")
    form.setFieldValue("payments", [])
    setAmountTouched(false)
    // Lo escrito para lo pendiente era de otra moneda o de otro cobro: no vuelve.
    setPendingDraft(null)
  }

  /** Otra moneda de deuda: lo marcado es lo de ella. */
  const chooseDebt = (code: string) => {
    form.setFieldValue("debtCurrency", code)
    form.setFieldValue("payCurrency", code)
    form.setFieldValue("chargeIds", owedByCurrency.find((row) => row.code === code)?.ids ?? [])
    resetWritten()
    closeInline()
    setRowError(null)
  }

  /** Otra moneda de pago. */
  const choosePay = (code: string) => {
    if (code === figures.pay) return
    form.setFieldValue("payCurrency", code)
    resetWritten()
  }

  /** Con una línea «automática», esta completa lo que falta para `totalCents`. */
  // Memorizada: el efecto del importe la usa sin volver a correr en cada render.
  const followAmount = useCallback(
    (totalCents: number | null) => {
      const lines = form.state.values.payments
      if (lines.length === 0) return
      rebalance(lines, totalCents, pay, locale).forEach((line, index) => {
        if (line.amount !== lines[index]?.amount) {
          form.setFieldValue(`payments[${index}].amount`, line.amount, { dontUpdateMeta: true })
        }
      })
    },
    [form, pay, locale],
  )

  // El importe sigue a lo marcado hasta que la persona escribe otro; está en lo que paga.
  const proposed = figures.proposed
  useEffect(() => {
    if (!open || amountTouched || values.advance) return
    const cents = proposed !== null && proposed > 0 ? proposed : null
    const text = cents !== null ? formatMoneyInput(cents, pay, locale) : ""
    if (form.state.values.amount !== text) form.setFieldValue("amount", text, { dontUpdateMeta: true })
    followAmount(cents)
  }, [open, amountTouched, values.advance, proposed, pay, locale, form, followAmount])

  // Va después de seguir el importe: en el mismo paso, lo que propuso para lo pendiente se borra.
  // «Cobrar un adelanto» desde su tratamiento: el cajón llega con «Para» ya elegido.
  const presetDone = useRef(false)
  useEffect(() => {
    if (!open) {
      presetDone.current = false
      return
    }
    if (presetDone.current || !presetAdvanceFor || !selectInit) return
    const target = advanceTargets.find((row) => row.budgetItemId === presetAdvanceFor)
    if (!target) return
    presetDone.current = true
    setPendingDraft(null)
    form.setFieldValue("advance", true)
    form.setFieldValue("advanceFor", target.budgetItemId)
    form.setFieldValue("amount", "")
    form.setFieldValue("payments", [])
    form.setFieldValue("debtCurrency", target.currency)
    form.setFieldValue("payCurrency", target.currency)
    setAmountTouched(false)
  }, [open, presetAdvanceFor, selectInit, advanceTargets, form])

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

  // En un menor (con su representante legal vigente) paga por defecto quien responde por él: su
  // responsable económico o, si no hay, su representante (QA del 10 nov, M3: el ticket salía a
  // nombre del niño). Solo si nadie eligió todavía; «Cambiar» sigue ofreciendo al paciente.
  const payerByDefault = useMemo(() => {
    const current = (responsibilities.data?.data ?? []).filter((row) => row.isCurrent)
    if (!current.some((row) => row.kind === "representante_legal")) return null
    return (
      current.find((row) => row.kind === "responsable_economico")?.contactId ??
      current.find((row) => row.kind === "representante_legal")?.contactId ??
      null
    )
  }, [responsibilities.data])
  const payerDefaulted = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: se repone al cerrar y con cada paciente.
  useEffect(() => {
    payerDefaulted.current = false
  }, [open, effectiveId])
  useEffect(() => {
    if (!open || payerDefaulted.current || !payerByDefault) return
    payerDefaulted.current = true
    // Sin tocar su estado: un valor por defecto no es un cambio, y cerrar no debe preguntar
    // «¿Salir sin guardar?» (e2e de caja, ficha por rol).
    if (!form.getFieldValue("payerContactId"))
      form.setFieldValue("payerContactId", payerByDefault, { dontUpdateMeta: true })
  }, [open, payerByDefault, form])

  /** Promociones vigentes que incluyen el servicio del concepto, en la moneda de la clínica. */
  const offersFor = (item: AccountPendingItem): Array<{ promo: PromotionOption; price: PromotionItem }> => {
    if (!item.serviceId) return []
    return (promotions.data ?? []).flatMap((promo) =>
      promo.items
        .filter(
          (price) =>
            price.serviceId === item.serviceId &&
            price.currency === debt &&
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
        created = (
          await createManualChargeApi(effectiveId as string, {
            branchId,
            description,
            amountCents: cents,
            ...(debt !== currency ? { currency: debt } : {}),
          })
        ).data.id
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
          // Se vende en su moneda: el cobro va a ella, porque cancela una sola.
          if (charge.currency !== debt && orgCurrencies.includes(charge.currency)) {
            chooseDebt(charge.currency)
            form.setFieldValue("chargeIds", [charge.id])
          }
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
    form.setFieldValue("payments", rebalance([...lines, extra], amountCents, pay, locale))
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
      ? `Cobrar ${formatMoney(amountCents, pay, locale)}`
      : "Cobrar"

  // Con otra moneda, lo que cancela se dice junto al importe.
  const word = (code: string) => currencyWord(code, locale)
  const amountHelp = values.advance && values.advanceFor
    ? "Lo que paga va entero a ese tratamiento."
    : amountHelpText({
    hasSecond: second !== null,
    advance: values.advance,
    pay,
    debt,
    cancels: figures.cancels,
    due,
    locale,
    owesOther: owedByCurrency.some((row) => row.code !== debt),
  })
  // Un pago parcial de varios conceptos dice a cuál va, antes de cobrar.
  const splitHelp =
    values.advance || pay !== debt
      ? null
      : partialSplitWords(
          pending.filter((item) => values.chargeIds.includes(item.chargeId)),
          figures.cancels,
          debt,
          locale,
          favor,
        )
  const rateAuthor = second && orgTimeZone ? rateAuthorWords(second, locale, orgTimeZone) : ""
  const rateHelp = !second
    ? ""
    : pay !== debt
      ? `${sentence(`Tipo de cambio de hoy: ${formatExchangeRateInput(second.rate, locale)}${rateAuthor ? `, ${rateAuthor}` : ""}`)} Si lo cambias aquí, vale solo para este cobro.`
      : "No cambia lo que paga: es para saber cuánto vale en tus reportes."
  const chosenTarget = values.advance && values.advanceFor
    ? (advanceTargets.find((row) => row.budgetItemId === values.advanceFor) ?? null)
    : null
  // Un adelanto para un tratamiento se paga en su moneda: no se elige otra.
  const showOtherCurrency = second !== null && !creditOnly && !(values.advance && values.advanceFor)
  const cashLine =
    second !== null && hasCash && pay !== currency && amountCents !== null && amountCents > 0
      ? figures.crossChange !== null &&
        figures.receivedCents !== null &&
        figures.changeGiven !== null
        ? `A la caja de ${word(pay)} entran ${formatMoney(figures.receivedCents, pay, locale)}. De la caja de ${word(figures.changeIn)} salen ${formatMoney(figures.changeGiven, figures.changeIn, locale)}.`
        : `A la caja de ${word(pay)} entran ${formatMoney(figures.cashPortion, pay, locale)}.`
      : null

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
          currency={debt}
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
        currency={debt}
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
                  : `quedaría en ${formatAmountPlain(price.priceCents ?? 0, debt, locale)}`}
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
                      {second !== null && !values.advance && owedByCurrency.length > 1 ? (
                        <div className="flex flex-col gap-1.5">
                          <ChoiceButtons
                            aria-label="Moneda de lo que paga"
                            tone="primary"
                            value={debt}
                            options={owedByCurrency.map((row) => ({
                              value: row.code,
                              label: `En ${word(row.code)} · ${formatMoney(row.cents, row.code, locale)}`,
                            }))}
                            onChange={chooseDebt}
                          />
                          <p className="text-sm text-muted-foreground">
                            Cada moneda lleva su ticket. Al terminar, se ofrece cobrar lo otro.
                          </p>
                        </div>
                      ) : null}
                      {values.advance ? (
                        <>
                          {advanceTargets.length > 0 ? (
                            <AdvanceForChoice
                              uid={uid}
                              targets={advanceTargets}
                              value={values.advanceFor}
                              locale={locale}
                              onChange={(id) => {
                                form.setFieldValue("advanceFor", id)
                                const target = advanceTargets.find((row) => row.budgetItemId === id)
                                // Se paga en la moneda del tratamiento; lo escrito en otra no se relee en esta.
                                if (target && (target.currency !== debt || target.currency !== pay)) resetWritten()
                                if (target) {
                                  form.setFieldValue("debtCurrency", target.currency)
                                  form.setFieldValue("payCurrency", target.currency)
                                }
                              }}
                            />
                          ) : null}
                          {!chosenTarget && owedInDebt && owedInDebt.cents > favor ? (
                            // Con deuda, un adelanto suelto la dejaba igual y la ficha mostraba tres cifras
                            // (QA del 9 nov, repaso 3): se avisa y se ofrece pagar lo que debe, sin frenar.
                            <div role="status" className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-sm">
                              <p>
                                Debe {formatMoney(owedInDebt.cents - favor, owedInDebt.code, locale)}. Este adelanto no
                                paga esa deuda: queda a favor, aparte, hasta su próximo cobro.
                              </p>
                              <Button
                                type="button"
                                size="sm"
                                className="self-start"
                                disabled={busy}
                                onClick={() => {
                                  // Lo escrito va a lo que debe, empezando por lo más antiguo. Lo que pase de lo que
                                  // debe no cabe en ese cobro: queda escrito como adelanto, para después.
                                  const written = form.state.values.amount.trim()
                                  const writtenCents = written ? parseMoneyOrNull(written, debt, locale) : null
                                  const owedCents = Math.max(0, owedInDebt.cents - favor)
                                  form.setFieldValue("advance", false)
                                  form.setFieldValue("advanceFor", "")
                                  form.setFieldValue("chargeIds", owedInDebt.ids)
                                  setPendingDraft(null)
                                  if (writtenCents !== null && writtenCents > owedCents && owedCents > 0) {
                                    setAdvanceDraft({
                                      amount: formatMoneyInput(writtenCents - owedCents, debt, locale),
                                      advanceFor: "",
                                      debtCurrency: form.state.values.debtCurrency,
                                      payCurrency: form.state.values.payCurrency,
                                    })
                                    form.setFieldValue("amount", formatMoneyInput(owedCents, debt, locale))
                                    setAmountTouched(true)
                                  } else {
                                    setAdvanceDraft(null)
                                    if (written) {
                                      form.setFieldValue("amount", written)
                                      setAmountTouched(true)
                                    } else setAmountTouched(false)
                                  }
                                }}
                              >
                                Mejor, a lo que debe
                              </Button>
                            </div>
                          ) : (
                            <p className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
                              {chosenTarget
                                ? `Queda pagado en ${chosenTarget.name}, del que faltan ${formatMoney(chosenTarget.toChargeCents, chosenTarget.currency, locale)} por cobrar. Al hacerlo se cobra solo lo que falta, y no se usa en otro cobro. Si se devuelve, es entero.`
                                : "Adelanto: no paga un concepto. Queda como saldo a favor y se usa solo en el próximo cobro."}
                            </p>
                          )}
                          {second !== null && !values.advanceFor ? (
                            <div className="flex flex-col gap-1.5">
                              <span id={`${uid}-a-cuenta`} className="text-sm font-medium">
                                Queda a cuenta de
                              </span>
                              <ChoiceButtons
                                aria-labelledby={`${uid}-a-cuenta`}
                                tone="primary"
                                value={debt}
                                options={orgCurrencies.map((code) => ({
                                  value: code,
                                  label: `Lo que debe en ${word(code)}`,
                                }))}
                                onChange={(code) => form.setFieldValue("debtCurrency", code)}
                              />
                            </div>
                          ) : null}
                        </>
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
                                            ? `${formatAmountPlain(sold.unitPriceCents, debt, locale)} c/u · `
                                            : ""}
                                          {saleDeductionWords(sold.quantity, sold.branchName)}
                                        </span>
                                      ) : null}
                                      {item.paidCents > 0 ? (
                                        <span className="block text-xs text-muted-foreground">
                                          Costó {formatAmountPlain(item.totalCents, debt, locale)} ·
                                          pagó {formatAmountPlain(item.paidCents, debt, locale)}
                                        </span>
                                      ) : null}
                                      {!editable && item.promotionName ? (
                                        <span className="block text-xs text-muted-foreground">
                                          Promoción: {item.promotionName}
                                        </span>
                                      ) : null}
                                    </span>
                                    <span className="shrink-0 font-semibold tabular-nums">
                                      {second
                                        ? formatMoney(item.saldoCents, debt, locale)
                                        : formatAmountPlain(item.saldoCents, debt, locale)}
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
                            − {formatAmountPlain(autoCredit, debt, locale)}
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
                          currency={debt}
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
                            owedByCurrency.length > 0 ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => {
                                  const written = form.state.values.amount.trim()
                                  if (written)
                                    setAdvanceDraft({
                                      amount: written,
                                      advanceFor: form.state.values.advanceFor,
                                      debtCurrency: form.state.values.debtCurrency,
                                      payCurrency: form.state.values.payCurrency,
                                    })
                                  form.setFieldValue("advance", false)
                                  // Lo que había escrito de lo pendiente vuelve con su moneda y lo marcado;
                                  // si no, sigue a lo marcado.
                                  const draft = pendingDraft
                                  setPendingDraft(null)
                                  if (draft) {
                                    form.setFieldValue("debtCurrency", draft.debtCurrency)
                                    form.setFieldValue("payCurrency", draft.payCurrency)
                                    form.setFieldValue("chargeIds", draft.chargeIds)
                                    form.setFieldValue("amount", draft.amount)
                                    setAmountTouched(true)
                                  } else {
                                    setAmountTouched(false)
                                    // Lo pendiente está en otra moneda: el cobro va a ella.
                                    if (pending.length === 0)
                                      chooseDebt(owedByCurrency[0]?.code ?? debt)
                                  }
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
                                // Un importe escrito a mano para lo pendiente se guarda para la vuelta.
                                setPendingDraft(
                                  amountTouched
                                    ? {
                                        amount: form.state.values.amount,
                                        debtCurrency: form.state.values.debtCurrency,
                                        payCurrency: form.state.values.payCurrency,
                                        chargeIds: form.state.values.chargeIds,
                                      }
                                    : null,
                                )
                                form.setFieldValue("advance", true)
                                // Lo que ya había escrito del adelanto vuelve, con su «Para».
                                form.setFieldValue("amount", advanceDraft?.amount ?? "")
                                form.setFieldValue("payments", [])
                                setAmountTouched(advanceDraft !== null)
                                // Por defecto, a cuenta de la moneda de su plan aceptado.
                                if (
                                  second &&
                                  data?.planCurrency &&
                                  orgCurrencies.includes(data.planCurrency)
                                ) {
                                  form.setFieldValue("debtCurrency", data.planCurrency)
                                  form.setFieldValue("payCurrency", data.planCurrency)
                                }
                                // Con su «Para» y su moneda, como estaba escrito.
                                if (advanceDraft) {
                                  form.setFieldValue("advanceFor", advanceDraft.advanceFor)
                                  if (advanceDraft.debtCurrency) form.setFieldValue("debtCurrency", advanceDraft.debtCurrency)
                                  if (advanceDraft.payCurrency) form.setFieldValue("payCurrency", advanceDraft.payCurrency)
                                }
                                setAdvanceDraft(null)
                              }}
                            >
                              Cobrar un adelanto
                            </Button>
                          )}
                          {!values.advance && advanceDraft ? (
                            <p role="status" className="basis-full text-sm text-muted-foreground">
                              El adelanto de {draftSaid(advanceDraft)} va en un cobro aparte: cobra esto primero
                              y después «Cobrar un adelanto».
                            </p>
                          ) : null}
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
                {showOtherCurrency && second ? (
                  <>
                    <form.AppField name="payCurrency">
                      {(field) => (
                        <field.Group legend="Paga con" className="gap-3">
                          {(control) => (
                            <ChoiceButtons
                              id={control.id}
                              invalid={control.invalid}
                              aria-describedby={control.describedBy}
                              onBlur={control.onBlur}
                              tone="primary"
                              value={pay}
                              options={currencyChoices(orgCurrencies, locale)}
                              onChange={choosePay}
                            />
                          )}
                        </field.Group>
                      )}
                    </form.AppField>
                    {figures.needsRate ? (
                      <div className="flex flex-col gap-2">
                        <form.AppField name="rate">
                          {() => (
                            <RateField
                              id={`${uid}-cambio`}
                              description={rateHelp}
                              business={currency}
                              other={second.currency}
                              locale={locale}
                            />
                          )}
                        </form.AppField>
                        {figures.rateText ? (
                          <RateFarNote
                            rate={figures.rateText}
                            today={second.rate}
                            locale={locale}
                            keptIn="en el ticket"
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : null}
                <form.AppField name="amount">
                  {(field) => (
                    <field.Control
                      label="Importe"
                      id={`${uid}-importe`}
                      description={splitHelp ? `${amountHelp} ${splitHelp}` : amountHelp}
                    >
                      {(control) => (
                        <MoneyInput
                          id={control.id}
                          currency={pay}
                          locale={locale}
                          value={field.state.value}
                          invalid={control.invalid}
                          aria-describedby={control.describedBy}
                          onBlur={control.onBlur}
                          onChange={(value) => {
                            field.handleChange(value)
                            setAmountTouched(true)
                            followAmount(parseMoneyOrNull(value, pay, locale))
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
                                                currency={pay}
                                                locale={locale}
                                                value={field.state.value}
                                                invalid={control.invalid}
                                                aria-describedby={control.describedBy}
                                                onBlur={control.onBlur}
                                                onChange={(value) => {
                                                  field.handleChange(value)
                                                  form.setFieldValue(
                                                    `payments[${index}].auto`,
                                                    false,
                                                    {
                                                      dontUpdateMeta: true,
                                                    },
                                                  )
                                                  followAmount(
                                                    parseMoneyOrNull(
                                                      form.state.values.amount,
                                                      pay,
                                                      locale,
                                                    ),
                                                  )
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
                                Suman {formatMoney(splitTotal, pay, locale)}
                                {amountCents !== null && splitTotal < amountCents
                                  ? ` · faltan ${formatMoney(amountCents - splitTotal, pay, locale)}`
                                  : amountCents !== null && splitTotal > amountCents
                                    ? ` · sobran ${formatMoney(splitTotal - amountCents, pay, locale)}`
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
                                currency={pay}
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
                          {change === null
                            ? "—"
                            : change < 0 || figures.changeGiven === null
                              ? formatMoney(Math.abs(change), pay, locale)
                              : formatMoney(
                                  figures.changeGiven,
                                  figures.crossChange !== null ? figures.changeIn : pay,
                                  locale,
                                )}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  {figures.changeChoice ? (
                    <form.AppField name="changeCurrency">
                      {(field) => (
                        <field.Group legend="Vuelto en" className="gap-3">
                          {(control) => (
                            <ChoiceButtons
                              id={control.id}
                              invalid={control.invalid}
                              aria-describedby={control.describedBy}
                              onBlur={control.onBlur}
                              tone="primary"
                              value={figures.changeIn}
                              options={currencyChoices([pay, currency], locale)}
                              onChange={(code) => field.handleChange(code)}
                            />
                          )}
                        </field.Group>
                      )}
                    </form.AppField>
                  ) : null}
                  {cashLine ? (
                    <p role="status" className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
                      {cashLine}
                    </p>
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

            {creditOnly ? (
              <p className="text-sm text-muted-foreground">No entra dinero a la caja: solo se usa su saldo a favor.</p>
            ) : (
              // Con varias sedes, la caja se elige aquí mismo, sin salir del cobro (QA, propuesta UX 2).
              <p className="text-sm text-muted-foreground">
                {sede.branches.length > 1 ? (
                  <>
                    Entra a la caja de{" "}
                    <BranchSwitcher
                      branches={sede.branches}
                      value={branchId}
                      fallbackName={sedeName || "la sede"}
                      onChange={(id) => sede.choose(id)}
                    />
                  </>
                ) : sedeName ? (
                  `Entra a la caja de ${sedeName}.`
                ) : null}
                {split ? " Sale un solo ticket." : null}
              </p>
            )}
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

const NEXT_PAYMENT = "proximo"

/**
 * «Para qué es» el adelanto (QA de la ficha del 8 nov): lo próximo que pague,
 * como siempre, o un tratamiento aceptado. Con pocos, botones; con más, una lista.
 */
function AdvanceForChoice({
  uid,
  targets,
  value,
  locale,
  onChange,
}: {
  uid: string
  targets: AdvanceTarget[]
  value: string
  locale: string
  onChange: (budgetItemId: string) => void
}): React.JSX.Element {
  const options = [
    { value: "", label: "Lo próximo que pague" },
    ...targets.map((target) => ({
      value: target.budgetItemId,
      label: target.name,
    })),
  ]
  return (
    <div className="flex flex-col gap-1.5">
      <span id={`${uid}-para`} className="text-sm font-medium">
        Para
      </span>
      {/* Botones si caben; un nombre largo («Endodoncia posterior vital · Pieza 46») va en la lista. */}
      {options.length <= 3 && options.every((option) => option.label.length <= 30) ? (
        // Tampoco en los botones: un valor vacío se mandaba como el id que inventa el botón
        // («base-ui-…») y el cobro respondía «Elige una opción de la lista» (QA del 9 nov).
        <ChoiceButtons
          aria-labelledby={`${uid}-para`}
          tone="primary"
          value={value || NEXT_PAYMENT}
          options={options.map((option) => ({ ...option, value: option.value || NEXT_PAYMENT }))}
          onChange={(picked) => onChange(picked === NEXT_PAYMENT ? "" : picked)}
        />
      ) : (
        // Un valor vacío no se elige en la lista: «lo próximo» va con su propia clave.
        <ChoiceSelect
          aria-label="Para"
          value={value || NEXT_PAYMENT}
          onChange={(event) => onChange(event.target.value === NEXT_PAYMENT ? "" : event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value || NEXT_PAYMENT} value={option.value || NEXT_PAYMENT}>
              {option.label}
            </option>
          ))}
        </ChoiceSelect>
      )}
    </div>
  )
}
