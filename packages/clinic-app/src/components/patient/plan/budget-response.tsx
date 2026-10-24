/**
 * «¿Qué respondió?»: la respuesta de la persona a un presupuesto entregado.
 * Con varias opciones, primero se elige una (las demás quedan «No elegida»
 * solas); dentro de ella, cada tratamiento se acepta, se deja para después o no
 * se acepta. Nada queda anotado hasta guardar, porque lo aceptado o no aceptado
 * no se reescribe después. Sirve a quien tenga `budgets.decide`: el odontólogo
 * de lo que indicó, recepción y caja (decisión 4).
 */
import { budgetStateText, sumAcceptedCents } from "@odentia/clinical"
import {
  Badge,
  Button,
  ButtonGroup,
  buttonVariants,
  cn,
  Field,
  FieldDescription,
  FieldLabel,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  Textarea,
} from "@odentia/ui"
import { ConfirmDialog, ErrorState, FormDrawer, SubmitButton } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check } from "lucide-react"
import { useId, useMemo, useState } from "react"
import { useReceptionName } from "../../../lib/agent-names"
import { ApiError, apiFetch } from "../../../lib/api"
import {
  BUDGET_ANSWERABLE_STATUSES,
  type BudgetLine,
  type BudgetWithTotals,
  budgetAnswerLabel,
  budgetNumberLabel,
  decideBudgetApi,
  optionLines,
} from "../../../lib/budgets"
import { fetchResponsibilities } from "../../../lib/clinical-journey"
import { usePermission } from "../../../lib/crm"
import type { PatientFull } from "../../../lib/patients"
import { ChoiceSelect } from "../../ui/choice-select"
import { AMOUNT_PENDING, budgetStatusTone, type Money, mutationMessage } from "./budget-parts"

type Answer = "aceptado" | "pospuesto" | "rechazado"

const ANSWER_OPTIONS: ReadonlyArray<{ value: Answer; label: string }> = [
  { value: "aceptado", label: "Acepta" },
  { value: "pospuesto", label: "Para después" },
  { value: "rechazado", label: "No" },
]

/** Lo que la persona ya aceptó o no aceptó no se reescribe al completar la respuesta. */
function isAnswerFinal(line: BudgetLine): boolean {
  return line.decision === "aceptado" || line.decision === "rechazado"
}

/** Cómo quedará, con las palabras de siempre: misma derivación que `decideBudget`. */
function expectedState(answers: Answer[]): string {
  const accepted = answers.filter((answer) => answer === "aceptado").length
  const status =
    accepted === answers.length
      ? "aceptado"
      : accepted > 0
        ? "parcial"
        : answers.includes("pospuesto")
          ? "pospuesto"
          : "rechazado"
  return budgetStateText({ status, items: answers.map((decision) => ({ decision })) })
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

/** «Decide Elena Huamán, paciente» con «Cambiar». */
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
        {!locked && !changing && decider ? (
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onStartChange}>
            Cambiar
          </Button>
        ) : null}
      </div>
      {!locked && changing && decider ? (
        <Field>
          <FieldLabel htmlFor={selectId}>Quién decide</FieldLabel>
          <ChoiceSelect id={selectId} value={decider.id} onChange={(event) => onChange(event.target.value)}>
            {deciders.map((option) => (
              <option key={option.id} value={option.id}>
                {`${option.name} · ${deciderRole(option.kind)}`}
              </option>
            ))}
          </ChoiceSelect>
          <FieldDescription>Decide el paciente o su representante legal vigente.</FieldDescription>
          {responsiblesLink}
        </Field>
      ) : null}
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
      {!decider || (notice && !changing && !locked) ? responsiblesLink : null}
    </div>
  )
}

