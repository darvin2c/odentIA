import type { PatientGuide } from "@odentia/clinical"
import { Checkbox, FieldLegend, FieldSet, RadioGroup, RadioGroupItem } from "@odentia/ui"
import { SubmitButton } from "@odentia/ui-patterns"
import { Check, ChevronDown, Minus } from "lucide-react"
import { type ReactNode, useState } from "react"
import { formatPortalDate, formatPortalMoney, type PortalBudget } from "../../lib/portal"
import { appWords } from "../../lib/product-words"

export type BudgetDecision = "aceptado" | "rechazado" | "pospuesto"

export interface BudgetAnswer {
  optionId: string | null
  decisions: Array<{ planItemId: string; decision: BudgetDecision }>
}

/** «19 de noviembre»: la fecha civil tal cual, sin que la zona la mueva de día. */
function civilDay(value: string, locale: string | null): string {
  const date = new Date(`${value}T12:00:00Z`)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleDateString(locale?.trim() || undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
}

/** Plegado accesible y nativo, con su alto táctil: se abre con Enter o tocándolo. */
function Fold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group rounded-xl border bg-card text-sm">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 font-medium [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className="flex flex-col gap-2 px-3 pb-3 text-muted-foreground">{children}</div>
    </details>
  )
}

function Text({ children }: { children: string }) {
  return <p className="whitespace-pre-wrap">{children}</p>
}

/** Lo que dice cada línea de cómo se hace; sin explicación no hay nada que desplegar. */
function lineGuideRows(guide: PatientGuide | null | undefined): Array<[string, string]> {
  if (!guide) return []
  const visits = [
    guide.visits ? `${guide.visits} ${guide.visits === "1" ? "visita" : "visitas"}` : null,
    guide.visitLength,
  ]
    .filter(Boolean)
    .join(" de ")
  const rows: Array<[string, string | undefined]> = [
    ["Visitas", visits || undefined],
    ["Cómo se hace", guide.how],
    ["Incluye", guide.includes],
    ["No incluye", guide.excludes],
    ["Después", guide.aftercare],
  ]
  return rows.filter((row): row is [string, string] => Boolean(row[1]))
}

/**
 * «Ver y responder» (tablero 3): el presupuesto como lo ve la persona, en «Su
 * enlace» y en el portal. Cada línea se marca para aceptarla; lo que no marca
 * queda «para después». Con varias opciones elige una y, dentro de ella, puede
 * dejar algo para después. Los totales son los del servidor: aquí solo se
 * suma lo marcado para decir «Aceptas S/ 360 de S/ 540». Lo que explica (lo
 * encontrado, lo propuesto, cómo se hace) sale solo si llega: sin explicación
 * se ve con su nombre y su precio.
 */
