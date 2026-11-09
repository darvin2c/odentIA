import type { OdontogramStandardProfile } from "@odentia/dental"
import { activeFindingsAsOf, surfaceLabel } from "@odentia/dental"
import { Button } from "@odentia/ui"
import { groupFindings } from "@odentia/clinic-app/lib/site-findings"
import { diagnosisCodeLabel } from "@odentia/clinical"
import type { OdontogramEntry } from "../../lib/dental/odontogram"
import { findingWords } from "./odontogram-notation"

/** «distal y oclusal». */
function surfacesWords(surfaces: string[]): string {
  const words = surfaces.map((surface) => surfaceLabel(surface).toLowerCase())
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} y ${words.at(-1)}`
}

/**
 * Lo que tiene la boca, en una lista debajo del dibujo (QA de la ficha del 8
 * nov: había que tocar cada pieza para saber qué tenía). Un renglón por
 * hallazgo, con sus caras juntas (una caries de dos caras es una), su sigla de
 * la norma si la clínica la usa y el diagnóstico con su nombre. Ordenado por
 * pieza; tocar el renglón abre la pieza, como tocar el diente. Sigue la fecha
 * de «Ver estado al».
 */
export function ActiveFindingsList({
  history,
  asOf,
  asOfLabel,
  official,
  onSelect,
}: {
  history: OdontogramEntry[]
  /** La fecha elegida en «Ver estado al»; sin ella, hoy. */
  asOf?: string
  asOfLabel?: string
  official: OdontogramStandardProfile | null
  onSelect: (tooth: number) => void
}): React.JSX.Element | null {
  const active = activeFindingsAsOf(
    history.filter((entry) => !entry.needsReview && entry.status !== "voided" && !entry.voidedAt),
    asOf,
  )
  const groups = groupFindings(active).sort(
    (a, b) => a.first.toothNumber - b.first.toothNumber || (a.first.createdAt ?? "").localeCompare(b.first.createdAt ?? ""),
  )
  // Sin nada registrado, el vacío de la pestaña ya lo dice y lleva a atender.
  if (history.length === 0) return null
  const heading = asOfLabel ? `Hallazgos al ${asOfLabel}` : "Hallazgos"
  return (
    <section aria-label={heading} className="flex flex-col gap-2 rounded-lg border p-4">
      <h3 className="text-sm font-medium">
        {heading}
        {groups.length > 0 ? <span className="text-muted-foreground"> · {groups.length}</span> : null}
      </h3>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin hallazgos vigentes.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {groups.map((group) => {
            const entry = group.first as OdontogramEntry
            const words = [
              findingWords(official, entry),
              group.surfaces.length ? surfacesWords(group.surfaces) : null,
              entry.diagnosisName ?? (entry.diagnosisCode ? diagnosisCodeLabel(entry.diagnosisSystem, entry.diagnosisCode) : null),
            ]
              .filter(Boolean)
              .join(" · ")
            return (
              <li key={group.ids.join(",")}>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start gap-3 px-2 py-2 text-left font-normal whitespace-normal"
                  aria-label={`Pieza ${entry.toothNumber}: ${words}. Abrir la pieza`}
                  onClick={() => onSelect(entry.toothNumber)}
                >
                  <span className="w-8 shrink-0 font-medium tabular-nums">{entry.toothNumber}</span>
                  <span className="min-w-0 text-sm">{words}</span>
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
