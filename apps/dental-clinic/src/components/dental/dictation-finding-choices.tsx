import { findingDefinition, surfaceLabel, surfacesForTooth } from "@odentia/dental"
import { Button } from "@odentia/ui"
import { Mic } from "lucide-react"
import type { DictationSession, DictationSuggestion } from "@odentia/clinic-app/components/patient/dictation-session"

/** Las piezas que se nombraron en este dictado, para elegir la que falta con un toque. */
function teethNamed(session: DictationSession): number[] {
  const teeth = new Set<number>(session.teeth)
  for (const item of session.suggestions) {
    if (typeof item.payload["toothNumber"] === "number") teeth.add(item.payload["toothNumber"])
  }
  return [...teeth].sort((a, b) => a - b).slice(0, 8)
}

/**
 * Lo que le falta a una indicación dictada (la pieza o la cara): no impide
 * confirmarla. Se elige con un toque, se dice («oclusal», «en la veinticinco»)
 * o, si aún no se sabe, se confirma igual y se define al hacerla.
 */
export function PlanSiteChoices({
  session,
  item,
  busy,
}: {
  session: DictationSession
  item: DictationSuggestion
  busy: boolean
}) {
  const pending = Array.isArray(item.payload["pending"]) ? (item.payload["pending"] as string[]) : []
  if (pending.length === 0) return null
  const tooth = typeof item.payload["toothNumber"] === "number" ? item.payload["toothNumber"] : null
  const choose = (patch: Record<string, unknown>) => session.save.mutate({ item, patch, confirm: false })
  const disabled = busy || session.save.isPending
  const chip = "h-auto min-h-11 whitespace-normal sm:min-h-8"
  const named = teethNamed(session)
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-warning-soft p-2.5 sm:ml-8">
      {pending.includes("toothNumber") ? (
        <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0" aria-label="Pieza">
          {named.map((value) => (
            <Button key={value} type="button" variant="outline" size="sm" className={chip} disabled={disabled} onClick={() => choose({ toothNumber: value })}>
              {value}
            </Button>
          ))}
          <Button type="button" variant="ghost" size="sm" className={chip} disabled={disabled} onClick={() => session.openEdit(item)}>
            Otra pieza…
          </Button>
        </fieldset>
      ) : tooth !== null && pending.includes("surfaces") ? (
        <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0" aria-label={`Cara de la ${tooth}`}>
          {surfacesForTooth(tooth).map((surface) => (
            <Button key={surface} type="button" variant="outline" size="sm" className={chip} disabled={disabled} onClick={() => choose({ surfaces: [surface] })}>
              {surfaceLabel(surface)}
            </Button>
          ))}
        </fieldset>
      ) : null}
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Mic className="size-3.5" aria-hidden /> o dila mientras dictas
      </p>
    </div>
  )
}

/**
 * Lo que la norma del país pide de un hallazgo dictado y no se dijo (la
 * profundidad de una caries, el estado de una corona): se elige con un toque,
 * con los nombres del odontograma. También se puede completar diciéndolo.
 */
export function FindingChoices({
  session,
  item,
  busy,
}: {
  session: DictationSession
  item: DictationSuggestion
  busy: boolean
}) {
  const condition = String(item.payload["condition"] ?? "")
  const finding = findingDefinition(condition)
  const missing = Array.isArray(item.payload["missing"])
    ? (item.payload["missing"] as string[])
    : []
  if (!finding || missing.length === 0) return null
  const choose = (patch: Record<string, string>) =>
    session.save.mutate({ item, patch, confirm: false })
  const choice = "h-auto min-h-11 whitespace-normal sm:min-h-8"
  return (
    <div className="flex flex-col gap-2 sm:pl-8">
      {missing.includes("variant") && finding.variants ? (
        <fieldset
          className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0"
          aria-label={finding.variantName ?? "Variante"}
        >
          {finding.variants.map((variant) => (
            <Button
              key={variant.value}
              type="button"
              variant="outline"
              size="sm"
              className={choice}
              disabled={busy || session.save.isPending}
              onClick={() => choose({ variant: variant.value })}
            >
              {variant.label}
            </Button>
          ))}
        </fieldset>
      ) : null}
      {missing.includes("quality") ? (
        <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0" aria-label="Estado">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={choice}
            disabled={busy || session.save.isPending}
            onClick={() => choose({ quality: "good" })}
          >
            Buen estado
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={choice}
            disabled={busy || session.save.isPending}
            onClick={() => choose({ quality: "poor" })}
          >
            Mal estado
          </Button>
        </fieldset>
      ) : null}
    </div>
  )
}
