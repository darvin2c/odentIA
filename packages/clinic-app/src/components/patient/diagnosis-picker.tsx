import { Badge, Button, Field, FieldLabel, Skeleton } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { type FocusEvent, useId } from "react"
import { apiFetch } from "../../lib/api"
import { type DiagnosisOption, DiagnosisSearch } from "./diagnosis-search"

/**
 * Lo que propone la atención: un hallazgo (odentIA: del odontograma) o un
 * tratamiento que continúa, con su pieza si el producto la registra.
 */
export interface ProposedDiagnosis extends DiagnosisOption {
  source: "hallazgo" | "tratamiento"
  /** El hallazgo («Lesión de caries dental») o el tratamiento con su pieza («Endodoncia posterior vital · 46»). */
  finding: string
  /** El tipo con que se registró la última vez para la persona; null si no hay o si lo propone un hallazgo. */
  diagnosisType: string | null
  toothNumber?: number | null
  surfaces?: string[]
  /** Un tratamiento por cuadrante o arcada propone su diagnóstico en esa área. */
  quadrant?: number | null
  arch?: string | null
}

/** El sitio que propone una propuesta y se registra al usarla: su pieza y caras, o su área. */
export type ProposedSite = {
  toothNumber: number | null
  surfaces: string[]
  quadrant: number | null
  arch: string | null
}

export function proposedSite(item: ProposedDiagnosis): ProposedSite {
  return {
    toothNumber: item.toothNumber ?? null,
    surfaces: item.surfaces ?? [],
    quadrant: item.toothNumber == null ? (item.quadrant ?? null) : null,
    arch: item.toothNumber == null && item.quadrant == null ? (item.arch ?? null) : null,
  }
}

/** «Cuadrante 1», «Arcada superior»; null si no es un área. */
export function areaWords(site: { quadrant?: number | null; arch?: string | null }): string | null {
  if (site.quadrant != null) return `Cuadrante ${site.quadrant}`
  if (site.arch === "upper") return "Arcada superior"
  if (site.arch === "lower") return "Arcada inferior"
  return null
}

/** Una clave por propuesta: el servidor no repite el mismo código en el mismo sitio. */
export function proposalKey(item: ProposedDiagnosis): string {
  return [item.system, item.code, item.toothNumber ?? "", item.quadrant ?? "", item.arch ?? ""].join("-")
}

/** De dónde sale una propuesta, para decirlo junto a ella. */
export function proposalOrigin(item: ProposedDiagnosis): string {
  if (item.source === "tratamiento") {
    const area = areaWords(item)
    return `Del tratamiento «${item.finding}»${area ? ` · ${area.toLowerCase()}` : ""}`
  }
  return `Propuesto por el hallazgo «${item.finding}»${item.toothNumber != null ? ` en la pieza ${item.toothNumber}` : ""}`
}

/** Las propuestas de la atención: las mismas en su tarjeta, en su bloque y en el formulario. */
export function useDiagnosisSuggestions(
  patientId: string,
  encounterId: string | null,
  finding: PickerFinding | null = null,
  enabled = true,
) {
  const params = new URLSearchParams()
  params.set("patientId", patientId)
  if (encounterId) params.set("encounterId", encounterId)
  if (finding?.condition) {
    params.set("condition", finding.condition)
    if (finding.variant) params.set("variant", finding.variant)
    if (finding.toothNumber != null) params.set("toothNumber", String(finding.toothNumber))
  }
  return useQuery({
    queryKey: diagnosisSuggestionsKey(patientId, encounterId, finding),
    queryFn: () =>
      apiFetch<{ data: DiagnosisSuggestions }>(`/api/diagnosis-codes/suggestions?${params}`).then(
        (r) => r.data,
      ),
    staleTime: 30_000,
    enabled,
  })
}

export interface DiagnosisSuggestions {
  system: string
  systemTitle: string
  proposed: ProposedDiagnosis[]
  mostUsed: DiagnosisOption[]
}

/** El hallazgo que se está marcando en la pieza: propone su código antes de guardarlo. */
export interface PickerFinding {
  condition: string
  variant?: string | null
  toothNumber?: number | null
}

export function diagnosisSuggestionsKey(
  patientId: string | null,
  encounterId: string | null,
  finding: PickerFinding | null,
) {
  return [
    "diagnosis-suggestions",
    patientId,
    encounterId,
    finding?.condition ?? null,
    finding?.variant ?? null,
    finding?.toothNumber ?? null,
  ] as const
}

