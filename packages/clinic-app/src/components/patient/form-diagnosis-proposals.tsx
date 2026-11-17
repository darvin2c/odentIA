/**
 * Lo que propone una ficha llenada a mano para el diagnóstico de la atención (estudio de la atención
 * del 16 nov, E10b). En la ficha de endodoncia, «Pulpitis irreversible sintomática» y «Periodontitis
 * apical sintomática» de la 36 proponen «K04.0 Pulpitis · irreversible sintomática · 36» y «K04.4 … ·
 * sintomática · 36», con el mismo «Usar» que ya usa la atención. Antes solo lo veía el dictado, y la
 * periodontitis apical quedaba fuera de Diagnóstico. Proponer no es registrar: nada entra solo. El
 * término lo guarda la ficha y la Historia lo lee de ahí; el diagnóstico guarda su código.
 */
import { Button } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { addDiagnosisApi } from "../../lib/encounters"
import { areaWords, type FormProposedDiagnosis, useDiagnosisSuggestions } from "./diagnosis-picker"

/** «K04.0 Pulpitis · irreversible sintomática · 36»: el código, su nombre, lo que suma la ficha y la pieza. */
export function formDiagnosisWords(item: FormProposedDiagnosis): string {
  const where = item.toothNumber != null ? String(item.toothNumber) : areaWords(item)
  return [`${item.code} ${item.description}`, item.qualifier, where].filter(Boolean).join(" · ")
}

export function FormDiagnosisProposals({
  patientId,
  encounterId,
  responseId,
  fieldIds,
  beforeUse,
}: {
  patientId: string
  encounterId: string
  responseId: string
  /** Las preguntas de la sección donde va: lo de otra sección se dice en la suya. */
  fieldIds: readonly string[]
  /** Lo escrito en la ficha se guarda antes de registrar. */
  beforeUse: () => Promise<unknown>
}): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const suggestions = useDiagnosisSuggestions(patientId, encounterId)
  const [using, setUsing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const items = (suggestions.data?.fromForms ?? []).filter((item) => item.responseId === responseId && fieldIds.includes(item.fieldId))
  if (items.length === 0) return null
  const keyOf = (item: FormProposedDiagnosis) => `${item.fieldId}-${item.code}-${item.toothNumber ?? ""}`

  const use = async (item: FormProposedDiagnosis) => {
    setError(null)
    setUsing(keyOf(item))
    try {
      await beforeUse()
      // Definitivo: es lo que concluyó quien llenó la ficha. Se cambia en Diagnóstico, como cualquiera.
      await addDiagnosisApi(patientId, encounterId, {
        diagnosisCode: item.code,
        diagnosisSystem: item.system,
        diagnosisType: "confirmed",
        toothNumber: item.toothNumber ?? null,
        surfaces: item.surfaces ?? [],
        quadrant: item.toothNumber == null ? (item.quadrant ?? null) : null,
        arch: item.toothNumber == null && item.quadrant == null ? (item.arch ?? null) : null,
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["diagnosis-suggestions", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["encounter", patientId, encounterId] }),
        queryClient.invalidateQueries({ queryKey: ["timeline", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["patient-diagnoses", patientId] }),
      ])
    } catch (err) {
      setError(submitErrorMessage(err))
    } finally {
      setUsing(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Lo que propone la ficha para el diagnóstico de la atención</p>
      <ul className="flex flex-col gap-2" aria-label="Lo que propone la ficha para el diagnóstico de la atención">
        {items.map((item) => {
          const words = formDiagnosisWords(item)
          return (
            <li key={keyOf(item)} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium [overflow-wrap:anywhere]">{words}</span>
                <span className="text-xs text-muted-foreground">
                  {item.registered
                    ? // Sin otra columna: el término queda en la ficha y la Historia lo dice junto al código.
                      `Ya está en Diagnóstico${item.qualifier ? `; la Historia dice «${item.qualifier}», de la ficha` : ""}`
                    : `De «${item.term}» · se registra definitivo`}
                </span>
              </div>
              {item.registered ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11 sm:min-h-8"
                  disabled={using !== null}
                  aria-label={`Usar ${words}`}
                  onClick={() => void use(item)}
                >
                  {using === keyOf(item) ? "Registrando…" : "Usar"}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
