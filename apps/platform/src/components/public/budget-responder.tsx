import { Checkbox, RadioGroup, RadioGroupItem } from "@odentia/ui"
import { SubmitButton } from "@odentia/ui-patterns"
import { Check, Minus } from "lucide-react"
import { useState } from "react"
import { formatPortalDate, formatPortalMoney, type PortalBudget } from "../../lib/portal"

export type BudgetDecision = "aceptado" | "rechazado" | "pospuesto"

export interface BudgetAnswer {
  optionId: string | null
  decisions: Array<{ planItemId: string; decision: BudgetDecision }>
}

/**
 * «Ver y responder» (tablero 3): el presupuesto como lo ve la persona, en «Su
 * enlace» y en el portal. Cada línea se marca para aceptarla; lo que no marca
 * queda «para después». Con varias opciones elige una y, dentro de ella, puede
 * dejar algo para después. Los totales son los del servidor: aquí solo se
 * suma lo marcado para decir «Aceptas S/ 360 de S/ 540».
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
  const recommended = budget.options.find((option) => option.isRecommended) ?? budget.options[0] ?? null
  const [pickedOptionId, setPickedOptionId] = useState<string | null>(chosen?.id ?? (several ? (recommended?.id ?? null) : null))
  const viewedOption = chosen ?? budget.options.find((option) => option.id === pickedOptionId) ?? recommended
  const lines = viewedOption ? budget.items.filter((item) => item.optionId === viewedOption.id) : budget.items
  const open = (decision: string) => decision !== "aceptado" && decision !== "rechazado"
  // Por omisión todo marcado: lo habitual es aceptar lo que propone su odontólogo.
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const accepted = (planItemId: string, decision: string) => (open(decision) ? !unchecked.has(planItemId) : decision === "aceptado")
  const money = (cents: number | null, plain = false) => formatPortalMoney(cents, budget.currency, budget.locale, plain)
  const acceptedCents = lines.reduce((sum, item) => sum + (accepted(item.planItemId, item.decision) ? (item.lineTotalCents ?? 0) : 0), 0)
  const totalCents = several && viewedOption ? viewedOption.totalCents : budget.totalCents
  const anyOpen = lines.some((item) => open(item.decision))
  const hasSessions = lines.some((item) => item.billingMode === "session")
  const answer = () =>
    onAnswer({
      optionId: several ? (viewedOption?.id ?? null) : null,
      decisions: lines
        .filter((item) => open(item.decision))
        .map((item) => ({ planItemId: item.planItemId, decision: unchecked.has(item.planItemId) ? "pospuesto" : "aceptado" })),
    })
  const noneMarked = lines.filter((item) => open(item.decision)).every((item) => unchecked.has(item.planItemId))
  const label =
    several && !chosen && viewedOption ? `Elijo la ${viewedOption.label.toLowerCase()}` : noneMarked ? "Lo dejo para después" : "Acepto lo marcado"

  return (
    <div className="flex flex-col gap-4">
      {several && !chosen ? (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-sm font-semibold">Elige una</legend>
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
                    {option.label} · {money(option.totalCents)}
                  </span>
                  <span className="text-muted-foreground">
                    {[
                      option.isRecommended ? "La recomienda tu odontólogo" : null,
                      budget.items
                        .filter((item) => item.optionId === option.id)
                        .map((item) => item.title)
                        .join(" · "),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
          <p className="text-sm text-muted-foreground">Dentro de la opción, puedes dejar algo para después.</p>
        </fieldset>
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
            !checked ? (item.decision === "rechazado" ? "No lo aceptaste" : "Lo dejo para después") : null,
          ]
            .filter(Boolean)
            .join(" · ")
          return (
            <li key={item.planItemId} className="flex items-center gap-3 p-3 text-sm">
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
              <label htmlFor={isOpen ? id : undefined} className="flex min-h-11 min-w-0 flex-1 cursor-pointer flex-col justify-center">
                <span className="font-medium">{item.title}</span>
                {detail ? <span className="text-muted-foreground">{detail}</span> : null}
              </label>
              <span className="whitespace-nowrap font-medium tabular-nums">{money(item.lineTotalCents, true)}</span>
            </li>
          )
        })}
      </ul>

      <p className="text-sm font-semibold" aria-live="polite">
        Aceptas {money(acceptedCents)} de {money(totalCents)}
      </p>
      {hasSessions ? (
        <p className="text-sm text-muted-foreground">No lo pagas todo desde el primer día: lo que se cobra por visita se paga en cada visita.</p>
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
        <SubmitButton type="button" className="min-h-11 w-full" pending={pending} disabled={several && !viewedOption} onClick={answer}>
          {label}
        </SubmitButton>
      ) : null}
    </div>
  )
}
