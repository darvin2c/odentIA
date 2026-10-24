import { findingDefinition } from "@odentia/dental"
import { Button } from "@odentia/ui"
import type { DictationSession, DictationSuggestion } from "../patient/dictation-session"

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