/**
 * Elegir el diagnóstico en tres pasos (tablero 6, decisión 26): lo que propone
 * la atención (el odontograma o el tratamiento que continúa), los más usados en
 * la clínica y el buscador de toda la lista de la clínica. En la mayoría de las atenciones basta el paso 1 o el 2. Lo
 * que se propone lo decide el servidor (`/api/diagnosis-codes/suggestions`).
 * Elegir una propuesta devuelve también su pieza y sus caras. No pinta título
 * propio: la pantalla lo nombra (`FieldSet` + `FieldLegend` o `field.Group`).
 */
export function DiagnosisPicker({
  patientId,
  encounterId,
  finding = null,
  value,
  system = null,
  onChange,
  disabled = false,
  id: idProp,
  invalid = false,
  "aria-describedby": describedBy,
  onBlur,
}: {
  patientId: string
  encounterId: string | null
  finding?: PickerFinding | null
  value: string
  system?: string | null
  onChange: (
    choice: { code: string; description: string; system: string | null },
    site?: ProposedSite,
  ) => void
  disabled?: boolean
  /** Va al buscador, el enfocable principal. */
  id?: string
  invalid?: boolean
  "aria-describedby"?: string
  /** Al salir del grupo entero. */
  onBlur?: () => void
}) {
  const fallbackId = useId()
  const searchId = idProp ?? fallbackId
  const suggestions = useDiagnosisSuggestions(patientId, encounterId, finding)
  const data = suggestions.data
  const proposed = data?.proposed ?? []
  const mostUsed = data?.mostUsed ?? []
  // Los pasos se numeran solo con los que hay: sin propuestas, el buscador no es «3».
  const usedStep = proposed.length > 0 ? 2 : 1
  const searchStep = usedStep + (mostUsed.length > 0 ? 1 : 0)
  const isChosen = (option: DiagnosisOption) =>
    option.code === value && (system ?? data?.system) === option.system

  // `onBlur` solo al salir del grupo, no al pasar de un paso a otro.
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!onBlur || event.currentTarget.contains(event.relatedTarget as Node | null)) return
    onBlur()
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: solo escucha cuándo el foco sale de lo que tiene dentro, para dar el campo por visitado.
    <div className="flex flex-col gap-4" onBlur={handleBlur}>
      {data ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{data.systemTitle} · lista de la clínica</Badge>
        </div>
      ) : null}

      {suggestions.isPending ? (
        <div
          role="status"
          aria-busy
          className="flex flex-col gap-2"
          aria-label="Cargando los diagnósticos propuestos"
        >
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}

      {proposed.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            1 · Lo que propone la atención
          </span>
          <ul className="flex flex-col gap-2">
            {proposed.map((item) => (
              <li
                key={proposalKey(item)}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium">
                    {item.code} · {item.description}
                  </span>
                  <span className="text-xs text-muted-foreground">{proposalOrigin(item)}</span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={isChosen(item) ? "default" : "outline"}
                  aria-pressed={isChosen(item)}
                  disabled={disabled}
                  onClick={() =>
                    onChange(
                      { code: item.code, description: item.description, system: item.system },
                      proposedSite(item),
                    )
                  }
                >
                  {/* Aquí solo llena el formulario: «Usar» queda para lo que registra al tocarlo. */}
                  {isChosen(item) ? "Elegido" : "Elegir"}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {mostUsed.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {usedStep} · Los más usados en tu clínica
          </span>
          <div className="flex flex-wrap gap-1.5">
            {mostUsed.map((item) => (
              <Button
                key={item.code}
                type="button"
                size="sm"
                variant={isChosen(item) ? "default" : "outline"}
                aria-pressed={isChosen(item)}
                disabled={disabled}
                onClick={() =>
                  onChange({ code: item.code, description: item.description, system: item.system })
                }
              >
                {item.code} {item.description}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <Field>
        <FieldLabel htmlFor={searchId}>
          {searchStep > 1 ? `${searchStep} · Buscar en toda la lista` : "Buscar en toda la lista"}
        </FieldLabel>
        <DiagnosisSearch
          id={searchId}
          invalid={invalid}
          aria-describedby={describedBy}
          value={value}
          system={system}
          disabled={disabled}
          onChange={(code, description, nextSystem) =>
            onChange({ code, description, system: nextSystem })
          }
        />
      </Field>
    </div>
  )
}