export function BudgetResponse({
  patientId,
  budget,
  disabled = false,
  money,
  formatDay,
  runWrite,
  openOnMount = false,
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
  className?: string
}): React.JSX.Element {
  const receptionName = useReceptionName()
  const uid = useId()
  const queryClient = useQueryClient()
  const canDecide = usePermission("budgets.decide")
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

  // La opción elegida: la que ya eligió o, mientras decide, la que se marca aquí.
  const chosenOption = budget.options.find((option) => option.decision === "elegida") ?? null
  const several = budget.options.length > 1
  const [pickedOptionId, setPickedOptionId] = useState<string | null>(
    chosenOption?.id ?? (several ? null : (budget.options[0]?.id ?? null)),
  )
  const optionId = chosenOption?.id ?? pickedOptionId
  const lines = optionId ? optionLines(budget, optionId) : []

  const [chosenDeciderId, setChosenDeciderId] = useState<string | null>(null)
  const [changingDecider, setChangingDecider] = useState(false)
  /** `null`: panel cerrado. Con valor, la respuesta en preparación por tratamiento. */
  const [draft, setDraft] = useState<Record<string, Answer | undefined> | null>(() =>
    openOnMount && active && !several ? {} : null,
  )
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
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

  const openLines = lines.filter((line) => !isAnswerFinal(line))
  const amount = (cents: number | null): string => (cents == null ? AMOUNT_PENDING : money(cents, budget.currency))

  const openWith = (preset: Answer | null) => {
    setDraft(preset ? Object.fromEntries(openLines.map((line) => [line.planItemId, preset])) : {})
    setNote(budget.decisionNote ?? "")
    setError(null)
  }

  /** Respuesta de la línea: la ya anotada si es definitiva; si no, la marcada en el panel. */
  const answerOf = (line: BudgetLine): Answer | undefined =>
    line.decision === "aceptado" || line.decision === "rechazado" ? line.decision : draft?.[line.planItemId]

  /** Lo marcado como «Acepta» mientras se elige: la misma regla del servidor (`sumAcceptedCents`). */
  const acceptingCents = (): number | null =>
    sumAcceptedCents(lines.map((line) => ({ lineTotalCents: line.lineTotalCents, decision: answerOf(line) })))

  type Decisions = Array<{ planItemId: string; decision: Answer }>

  const send = async (decisions: Decisions, decisionNote: string | null): Promise<boolean> => {
    if (saving || !optionId) return false
    const body = { optionId, decisions, decidedByContactId: decider?.id ?? null, decisionNote }
    setSaving(true)
    setError(null)
    try {
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
      return true
    } catch (err) {
      setError(mutationMessage(err))
      return false
    } finally {
      setSaving(false)
    }
  }

  const answerAll = async (answer: Answer): Promise<void> => {
    const saved = await send(
      lines.map((line) => ({
        planItemId: line.planItemId,
        decision: line.decision === "aceptado" || line.decision === "rechazado" ? line.decision : answer,
      })),
      budget.decisionNote ?? null,
    )
    if (saved) setConfirming(null)
  }

  const submit = async () => {
    if (!draft || saving) return
    const decisions: Decisions = []
    for (const line of lines) {
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
    budget.status === "presentado" && budget.presentedAt
      ? `${budget.stateText} · enviado el ${formatDay(budget.presentedAt)}`
      : budget.decidedAt && ["aceptado", "parcial", "rechazado", "pospuesto"].includes(budget.status)
        ? `${budget.stateText} · respondió el ${formatDay(budget.decidedAt)}`
        : budget.stateText

  const decidersLoading = active && canPatients && (patientQuery.isPending || responsibilitiesQuery.isPending)
  const decidersError = patientQuery.error ?? responsibilitiesQuery.error
  const blocked = disabled || saving || decidersLoading || optionId == null

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

  const answers = lines.flatMap((line) => answerOf(line) ?? [])
  const unanswered = lines.length - answers.length
  const patientShortName = patient?.patient.givenNames?.trim().split(/\s+/)[0] ?? patient?.patient.displayName ?? null
  const chosen = budget.options.find((option) => option.id === optionId) ?? null

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
            <dt className="flex-1 text-muted-foreground">{several && chosen ? chosen.label : "Presupuestado"}</dt>
            <dd className="text-right tabular-nums">
              {budget.totalCents == null ? AMOUNT_PENDING : money.plain(budget.totalCents, budget.currency)}
            </dd>
          </div>
          <div className="flex items-baseline gap-3">
            <dt className="flex-1 font-semibold">Aceptó</dt>
            <dd className="text-right text-lg font-semibold tabular-nums">{amount(budget.acceptedCents)}</dd>
          </div>
        </dl>
      ) : null}
      {budget.decidedAt && budget.acceptedByName ? (
        <p className="text-sm text-muted-foreground">Respondió {budget.acceptedByName}.</p>
      ) : null}
      {budget.decisionNote ? <p className="text-sm text-muted-foreground">Nota: {budget.decisionNote}</p> : null}

      {!answerable ? null : !canDecide ? (
        <p className="text-sm text-muted-foreground">
          Tu rol no anota respuestas de presupuestos: lo hacen recepción, caja, el odontólogo o la administración.
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
          {several && !chosenOption ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">¿Qué opción eligió?</legend>
              <RadioGroup
                value={pickedOptionId ?? ""}
                onValueChange={(value) => {
                  setPickedOptionId(typeof value === "string" && value ? value : null)
                  setDraft(null)
                }}
              >
                {budget.options.map((option) => (
                  <FieldLabel key={option.id} className="flex items-start gap-3 rounded-lg border p-3 text-sm font-normal">
                    <RadioGroupItem value={option.id} className="mt-0.5" aria-label={option.label} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium">
                        {option.label}
                        {option.isRecommended ? " · recomendada" : ""}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {optionLines(budget, option.id)
                          .map((line) => line.title)
                          .join(" · ")}
                      </span>
                    </span>
                    <span className="font-semibold tabular-nums">{amount(option.totalCents)}</span>
                  </FieldLabel>
                ))}
              </RadioGroup>
              <p className="text-xs text-muted-foreground">Al elegir una, las otras quedan «No elegida».</p>
            </fieldset>
          ) : null}
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
              <Button type="button" variant="outline" disabled={blocked} onClick={() => openWith(null)}>
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

      {/* Aceptar o no aceptar todo no se reescribe después: una confirmación corta. */}
      <ConfirmDialog
        open={confirming != null}
        title={confirming === "rechazado" ? "¿Anotar que no acepta?" : "¿Anotar que acepta todo?"}
        description={`${decider ? `Decide ${decider.name}, ${deciderRole(decider.kind)}. ` : ""}${
          several && chosen ? `Elige la ${chosen.label.toLowerCase()}; las demás quedan «No elegida». ` : ""
        }Quedará como «${expectedState(
          lines.map((line) =>
            line.decision === "aceptado" || line.decision === "rechazado" ? line.decision : (confirming ?? "pospuesto"),
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
          title={patientShortName ? `¿Qué acepta ${patientShortName}?` : "¿Qué acepta la persona?"}
          description={`${budgetNumberLabel(budget.budgetNumber)}${
            several && chosen ? ` · ${chosen.label}` : ""
          }. Marca la respuesta de cada tratamiento.`}
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
            {lines.map((line) => {
              const final = isAnswerFinal(line)
              const value = answerOf(line)
              return (
                <li key={line.id} className="flex flex-col gap-2 px-3 py-3">
                  <div className="flex gap-3 text-sm">
                    <span className="min-w-0 flex-1 font-medium">{line.title}</span>
                    <span className="whitespace-nowrap tabular-nums">
                      {line.lineTotalCents == null ? "Sin precio" : money.plain(line.lineTotalCents, line.currency)}
                    </span>
                  </div>
                  {final ? (
                    <p className="text-xs text-muted-foreground">
                      Ya respondió: {budgetAnswerLabel(line.decision).toLowerCase()}. No se cambia desde aquí.
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
                            setDraft((current) => (current ? { ...current, [line.planItemId]: option.value } : current))
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
              <dd className="text-right tabular-nums">
                {chosen?.totalCents == null ? AMOUNT_PENDING : money.plain(chosen.totalCents, budget.currency)}
              </dd>
            </div>
            <div className="flex items-baseline gap-3">
              <dt className="flex-1 font-semibold">Acepta</dt>
              <dd className="text-right text-lg font-semibold tabular-nums">{amount(acceptingCents())}</dd>
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
              : `Quedará como «${expectedState(answers)}».${
                  answers.includes("pospuesto") ? " Lo que deja para después se puede responder luego." : ""
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
