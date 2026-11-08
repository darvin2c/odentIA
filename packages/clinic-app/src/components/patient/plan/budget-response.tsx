/**
 * «¿Qué respondió?»: la respuesta de la persona a un presupuesto entregado o,
 * en la atención, al que se le acaba de mostrar («Anotar su respuesta»: se entrega
 * al guardar, sin enviarle nada). Un solo cajón: arriba qué responde (un camino,
 * todo, lo piensa o no acepta) y debajo cada tratamiento, para aceptar una parte.
 * Si acepta algo, puede firmarlo en la tablet (opcional); sin firma, la respuesta
 * es la palabra de quien la anota.
 * Cada tratamiento se acepta, se deja para después o no se acepta. Con varios
 * caminos (opciones) sin elegir, lo común a todos se responde sin elegir y la
 * pieza en duda pregunta qué camino: uno, «Lo piensa» o «No acepta». Aceptar lo de
 * un camino es elegirlo (las otras quedan «No elegida» solas). Nada queda
 * anotado hasta guardar, porque lo aceptado o no aceptado no se reescribe
 * después. Sirve a quien tenga `budgets.decide`: el odontólogo de lo que indicó,
 * recepción y caja (decisión 4).
 */
import {
  budgetAnswerText,
  budgetStateText,
  documentText,
  moneyTotalsText,
  sumAcceptedByCurrency,
} from "@odentia/clinical"
import {
  Badge,
  Button,
  ButtonGroup,
  buttonVariants,
  cn,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
} from "@odentia/ui"
import {
  ConfirmDialog,
  ErrorState,
  type FieldControl,
  FormDrawer,
  SubmitButton,
  submitForm,
  useAppForm,
  useFieldContext,
  useFieldControl,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check, Lock } from "lucide-react"