export function BudgetResponder({
  budget,
  pending,
  error,
  onAnswer,
}: {
  budget: PortalBudget
  pending: boolean
  error: string | null
  onAnswer: (answer: BudgetAnswer) => void
}) {
  const several = budget.options.length > 1
  const chosen = budget.options.find((option) => option.decision === "elegida") ?? null
  const recommended =
    budget.options.find((option) => option.isRecommended) ?? budget.options[0] ?? null
  const [pickedOptionId, setPickedOptionId] = useState<string | null>(
    chosen?.id ?? (several ? (recommended?.id ?? null) : null),
  )
  const viewedOption =
    chosen ?? budget.options.find((option) => option.id === pickedOptionId) ?? recommended
  const lines = viewedOption
    ? budget.items.filter((item) => item.optionId === viewedOption.id)
    : budget.items
  const open = (decision: string) => decision !== "aceptado" && decision !== "rechazado"
  // Por omisión todo marcado: lo habitual es aceptar lo que propone su odontólogo.
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const accepted = (planItemId: string, decision: string) =>
    open(decision) ? !unchecked.has(planItemId) : decision === "aceptado"
  const money = (cents: number | null, plain = false) =>
    formatPortalMoney(cents, budget.currency, budget.locale, plain)
  const acceptedCents = lines.reduce(
    (sum, item) =>
      sum + (accepted(item.planItemId, item.decision) ? (item.lineTotalCents ?? 0) : 0),
    0,
  )
  const totalCents = several && viewedOption ? viewedOption.totalCents : budget.totalCents
  const anyOpen = lines.some((item) => open(item.decision))
  const hasSessions = lines.some((item) => item.billingMode === "session")
  const answer = () =>
    onAnswer({
      optionId: several ? (viewedOption?.id ?? null) : null,
      decisions: lines
        .filter((item) => open(item.decision))
        .map((item) => ({
          planItemId: item.planItemId,
          decision: unchecked.has(item.planItemId) ? "pospuesto" : "aceptado",
        })),
    })
  const noneMarked = lines
    .filter((item) => open(item.decision))
    .every((item) => unchecked.has(item.planItemId))
  const label =
    several && !chosen && viewedOption
      ? `Elijo la ${viewedOption.label.toLowerCase()}`
      : noneMarked
        ? "Lo dejo para después"
        : "Acepto lo marcado"

  // Lo que se reparte en el tiempo o avisa, una vez por tratamiento que lo traiga.
  const guided = lines.filter((item) => item.patientGuide)
  const schedules = guided.filter((item) => item.patientGuide?.schedule?.length)
  const warnings = guided.filter((item) => item.patientGuide?.warnings)
  const excludes = guided.filter((item) => item.patientGuide?.excludes)
  const terms = budget.terms

  return (
    <div className="flex flex-col gap-4">
      {/* Quién: lo dice la cabecera de cada página, con el nombre de la clínica. */}
      {budget.validUntil ? (
        <p className="text-sm text-muted-foreground">
          Vigente hasta el {civilDay(budget.validUntil, budget.locale)}
        </p>
      ) : null}
      {budget.findings ? (
        <section aria-label="Lo que encontramos" className="flex flex-col gap-1 text-sm">
          <h3 className="font-semibold">Lo que encontramos</h3>
          <Text>{budget.findings}</Text>
        </section>
      ) : null}
      {budget.proposal || guided.length > 0 ? (
        <h3 className="text-sm font-semibold">Lo que te proponemos</h3>
      ) : null}
      {budget.proposal ? <p className="text-sm whitespace-pre-wrap">{budget.proposal}</p> : null}

      {several && !chosen ? (
        <FieldSet className="gap-2">
          <FieldLegend className="mb-2 text-sm font-semibold">Elige una</FieldLegend>
          <RadioGroup
            value={pickedOptionId ?? ""}
            onValueChange={(value) => {
              setPickedOptionId(typeof value === "string" && value ? value : null)
              setUnchecked(new Set())
            }}
          >
            {budget.options.map((option) => (
              <label
                key={option.id}
                htmlFor={`opcion-${option.id}`}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border bg-card p-3 text-sm has-[[data-checked]]:border-primary has-[[data-checked]]:bg-primary-soft"
              >
                <RadioGroupItem id={`opcion-${option.id}`} value={option.id} className="mt-0.5" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-semibold">
                    {option.name?.trim() || option.label} · {money(option.totalCents)}
                  </span>
                  <span className="text-muted-foreground">
                    {[
                      option.isRecommended ? `La recomienda tu ${appWords().clinician.one}` : null,
                      budget.items
                        .filter((item) => item.optionId === option.id)
                        .map((item) => item.title)
                        .join(" · "),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {option.pros ? <span className="mt-1">A favor: {option.pros}</span> : null}
                  {option.cons ? <span className="mt-1">A considerar: {option.cons}</span> : null}
                </span>
              </label>
            ))}
          </RadioGroup>
          <p className="text-sm text-muted-foreground">
            Dentro de la opción, puedes dejar algo para después.
          </p>
        </FieldSet>
      ) : several && viewedOption ? (
        <p className="text-sm font-semibold">Elegiste la {viewedOption.label.toLowerCase()}</p>
      ) : null}

      <ul className="flex flex-col divide-y rounded-2xl border bg-card">
        {lines.map((item) => {
          const id = `linea-${item.planItemId}`
          const isOpen = open(item.decision)
          const checked = accepted(item.planItemId, item.decision)
          const detail = [
            item.billingMode === "session"
              ? item.sessionsPlanned === 1
                ? "1 sesión"
                : item.sessionsPlanned
                  ? `${item.sessionsPlanned} sesiones`
                  : "Se paga en cada visita"
              : null,
            item.promotionName ? `Promoción: ${item.promotionName}` : null,
            !checked
              ? item.decision === "rechazado"
                ? "No lo aceptaste"
                : "Lo dejo para después"
              : null,
          ]
            .filter(Boolean)
            .join(" · ")
          const guideRows = lineGuideRows(item.patientGuide)
          return (
            <li key={item.planItemId} className="flex flex-col p-3 text-sm">
              <div className="flex items-center gap-3">
                {isOpen ? (
                  <Checkbox
                    id={id}
                    checked={checked}
                    disabled={pending}
                    onCheckedChange={(next) => {
                      const copy = new Set(unchecked)
                      if (next === true) copy.delete(item.planItemId)
                      else copy.add(item.planItemId)
                      setUnchecked(copy)
                    }}
                  />
                ) : checked ? (
                  <Check className="size-4 text-success" aria-label="Aceptado" />
                ) : (
                  <Minus className="size-4 text-muted-foreground" aria-label="No aceptado" />
                )}
                <label
                  htmlFor={isOpen ? id : undefined}
                  className="flex min-h-11 min-w-0 flex-1 cursor-pointer flex-col justify-center"
                >
                  <span className="font-medium">{item.title}</span>
                  {detail ? <span className="text-muted-foreground">{detail}</span> : null}
                </label>
                <span className="whitespace-nowrap font-medium tabular-nums">
                  {money(item.lineTotalCents, true)}
                </span>
              </div>
              {guideRows.length > 0 ? (
                // Fuera de la etiqueta de la casilla: tocarlo no marca ni desmarca.
                <details className="group mt-1 pl-7">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-primary [&::-webkit-details-marker]:hidden">
                    Cómo es este tratamiento
                    <ChevronDown
                      aria-hidden
                      className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                    />
                  </summary>
                  <dl className="flex flex-col gap-1.5 pb-1 text-muted-foreground">
                    {guideRows.map(([term, text]) => (
                      <div key={term}>
                        <dt className="font-medium text-foreground">{term}</dt>
                        <dd className="whitespace-pre-wrap">{text}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ) : null}
            </li>
          )
        })}
      </ul>

      <p className="text-sm font-semibold" aria-live="polite">
        Aceptas {money(acceptedCents)} de {money(totalCents)}
      </p>
      {hasSessions ? (
        <p className="text-sm text-muted-foreground">
          No lo pagas todo desde el primer día: lo que se cobra por visita se paga en cada visita.
        </p>
      ) : null}

      {excludes.length > 0 ? (
        <Fold title="Qué no incluye">
          {excludes.map((item) => (
            <p key={item.planItemId}>
              <span className="font-medium text-foreground">{item.title}:</span>{" "}
              {item.patientGuide?.excludes}
            </p>
          ))}
        </Fold>
      ) : null}
      {schedules.length > 0 ? (
        <Fold title="Calendario">
          {schedules.map((item) => (
            <div key={item.planItemId}>
              <p className="font-medium text-foreground">{item.title}</p>
              <ul>
                {item.patientGuide?.schedule?.map((step) => (
                  <li key={`${step.when}-${step.what}`}>
                    {step.when}: {step.what}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Fold>
      ) : null}
      {warnings.length > 0 ? (
        <Fold title="Señales de alarma">
          {warnings.map((item) => (
            <p key={item.planItemId} className="whitespace-pre-wrap">
              <span className="font-medium text-foreground">{item.title}:</span>{" "}
              {item.patientGuide?.warnings}
            </p>
          ))}
        </Fold>
      ) : null}
      {terms?.payment || terms?.change ? (
        <Fold title="Condiciones">
          {terms.payment ? (
            <div>
              <p className="font-medium text-foreground">Cómo se paga</p>
              <Text>{terms.payment}</Text>
            </div>
          ) : null}
          {terms.change ? (
            <div>
              <p className="font-medium text-foreground">Si el importe cambia</p>
              <Text>{terms.change}</Text>
            </div>
          ) : null}
        </Fold>
      ) : null}

      {budget.decidedAt ? (
        <p className="text-sm text-muted-foreground">
          Respondido el {formatPortalDate(budget.decidedAt, { locale: budget.locale })}
          {budget.acceptedByName ? ` por ${budget.acceptedByName}` : ""}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {anyOpen ? (
        <SubmitButton
          type="button"
          className="min-h-11 w-full"
          pending={pending}
          disabled={several && !viewedOption}
          onClick={answer}
        >
          {label}
        </SubmitButton>
      ) : null}
    </div>
  )
}