import { useId, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { useReceptionName } from "../../../lib/agent-names"
import { ApiError, apiFetch } from "../../../lib/api"
import {
  BUDGET_ANSWERABLE_STATUSES,
  type BudgetLine,
  type BudgetOption,
  type BudgetPaths,
  type BudgetWithTotals,
  budgetAnswerLabel,
  budgetNumberLabel,
  budgetPaths,
  decideBudgetApi,
  lineAwaitsAnswer,
  optionLines,
} from "../../../lib/budgets"
import { fetchResponsibilities } from "../../../lib/clinical-journey"
import { usePermission } from "../../../lib/crm"
import { hcLabel, type PatientFull } from "../../../lib/patients"
import { ChoiceSelect } from "../../ui/choice-select"
import {
  acceptedWords,
  AMOUNT_PENDING,
  budgetStatusTone,
  type Money,
  moneyForLines,
  totalsWords,
  treatmentSiteLabel,
} from "./budget-parts"
import { appWords } from "../../../lib/product-words"
import { type BudgetSignRow, BudgetSigningScreen } from "./budget-signing"

type Answer = "aceptado" | "pospuesto" | "rechazado"

const ANSWER_OPTIONS: ReadonlyArray<{ value: Answer; label: string }> = [
  { value: "aceptado", label: "Acepta" },
  { value: "pospuesto", label: "Para después" },
  { value: "rechazado", label: "No" },
]

/**
 * Lo que se marca en «¿qué camino?» cuando no es una opción (las opciones van
 * por su id, que nunca coincide con estas palabras).
 */
const PATH_THINK = "lo-piensa"
const PATH_NONE = "ninguno"

/** Lo que ya tiene respuesta: se ve, pero no se pregunta ni se envía. */
function finalAnswerText(line: BudgetLine, budgetStatus: string): string {
  // Una revisión entregada trae aceptado lo que no cambió: no se vuelve a preguntar.
  if (budgetStatus === "presentado" && line.decision === "aceptado") return "Aceptado · sin cambios"
  return `Ya respondió: ${budgetAnswerLabel(line.decision).toLowerCase()}`
}

/**
 * Cómo quedará, con las palabras de siempre: misma derivación que `decideBudget`.
 * Con caminos sin elegir, `options` hace decir «falta elegir el camino».
 */
function expectedState(answers: string[], options?: readonly BudgetOption[]): string {
  const accepted = answers.filter((answer) => answer === "aceptado").length
  const status =
    accepted === answers.length
      ? "aceptado"
      : accepted > 0
        ? "parcial"
        : answers.includes("pospuesto")
          ? "pospuesto"
          : "rechazado"
  return budgetStateText({ status, items: answers.map((decision) => ({ decision })), options })
}

/**
 * La pieza de lo que es de un camino («Pieza 46», «la 46»), si es una sola:
 * es la que está en duda. Sin una pieza común, la pregunta es solo «¿Qué camino?».
 */
function pathSite(lines: readonly BudgetLine[]): { label: string; short: string | null } | null {
  const [first] = lines
  if (!first) return null
  const tooth = first.toothNumber
  if (
    tooth != null &&
    lines.every((line) => line.toothNumber === tooth && (line.scope === "tooth" || line.scope === "surfaces"))
  ) {
    return { label: `Pieza ${tooth}`, short: `la ${tooth}` }
  }
  const labels = new Set(lines.map((line) => treatmentSiteLabel(line)))
  const [label] = labels
  return labels.size === 1 && label && label !== "General" ? { label, short: null } : null
}

/** Cómo se llama un camino: su nombre en la clínica o «Opción A». */
/** El nombre del camino: el que le puso el odontólogo o «Camino 1», como en el plan y la atención. */
function pathName(option: BudgetOption): string {
  return option.name?.trim() || `Camino ${option.position}`
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

interface ResponseValues {
  /**
   * El camino, con caminos sin elegir: el id de una opción, «Lo piensa» o
   * «No acepta» (vacío mientras no se marca). Es el campo `optionId` del servidor.
   */
  optionId: string
  /** Quién decide, si se cambió; vacío: el de siempre (paciente o su representante). */
  decidedByContactId: string
  /**
   * Una respuesta por tratamiento que espera respuesta. Con caminos sin elegir:
   * primero lo común y después lo de cada camino (que solo se envía si se elige).
   */
  decisions: Array<{ planItemId: string; decision: Answer | "" }>
  decisionNote: string
}

/** El esquema del envío; `needsPath` dice si falta marcar el camino. */
function responseSchema(needsPath: () => boolean) {
  return z.object({
    // En el campo y no en el objeto: así se dice a la vez que lo que falte marcar.
    optionId: z.string().refine((value) => !needsPath() || value !== "", "Elige un camino, «Lo piensa» o «No acepta»."),
    decidedByContactId: z.string(),
    decisions: z.array(
      z.object({
        planItemId: z.string(),
        decision: z.enum(["aceptado", "pospuesto", "rechazado"], "Marca la respuesta de este tratamiento."),
      }),
    ),
    decisionNote: z.string().max(4000, "Escribe como mucho 4000 caracteres."),
  })
}

/**
 * «Decide Elena Huamán, paciente» con «Cambiar». Es el campo `decidedByContactId`:
 * si el servidor rechaza a quien decide, el selector se abre marcado con el motivo.
 */
function DeciderPicker({
  patientId,
  selectId,
  decider,
  deciders,
  locked,
  changing,
  notice,
  onStartChange,
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
}): React.JSX.Element {
  const field = useFieldContext<string>()
  const { control, errors, descriptionId, errorId } = useFieldControl({ id: selectId, hasDescription: true })
  const showSelect = !locked && decider != null && (changing || control.invalid)
  const fieldError = control.invalid ? (
    <FieldError id={errorId} errors={errors.map((message) => ({ message }))} />
  ) : null
  const responsiblesLink = (
    <Link
      to="/patients/$patientId"
      params={{ patientId }}
      search={{ tab: "responsables" }}
      className={cn(buttonVariants({ variant: "link", size: "sm" }), "h-auto self-start p-0")}
    >
      Registrar un representante en Responsables
    </Link>
  )
  return (
    <div className="flex flex-col gap-2 rounded-xl border px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1">
          {decider ? (
            <>
              <span className="text-muted-foreground">Decide</span> <span className="font-medium">{decider.name}</span>
              <span className="text-muted-foreground">, {deciderRole(decider.kind)}</span>
            </>
          ) : (
            "No hay una persona vinculada que pueda decidir."
          )}
        </p>
        {!locked && !showSelect && decider ? (
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onStartChange}>
            Cambiar
          </Button>
        ) : null}
      </div>
      {showSelect && decider ? (
        <Field data-invalid={control.invalid || undefined}>
          <FieldLabel htmlFor={control.id}>Quién decide</FieldLabel>
          <ChoiceSelect
            id={control.id}
            name={control.name}
            value={decider.id}
            aria-invalid={control.invalid || undefined}
            aria-describedby={control.describedBy}
            onBlur={control.onBlur}
            onChange={(event) => field.handleChange(event.target.value)}
          >
            {deciders.map((option) => (
              <option key={option.id} value={option.id}>
                {`${option.name} · ${deciderRole(option.kind)}`}
              </option>
            ))}
          </ChoiceSelect>
          <FieldDescription id={descriptionId}>Decide el paciente o su representante legal vigente.</FieldDescription>
          {fieldError}
          {responsiblesLink}
        </Field>
      ) : (
        fieldError
      )}
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
      {!decider || (notice && !showSelect && !locked) ? responsiblesLink : null}
    </div>
  )
}

/** La respuesta de un tratamiento (`decisions[i].decision`): tres botones y su error debajo. */
function AnswerButtons({ title, disabled }: { title: string; disabled: boolean }): React.JSX.Element {
  const field = useFieldContext<Answer | "">()
  const { control, errors, errorId } = useFieldControl({ hasDescription: false })
  return (
    <div className="flex flex-col gap-1" data-invalid={control.invalid || undefined}>
      <ButtonGroup
        id={control.id}
        aria-label={`Respuesta para ${title}`}
        aria-invalid={control.invalid || undefined}
        aria-describedby={control.describedBy}
        className="w-full"
      >
        {ANSWER_OPTIONS.map((option) => (
          <Button
            key={option.value}
            type="button"
            size="sm"
            className="flex-1"
            variant={field.state.value === option.value ? "default" : "outline"}
            aria-pressed={field.state.value === option.value}
            disabled={disabled}
            onClick={() => {
              field.handleChange(option.value)
              field.handleBlur()
            }}
          >
            {option.label}
          </Button>
        ))}
      </ButtonGroup>
      {control.invalid ? <FieldError id={errorId} errors={errors.map((message) => ({ message }))} /> : null}
    </div>
  )
}

/**
 * «Pieza 46 · ¿qué camino?» (`optionId`): un botón por camino con su total, «Lo
 * piensa» y «No acepta». Con flechas se pasa de uno a otro, como todo grupo de opciones.
 */
function PathChoice({
  paths,
  money,
  currency,
  control,
  disabled,
  onPicked,
}: {
  paths: BudgetPaths["paths"]
  money: Money
  currency: string
  control: FieldControl
  disabled: boolean
  /** Al elegir un camino: lo común sin marcar se acepta con él (se puede cambiar). */
  onPicked?: (value: string) => void
}): React.JSX.Element {
  const field = useFieldContext<string>()
  const item = "flex w-full min-h-11 cursor-pointer items-start gap-3 rounded-xl border bg-card p-3 text-sm font-normal has-[[data-checked]]:border-primary has-[[data-checked]]:bg-primary-soft"
  return (
    <RadioGroup
      id={control.id}
      aria-invalid={control.invalid || undefined}
      aria-describedby={control.describedBy}
      value={field.state.value}
      disabled={disabled}
      onValueChange={(value) => {
        const picked = typeof value === "string" ? value : ""
        field.handleChange(picked)
        field.handleBlur()
        onPicked?.(picked)
      }}
    >
      {paths.map(({ option, own }) => {
        const name = pathName(option)
        // Lo del camino, como en el plan; con lo común, de dato aparte.
        const ownTotals = sumAcceptedByCurrency(
          own.map((line) => ({ lineTotalCents: line.lineTotalCents, decision: "aceptado", currency: line.currency })),
        )
        const total = ownTotals.length > 0 ? moneyTotalsText(ownTotals, (cents, unit) => money(cents, unit)) : totalsWords(option, currency, money)
        const withCommon = totalsWords(option, currency, money)
        return (
          <FieldLabel key={option.id} className={item}>
            <RadioGroupItem value={option.id} className="mt-0.5" aria-label={`${name}, ${total}`} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">{name}</span>
              <span className="text-xs text-muted-foreground">{own.map((line) => line.title).join(" · ")}</span>
              {withCommon !== total ? (
                <span className="text-xs text-muted-foreground">Con lo común: {withCommon}</span>
              ) : null}
            </span>
            <span className="font-semibold whitespace-nowrap tabular-nums">{total}</span>
          </FieldLabel>
        )
      })}
      <FieldLabel className={item}>
        <RadioGroupItem value={PATH_THINK} className="mt-0.5" aria-label="Lo piensa" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">Lo piensa</span>
          <span className="text-xs text-muted-foreground">Lo de los caminos queda para después.</span>
        </span>
      </FieldLabel>
      <FieldLabel className={item}>
        <RadioGroupItem value={PATH_NONE} className="mt-0.5" aria-label="No acepta" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">No acepta</span>
          <span className="text-xs text-muted-foreground">No acepta lo de ningún camino.</span>
        </span>
      </FieldLabel>
    </RadioGroup>
  )
}

/**
 * Quién respondió: con firma, quien decide y firmó; anotado por el equipo sin
 * firma, quién decide y quién lo anotó (su palabra, no la de la persona); por su
 * enlace, el portal o el chat, la persona.
 */
function AnsweredBy({
  budget,
  formatDay,
}: {
  budget: BudgetWithTotals
  formatDay: (iso: string) => string
}): React.JSX.Element | null {
  const decides = budget.acceptedByName
  const signedText = budget.decisionSignedAt
    ? `${decides ? `Firmó ${decides}` : "Firmó quien decide"} en la clínica, el ${formatDay(budget.decisionSignedAt)}`
    : null
  // La firma cubre su momento: si respondió algo después, eso se dice aparte.
  const signedLast =
    budget.decisionSignedAt != null &&
    budget.decidedAt != null &&
    new Date(budget.decisionSignedAt).getTime() === new Date(budget.decidedAt).getTime()
  if (signedText && signedLast) return <p className="text-sm text-muted-foreground">{signedText}.</p>
  if (signedText)
    return (
      <p className="text-sm text-muted-foreground">
        {signedText}, lo que aceptó entonces. Lo de después no lleva su firma
        {budget.decidedVia === "clinica" && budget.decidedByName ? `: lo anotó ${budget.decidedByName}` : ""}.
      </p>
    )
  if (budget.decidedVia === "clinica")
    return (
      <p className="text-sm text-muted-foreground">
        {[decides ? `Decide ${decides}` : null, budget.decidedByName ? `lo anotó ${budget.decidedByName}` : "lo anotó el equipo"]
          .filter(Boolean)
          .join(" · ")}
        . Sin firma.
      </p>
    )
  return decides ? <p className="text-sm text-muted-foreground">Respondió {decides}.</p> : null
}

export function BudgetResponse({
  patientId,
  budget,
  disabled = false,
  money: baseMoney,
  formatDay,
  runWrite,
  openOnMount = false,
  direct = false,
  inPerson = false,
  onClose,
  className,
}: {
  patientId: string
  budget: BudgetWithTotals
  disabled?: boolean
  money: Money
  formatDay: (iso: string) => string
  /** Envoltura de escritura de la pantalla (guardas e invalidaciones propias). */
  runWrite?: <T>(operation: () => Promise<T>) => Promise<T>
  /** «¿Qué respondió?» desde «Qué sigue»: abre el panel de una vez. */
  openOnMount?: boolean
  /** Solo el cajón, abierto: quien lo abre lo cierra con `onClose`. */
  direct?: boolean
  /**
   * Se le mostró en la atención y respondió ahí: un borrador queda entregado al
   * guardar, sin enviarle nada (pide además el permiso de entregar).
   */
  inPerson?: boolean
  onClose?: () => void
  className?: string
}): React.JSX.Element {
  const receptionName = useReceptionName()
  const uid = useId()
  const queryClient = useQueryClient()
  // Las cifras de esta lista van sin símbolo, salvo que el presupuesto lleve dos monedas.
  const money = moneyForLines(baseMoney, budget.items)
  const plainMoney: Money = Object.assign((cents: number | null, unit: string) => money.plain(cents, unit), {
    plain: money.plain,
  })
  const canDecide = usePermission("budgets.decide")
  const canSend = usePermission("budgets.send")
  const canPatients = usePermission("patients.read")
  // Mostrado en la atención y aún por entregar: se entrega al anotar su respuesta.
  const draftInPerson = inPerson && budget.status === "borrador"
  const answerable = BUDGET_ANSWERABLE_STATUSES.includes(budget.status) || draftInPerson
  const active = canDecide && answerable && (!draftInPerson || canSend)

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

  const chosenOption = budget.options.find((option) => option.decision === "elegida") ?? null
  const several = budget.options.length > 1
  // Varios caminos y ninguno elegido: lo común se responde sin elegir y la pieza pregunta qué camino.
  const choosing = several && !chosenOption
  const paths = useMemo(() => (choosing ? budgetPaths(budget) : null), [choosing, budget])
  // Con un camino elegido (o uno solo), sus líneas; con caminos sin elegir, cada tratamiento una vez.
  const fixedOption = choosing ? null : (chosenOption ?? budget.options[0] ?? null)
  const lines = paths ? [...paths.common, ...paths.exclusive] : fixedOption ? optionLines(budget, fixedOption.id) : []
  const openLines = lines.filter(lineAwaitsAnswer)
  const openCommon = paths ? paths.common.filter(lineAwaitsAnswer) : []
  const openExclusive = paths ? paths.exclusive.filter(lineAwaitsAnswer) : []
  /** Hay que marcar el camino: algo de los caminos espera respuesta. */
  const pathOpen = openExclusive.length > 0
  const site = paths ? pathSite(paths.exclusive) : null

  const [changingDecider, setChangingDecider] = useState(false)
  /** El panel «Acepta una parte» abierto. */
  const [drawerOpen, setDrawerOpen] = useState(() => (openOnMount || direct) && active)
  /** La tablet en manos de quien decide, para firmar lo que acepta. */
  const [signing, setSigning] = useState(false)
  /** Se pidió firmar: el envío abre la tablet en vez de guardar. */
  const wantsSign = useRef(false)
  /** La firma tomada en la tablet, que viaja con la respuesta. */
  const signedStrokes = useRef<number[][][] | null>(null)
  /** Se abrió con «Acepta todo» y falta el camino: el panel lo dice. */
  const [acceptAllIntent, setAcceptAllIntent] = useState(false)
  const [confirming, setConfirming] = useState<"aceptado" | "rechazado" | null>(null)
  /**
   * Qué se guarda: una misma respuesta para lo pendiente (los botones y su
   * confirmación) o lo marcado en el panel, con su nota.
   */
  const mode = useRef<Answer | "panel">("panel")
  /** El campo del formulario de cada respuesta enviada, para decir el rechazo del servidor junto a ella. */
  const sentFields = useRef<string[]>([])
  const needsPath = useRef(false)
  needsPath.current = choosing && pathOpen
  const [schema] = useState(() => responseSchema(() => mode.current === "panel" && needsPath.current))

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
    return {
      deciders: list,
      // Lo decide el servidor, con el día de la clínica.
      minor: patient?.isMinor ?? false,
    }
  }, [patient, responsibilities])

  // Por defecto decide el paciente; si es menor, su representante legal.
  const self = deciders.find((entry) => entry.kind === "paciente") ?? null
  const representative = deciders.find((entry) => entry.kind === "representante") ?? null
  const defaultDecider = minor ? (representative ?? self) : (self ?? representative)
  // Completar una respuesta: decide quien respondió la primera vez.
  const followUp = budget.status === "parcial" || budget.status === "pospuesto"
  const lockedId = followUp ? (budget.decisionContactId ?? null) : null
  const deciderFor = (chosenId: string): Decider | null =>
    lockedId
      ? (deciders.find((entry) => entry.id === lockedId) ?? {
          id: lockedId,
          name: budget.acceptedByName ?? "La misma persona",
          kind: "anterior",
        })
      : (deciders.find((entry) => entry.id === chosenId) ?? defaultDecider)

  /**
   * Lo que se marca en el panel: solo lo que espera respuesta. Con caminos, lo
   * común sin marcar (o aceptado, si se llegó por «Acepta todo») y lo de cada
   * camino aceptado, que es lo que se espera al elegirlo.
   */
  const panelDecisions = (commonPreset: Answer | null): ResponseValues["decisions"] =>
    paths
      ? [
          ...openCommon.map((line) => ({ planItemId: line.planItemId, decision: commonPreset ?? ("" as const) })),
          ...openExclusive.map((line) => ({ planItemId: line.planItemId, decision: "aceptado" as const })),
        ]
      : openLines.map((line) => ({ planItemId: line.planItemId, decision: "" as const }))

  // Los valores de partida se fijan al abrir (no los pisa un dato que llega tarde).
  const [defaults, setDefaults] = useState<ResponseValues>(() => ({
    optionId: "",
    decidedByContactId: "",
    decisions: panelDecisions(null),
    decisionNote: budget.decisionNote ?? "",
  }))

  /** Lo que se envía y, de cada respuesta, el campo donde se dice si el servidor la rechaza. */
  const buildDecisions = (
    value: ResponseValues,
  ): { optionId: string | null; entries: Array<{ planItemId: string; decision: Answer; field: string }> } => {
    const marked = new Map(
      value.decisions.map((entry, index) => [
        entry.planItemId,
        { decision: entry.decision as Answer, field: `decisions[${index}].decision` },
      ]),
    )
    const fromForm = (line: BudgetLine) => ({ planItemId: line.planItemId, ...marked.get(line.planItemId)! })
    const answer = mode.current
    if (answer !== "panel") {
      // Lo mismo para todo lo que espera; con caminos sin elegir, sin elegir ninguno.
      return {
        optionId: fixedOption?.id ?? null,
        entries: openLines.map((line) => ({ planItemId: line.planItemId, decision: answer, field: "decisions" })),
      }
    }
    if (!paths) return { optionId: fixedOption?.id ?? null, entries: openLines.map(fromForm) }
    const picked = paths.paths.find((path) => path.option.id === value.optionId)
    if (picked) {
      // Elige ese camino: se responde cada línea abierta de esa opción, lo común incluido.
      return {
        optionId: picked.option.id,
        entries: optionLines(budget, picked.option.id).filter(lineAwaitsAnswer).map(fromForm),
      }
    }
    // «Lo piensa» o «No acepta»: lo de los caminos va igual, y su rechazo se dice en la pregunta del camino.
    const forPaths: Answer = value.optionId === PATH_NONE ? "rechazado" : "pospuesto"
    return {
      optionId: null,
      entries: [
        ...openCommon.map(fromForm),
        ...openExclusive.map((line) => ({ planItemId: line.planItemId, decision: forPaths, field: "optionId" })),
      ],
    }
  }

  const form = useAppForm({
    defaultValues: defaults,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const { optionId, entries } = buildDecisions(value)
      sentFields.current = entries.map((entry) => entry.field)
      // Firmar: primero la tablet; la respuesta se guarda con la firma al volver.
      if (wantsSign.current && !signedStrokes.current) {
        setSigning(true)
        return
      }
      const body = {
        optionId,
        decisions: entries.map((entry) => ({ planItemId: entry.planItemId, decision: entry.decision })),
        decidedByContactId: deciderFor(value.decidedByContactId)?.id ?? null,
        decisionNote: mode.current === "panel" ? value.decisionNote.trim() || null : (budget.decisionNote ?? null),
        ...(draftInPerson ? { inPerson: true } : {}),
        ...(signedStrokes.current ? { signature: { strokes: signedStrokes.current } } : {}),
      }
      if (runWrite) {
        await runWrite(() => decideBudgetApi(patientId, budget.id, body))
      } else {
        await decideBudgetApi(patientId, budget.id, body)
        await Promise.all(
          ["budgets", "budget", "plan-next", "plan-items", "treatment-coordination"].map((key) =>
            queryClient.invalidateQueries({ queryKey: [key, patientId] }),
          ),
        )
      }
      setChangingDecider(false)
      setConfirming(null)
      setSigning(false)
      signedStrokes.current = null
      wantsSign.current = false
      setDrawerOpen(false)
      if (direct) onClose?.()
    },
  })
  const saving = useStore(form.store, (state) => state.isSubmitting)
  const pickedPath = useStore(form.store, (state) => state.values.optionId)
  const chosenDeciderId = useStore(form.store, (state) => state.values.decidedByContactId)
  const decisionValues = useStore(form.store, (state) => state.values.decisions)
  const formError = useFormSubmitError(form)

  const decider = deciderFor(chosenDeciderId)
  const deciderNotice = lockedId
    ? "Completa la respuesta quien la dio la primera vez."
    : minor && !representative
      ? "Es menor de edad y no tiene representante legal registrado."
      : null

  // El rechazo de una respuesta se dice junto a ella (el servidor la nombra por su lugar en el envío);
  // «Debe decidir cada línea…», en la primera sin marcar.
  const fieldMap = (key: string): string | undefined => {
    const match = /^decisions\[(\d+)\]\.decision$/.exec(key)
    if (match) return sentFields.current[Number(match[1])] ?? "decisions"
    if (key === "decisions") {
      const empty = decisionValues.findIndex((entry) => entry.decision === "")
      return decisionValues.length > 0 ? `decisions[${Math.max(0, empty)}].decision` : undefined
    }
    return undefined
  }
  const surface = useFormSurface(form, { fieldMap })

  /** Responder lo pendiente de una vez: misma respuesta para todo lo que espera, sin elegir camino. */
  const answerAll = (answer: Answer): Promise<boolean> => {
    mode.current = answer
    wantsSign.current = false
    signedStrokes.current = null
    form.setFieldValue("optionId", "")
    form.setFieldValue(
      "decisions",
      openLines.map((line) => ({ planItemId: line.planItemId, decision: answer })),
    )
    return submitForm(form, { fieldMap })
  }

  const openPanel = (intent: "todo" | "parte") => {
    const values: ResponseValues = {
      ...form.state.values,
      optionId: "",
      decisions: panelDecisions(intent === "todo" ? "aceptado" : null),
      decisionNote: budget.decisionNote ?? "",
    }
    mode.current = "panel"
    setAcceptAllIntent(intent === "todo")
    setDefaults(values)
    form.reset(values)
    setDrawerOpen(true)
  }

  /**
   * «Acepta todo» y «No acepta» piden confirmación. Con caminos sin elegir no se
   * acepta todo sin elegir uno: se abre el panel en la pregunta del camino.
   */
  const askConfirm = (answer: "aceptado" | "rechazado") => {
    if (answer === "aceptado" && choosing && pathOpen) {
      openPanel("todo")
      return
    }
    setConfirming(answer)
  }

  /** Respuesta de la línea: la ya anotada si no espera; si no, la marcada en el panel. */
  const answerOf = (line: BudgetLine): Answer | undefined => {
    if (!lineAwaitsAnswer(line)) return line.decision as Answer
    const marked = decisionValues.find((entry) => entry.planItemId === line.planItemId)?.decision
    return marked || undefined
  }

  const picked = paths?.paths.find((path) => path.option.id === pickedPath) ?? null
  /**
   * Lo que se responde en el panel, con la respuesta que lleva: con caminos, lo
   * común una vez y lo del camino elegido; «Lo piensa» y «No acepta» marcan lo de
   * los caminos de una vez.
   */
  const panelAnswers: Array<{ line: BudgetLine; answer: string | undefined }> = !paths
    ? lines.map((line) => ({ line, answer: answerOf(line) }))
    : picked
      ? optionLines(budget, picked.option.id).map((line) => ({ line, answer: answerOf(line) }))
      : [
          ...paths.common.map((line) => ({ line, answer: answerOf(line) })),
          ...(pathOpen && !pickedPath
            ? []
            : paths.exclusive.map((line) => ({
                line,
                answer: lineAwaitsAnswer(line)
                  ? pickedPath === PATH_NONE
                    ? "rechazado"
                    : "pospuesto"
                  : line.decision,
              }))),
        ]

  /** Lo marcado como «Acepta» mientras se elige, sin contar dos veces lo común (`sumAcceptedByCurrency`). */
  const acceptingWords = (): string => {
    const accepting = sumAcceptedByCurrency(
      panelAnswers.map(({ line, answer }) => ({
        lineTotalCents: line.lineTotalCents,
        decision: answer,
        currency: line.currency,
      })),
    )
    if (accepting.length === 0) return money(0, budget.currency)
    return moneyTotalsText(accepting, (cents, unit) => money(cents, unit), AMOUNT_PENDING)
  }

  const statusLine =
    budget.status === "presentado" && budget.presentedAt
      ? `${budget.stateText} · entregado el ${formatDay(budget.presentedAt)}`
      : budget.decidedAt && ["aceptado", "parcial", "rechazado", "pospuesto"].includes(budget.status)
        ? `${budget.stateText} · respondió el ${formatDay(budget.decidedAt)}`
        : budget.stateText

  const decidersLoading = active && canPatients && (patientQuery.isPending || responsibilitiesQuery.isPending)
  const decidersError = patientQuery.error ?? responsibilitiesQuery.error
  const blocked = disabled || saving || decidersLoading
  const nothingOpen = openLines.length === 0

  const picker = (selectId: string) => (
    <form.AppField name="decidedByContactId">
      {() => (
        <DeciderPicker
          patientId={patientId}
          selectId={selectId}
          decider={decider}
          deciders={deciders}
          locked={lockedId != null}
          changing={changingDecider}
          notice={deciderNotice}
          onStartChange={() => setChangingDecider(true)}
        />
      )}
    </form.AppField>
  )

  /** Un tratamiento del panel: su precio y sus tres botones, o lo que ya respondió. */
  const lineRow = (line: BudgetLine, withButtons = true) => {
    const index = decisionValues.findIndex((entry) => entry.planItemId === line.planItemId)
    return (
      <li key={line.id} className="flex flex-col gap-2 px-3 py-3">
        <div className="flex gap-3 text-sm">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium">{line.title}</span>
            {treatmentSiteLabel(line) ? (<span className="text-xs text-muted-foreground">{treatmentSiteLabel(line)}</span>) : null}
          </span>
          <span className="whitespace-nowrap tabular-nums">
            {line.lineTotalCents == null ? "Sin precio" : money.plain(line.lineTotalCents, line.currency)}
          </span>
        </div>
        {!lineAwaitsAnswer(line) ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock aria-hidden="true" className="size-3.5 shrink-0" />
            {finalAnswerText(line, budget.status)}
          </p>
        ) : index >= 0 && withButtons ? (
          <form.AppField name={`decisions[${index}].decision`}>
            {() => <AnswerButtons title={line.title} disabled={saving} />}
          </form.AppField>
        ) : null}
      </li>
    )
  }

  const panelAnswered = panelAnswers.flatMap(({ answer }) => answer ?? [])
  const unanswered = panelAnswers.length - panelAnswered.length
  const pathMissing = choosing && pathOpen && !pickedPath
  // Con caminos, si no se elige uno, la pieza queda por decidir.
  const pathPending = choosing && pathOpen && (!pickedPath || pickedPath === PATH_THINK)
  const patientShortName = patient?.patient.givenNames?.trim().split(/\s+/)[0] ?? patient?.patient.displayName ?? null
  const pathQuestion = site ? `${site.label} · ¿qué camino?` : "¿Qué camino?"
  const commonTitle = budget.options.length === 2 ? "Va en los dos caminos" : "Va en todos los caminos"

  /**
   * Sin caminos y con más de un tratamiento: «Acepta todo», «Lo piensa» o «No
   * acepta» marca de una vez todo lo que espera; aceptar una parte es cambiar cada
   * tratamiento abajo. Con uno solo, sus tres botones bastan.
   */
  const isOpenItem = (planItemId: string) => openLines.some((line) => line.planItemId === planItemId)
  const openAnswers = decisionValues.filter((entry) => isOpenItem(entry.planItemId))
  const firstOpen = openAnswers[0]?.decision ?? ""
  const wholeAnswer: Answer | "" = openAnswers.every((entry) => entry.decision === firstOpen) ? firstOpen : ""
  const partMarked = wholeAnswer === "" && openAnswers.some((entry) => entry.decision !== "")
  const setWhole = (answer: Answer) =>
    form.setFieldValue(
      "decisions",
      decisionValues.map((entry) => (isOpenItem(entry.planItemId) ? { ...entry, decision: answer } : entry)),
    )
  const openTotal = moneyTotalsText(
    sumAcceptedByCurrency(
      openLines.map((line) => ({ lineTotalCents: line.lineTotalCents, decision: "aceptado", currency: line.currency })),
    ),
    (cents, unit) => money(cents, unit),
    AMOUNT_PENDING,
  )
  const wholeChoice = !paths && openLines.length > 1
  const choiceItem =
    "flex w-full min-h-11 cursor-pointer items-start gap-3 rounded-xl border bg-card p-3 text-sm font-normal has-[[data-checked]]:border-primary has-[[data-checked]]:bg-primary-soft"

  /** Acepta algo ahora y se sabe quién decide: lo puede firmar en la tablet. */
  const acceptingNow = panelAnswers.some(({ line, answer }) => lineAwaitsAnswer(line) && answer === "aceptado")
  const canSign = acceptingNow && decider != null && !budget.decisionSignedAt
  const signRows: BudgetSignRow[] = panelAnswers.map(({ line, answer }) => ({
    key: line.id,
    title: line.title,
    site: treatmentSiteLabel(line) || null,
    amount: line.lineTotalCents == null ? "Sin precio" : money(line.lineTotalCents, line.currency),
    answer: budgetAnswerText(answer),
  }))
  const askSignature = () => {
    wantsSign.current = true
    signedStrokes.current = null
    mode.current = "panel"
    // Si falta marcar algo, no se abre la tablet ni queda pedida la firma para otro envío.
    void submitForm(form, { fieldMap }).then((ok) => {
      if (!ok) wantsSign.current = false
    })
  }
  const signingScreen =
    signing && decider ? (
      <BudgetSigningScreen
        patientId={patientId}
        budgetId={budget.id}
        budgetNumber={budget.budgetNumber}
        facts={
          patient
            ? [
                { label: "Paciente", value: patient.patient.displayName },
                ...(patient.patient.docNumber
                  ? [{ label: "Documento", value: documentText(patient.patient.docType, patient.patient.docNumber) }]
                  : []),
                { label: "Historia clínica", value: hcLabel(patient.patient.patientNumber) },
              ]
            : []
        }
        rows={signRows}
        accepting={acceptingWords()}
        validUntil={budget.validUntil ? formatDay(`${budget.validUntil}T12:00:00`) : null}
        signer={{
          name: decider.name,
          role:
            decider.kind === "representante"
              ? "Representante legal"
              : decider.kind === "paciente"
                ? "Paciente"
                : "Quien decide",
        }}
        saving={saving}
        onBack={() => {
          setSigning(false)
          wantsSign.current = false
        }}
        onSave={(strokes) => {
          signedStrokes.current = strokes
          void submitForm(form, { fieldMap }).then((saved) => {
            // Si el servidor la rechaza, la tablet vuelve al cajón y el motivo se dice ahí.
            if (!saved) {
              setSigning(false)
              signedStrokes.current = null
              wantsSign.current = false
            }
          })
        }}
      />
    ) : null

  const drawer = drawerOpen ? (
    <FormDrawer
      {...surface}
      open
      title={patientShortName ? `¿Qué respondió ${patientShortName}?` : "¿Qué respondió la persona?"}
      description={
        paths
          ? `${budgetNumberLabel(budget.budgetNumber)}. ${
              acceptAllIntent && pathOpen
                ? "Para aceptarlo todo, elige el camino."
                : `Marca la respuesta de cada tratamiento${pathOpen ? " y el camino" : ""}.`
            }`
          : `${budgetNumberLabel(budget.budgetNumber)}${
              several && fixedOption ? ` · ${fixedOption.label}` : ""
            }. Marca la respuesta de cada tratamiento.`
      }
      submitLabel="Guardar la respuesta"
      secondaryAction={canSign ? { label: "Que lo firme en la tablet", onClick: askSignature } : undefined}
      onSubmit={(event) => {
        mode.current = "panel"
        wantsSign.current = false
        signedStrokes.current = null
        surface.onSubmit(event)
      }}
      // Mientras se sabe quién decide, no se guarda: sin esa lista la respuesta quedaría sin nadie.
      isLoading={decidersLoading}
      onClose={() => {
        if (saving) return
        wantsSign.current = false
        setDrawerOpen(false)
        if (direct) onClose?.()
      }}
    >
      {decidersError ? (
        <ErrorState
          title="No se pudo cargar quién decide"
          error={decidersError instanceof ApiError ? decidersError.shape : null}
          onRetry={() => {
            void patientQuery.refetch()
            void responsibilitiesQuery.refetch()
          }}
        />
      ) : null}
      {paths ? (
        <>
          {/* Lo principal primero: qué camino; después lo que va en todos. */}
          {pathOpen ? (
            <form.AppField name="optionId">
              {(field) => (
                <field.Group legend={pathQuestion}>
                  {(control) => (
                    <PathChoice
                      paths={paths.paths}
                      money={money}
                      currency={budget.currency}
                      control={control}
                      disabled={saving}
                      onPicked={(value) => {
                        if (!paths.paths.some((path) => path.option.id === value)) return
                        form.setFieldValue(
                          "decisions",
                          decisionValues.map((entry) =>
                            entry.decision === "" && openCommon.some((line) => line.planItemId === entry.planItemId)
                              ? { ...entry, decision: "aceptado" as const }
                              : entry,
                          ),
                        )
                      }}
                    />
                  )}
                </field.Group>
              )}
            </form.AppField>
          ) : null}
          {paths.common.length > 0 ? (
            <section aria-labelledby={`${uid}-common`} className="flex flex-col gap-2">
              <h3 id={`${uid}-common`} className="text-sm font-semibold">
                {commonTitle}
              </h3>
              <ul className="flex flex-col divide-y rounded-xl border">{paths.common.map((line) => lineRow(line))}</ul>
            </section>
          ) : null}
          {picked && picked.own.length > 0 ? (
            <section aria-labelledby={`${uid}-path`} className="flex flex-col gap-2">
              <h3 id={`${uid}-path`} className="text-sm font-semibold">
                {`Lo de ${pathName(picked.option)}`}
              </h3>
              <ul className="flex flex-col divide-y rounded-xl border">{picked.own.map((line) => lineRow(line))}</ul>
            </section>
          ) : null}
        </>
      ) : (
        <>
          {wholeChoice ? (
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className="mb-2 text-sm font-semibold">¿Qué responde?</legend>
              <RadioGroup
                value={wholeAnswer}
                disabled={saving}
                onValueChange={(value) => {
                  if (value === "aceptado" || value === "pospuesto" || value === "rechazado") setWhole(value)
                }}
              >
                {(
                  [
                    { value: "aceptado", label: "Acepta todo", detail: null, amount: openTotal },
                    { value: "pospuesto", label: "Lo piensa", detail: "Queda para responder después.", amount: null },
                    { value: "rechazado", label: "No acepta", detail: "No acepta ninguno.", amount: null },
                  ] as const
                ).map((option) => (
                  <FieldLabel key={option.value} className={choiceItem}>
                    <RadioGroupItem value={option.value} className="mt-0.5" aria-label={option.label} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium">{option.label}</span>
                      {option.detail ? (
                        <span className="text-xs text-muted-foreground">{option.detail}</span>
                      ) : null}
                    </span>
                    {option.amount ? (
                      <span className="font-semibold whitespace-nowrap tabular-nums">{option.amount}</span>
                    ) : null}
                  </FieldLabel>
                ))}
              </RadioGroup>
              <p className="text-xs text-muted-foreground">
                {partMarked ? "Acepta una parte. " : ""}Si acepta solo una parte, marca cada tratamiento.
              </p>
            </fieldset>
          ) : null}
          <ul className="flex flex-col divide-y rounded-xl border">{lines.map((line) => lineRow(line))}</ul>
        </>
      )}

      <dl className="flex flex-col gap-1.5 rounded-xl bg-muted/50 p-4 text-sm">
        {paths ? null : (
          <div className="flex gap-3">
            <dt className="flex-1 text-muted-foreground">Presupuestado</dt>
            <dd className="text-right tabular-nums">
              {fixedOption ? totalsWords(fixedOption, budget.currency, plainMoney) : AMOUNT_PENDING}
            </dd>
          </div>
        )}
        <div className="flex items-baseline gap-3">
          <dt className="flex-1 font-semibold">Acepta</dt>
          <dd className="text-right">
            <span className="text-lg font-semibold tabular-nums">{acceptingWords()}</span>
            {pathPending ? (
              <span className="text-sm text-muted-foreground">
                {site?.short ? ` · ${site.short} sigue por decidir` : " · falta elegir el camino"}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      {picker(`${uid}-drawer-decider`)}

      <form.AppField name="decisionNote">
        {(field) => <field.TextareaField label="Nota, si hace falta" rows={2} maxLength={4000} />}
      </form.AppField>

      <p role="status" className="text-sm text-muted-foreground">
        {unanswered > 0 || pathMissing
          ? [
              unanswered === 1
                ? "Falta marcar la respuesta de 1 tratamiento."
                : unanswered > 1
                  ? `Falta marcar la respuesta de ${unanswered} tratamientos.`
                  : null,
              pathMissing ? "Falta elegir el camino." : null,
            ]
              .filter(Boolean)
              .join(" ")
          : `Quedará como «${expectedState(panelAnswered, paths && !picked ? budget.options : undefined)}», anotado por ti.${
              panelAnswered.includes("pospuesto") ? " Lo que deja para después se puede responder luego." : ""
            }`}
      </p>
      <p className="text-sm text-muted-foreground">
        {draftInPerson ? "Al guardar queda entregado, sin enviarle nada. " : ""}
        Si algo quedó mal, se corrige creando una revisión del presupuesto.
      </p>
    </FormDrawer>
  ) : null

  // Solo el cajón: desde «Anotar su respuesta» o «¿Qué respondió?» de «Qué sigue».
  if (direct) {
    return (
      <>
        {drawer}
        {signingScreen}
      </>
    )
  }

  return (
    <section
      aria-label="Respuesta de la persona"
      className={cn("flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4", className)}
    >
      <div className="flex flex-col gap-1.5">
        <h4 className="text-base font-semibold">¿Qué respondió?</h4>
        <Badge variant={budgetStatusTone(budget.status)} className="h-auto self-start py-0.5 text-left whitespace-normal">
          {statusLine}
        </Badge>
      </div>

      {budget.decidedAt ? (
        <dl className="flex flex-col gap-1.5 rounded-xl bg-muted/50 p-4 text-sm">
          <div className="flex gap-3">
            <dt className="flex-1 text-muted-foreground">{several && chosenOption ? chosenOption.label : "Presupuestado"}</dt>
            <dd className="text-right tabular-nums">
              {totalsWords(budget, budget.currency, plainMoney)}
            </dd>
          </div>
          <div className="flex items-baseline gap-3">
            <dt className="flex-1 font-semibold">Aceptó</dt>
            <dd className="text-right text-lg font-semibold tabular-nums">{acceptedWords(budget, budget.currency, money)}</dd>
          </div>
        </dl>
      ) : null}
      {budget.decidedAt ? <AnsweredBy budget={budget} formatDay={formatDay} /> : null}
      {budget.decisionNote ? <p className="text-sm text-muted-foreground">Nota: {budget.decisionNote}</p> : null}

      {!answerable ? null : !canDecide ? (
        <p className="text-sm text-muted-foreground">
          Tu rol no anota respuestas de presupuestos: lo hacen recepción, caja, el {appWords().clinician.one} o la administración.
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
          {!drawerOpen ? picker(`${uid}-decider`) : null}
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              size="lg"
              disabled={blocked || nothingOpen}
              onClick={() => askConfirm("aceptado")}
            >
              <Check aria-hidden="true" />
              Acepta todo
            </Button>
            {openLines.length > 1 || (choosing && pathOpen) ? (
              <Button type="button" variant="outline" disabled={blocked} onClick={() => openPanel("parte")}>
                Acepta una parte
              </Button>
            ) : null}
            {/* Pensarlo no cierra nada (se responde después): se anota con un clic. */}
            <SubmitButton
              variant="outline"
              pending={saving && confirming == null && !drawerOpen}
              disabled={blocked || nothingOpen}
              onClick={() => void answerAll("pospuesto")}
            >
              Lo va a pensar
            </SubmitButton>
            <Button
              type="button"
              variant="outline"
              className="text-destructive"
              disabled={blocked || nothingOpen}
              onClick={() => askConfirm("rechazado")}
            >
              No acepta
            </Button>
          </div>
          {formError && !drawerOpen ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Aceptar no genera deuda. Cada tratamiento se cobra cuando se atiende, o antes si la persona deja un adelanto.
          </p>
          <div className="flex flex-col gap-1 border-t pt-3">
            <span className="text-sm font-semibold text-muted-foreground">También puede responder la persona</span>
            <span className="text-sm">
              Por el chat: {receptionName} le confirma lo que entendió antes de anotarlo. Si tiene acceso al portal, también
              puede elegir ahí. Su respuesta llega aquí.
            </span>
          </div>
        </>
      )}

      {/*
        Aceptar o no aceptar todo no se reescribe después: una confirmación corta.
        Si el servidor lo rechaza, el diálogo se cierra y el motivo queda junto a
        su campo (quién decide) o bajo los botones, nunca detrás.
      */}
      <ConfirmDialog
        open={confirming != null}
        title={confirming === "rechazado" ? "¿Anotar que no acepta?" : "¿Anotar que acepta todo?"}
        description={`${decider ? `Decide ${decider.name}, ${deciderRole(decider.kind)}. ` : ""}Quedará como «${expectedState(
          lines.map((line) => (lineAwaitsAnswer(line) ? (confirming ?? "pospuesto") : line.decision)),
          choosing ? budget.options : undefined,
        )}» y ya no se cambia: para corregirlo se crea una revisión.`}
        confirmLabel={confirming === "rechazado" ? "Anotar que no acepta" : "Anotar que acepta todo"}
        variant={confirming === "rechazado" ? "destructive" : "default"}
        pending={saving}
        onConfirm={() => {
          if (!confirming) return
          void answerAll(confirming).then((saved) => {
            if (!saved) setConfirming(null)
          })
        }}
        onClose={() => {
          if (!saving) setConfirming(null)
        }}
      />

      {drawer}
      {signingScreen}
    </section>
  )
}
