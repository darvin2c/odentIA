import { Badge, Button, Skeleton } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { useId } from "react"
import { apiFetch } from "../../lib/api"
import { type DiagnosisOption, DiagnosisSearch } from "./diagnosis-search"

/** Lo que propone un hallazgo del odontograma de esta atención. */
export interface ProposedDiagnosis extends DiagnosisOption {
  finding: string
  toothNumber: number | null
  surfaces: string[]
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
 * el odontograma, los más usados en la clínica y el buscador de toda la lista
 * de la clínica. En la mayoría de las atenciones basta el paso 1 o el 2. Lo
 * que se propone lo decide el servidor (`/api/diagnosis-codes/suggestions`).
 * Elegir una propuesta devuelve también su pieza y sus caras.
 */
export function DiagnosisPicker({
  patientId,
  encounterId,
  finding = null,
  value,
  system = null,
  onChange,
  disabled = false,
}: {
  patientId: string
  encounterId: string | null
  finding?: PickerFinding | null
  value: string
  system?: string | null
  onChange: (
    choice: { code: string; description: string; system: string | null },
    site?: { toothNumber: number | null; surfaces: string[] },
  ) => void
  disabled?: boolean
}) {
  const headingId = useId()
  const params = new URLSearchParams()
  params.set("patientId", patientId)
  if (encounterId) params.set("encounterId", encounterId)
  if (finding?.condition) {
    params.set("condition", finding.condition)
    if (finding.variant) params.set("variant", finding.variant)
    if (finding.toothNumber != null) params.set("toothNumber", String(finding.toothNumber))
  }
  const suggestions = useQuery({
    queryKey: diagnosisSuggestionsKey(patientId, encounterId, finding),
    queryFn: () =>
      apiFetch<{ data: DiagnosisSuggestions }>(`/api/diagnosis-codes/suggestions?${params}`).then(
        (r) => r.data,
      ),
    staleTime: 30_000,
  })
  const data = suggestions.data
  const proposed = data?.proposed ?? []
  const mostUsed = data?.mostUsed ?? []
  // Los pasos se numeran solo con los que hay: sin propuestas, el buscador no es «3».
  const usedStep = proposed.length > 0 ? 2 : 1
  const searchStep = usedStep + (mostUsed.length > 0 ? 1 : 0)
  const isChosen = (option: DiagnosisOption) =>
    option.code === value && (system ?? data?.system) === option.system

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-medium">
          Diagnóstico
        </h3>
        {data ? <Badge variant="outline">{data.systemTitle} · lista de la clínica</Badge> : null}
      </div>

      {suggestions.isPending ? (
        <div
          role="status"
          aria-busy
          className="flex flex-col gap-2"
          aria-label="Cargando lo que propone el odontograma"
        >
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}

      {proposed.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            1 · Desde el odontograma
          </span>
          <ul className="flex flex-col gap-2">
            {proposed.map((item) => (
              <li
                key={`${item.code}-${item.toothNumber ?? ""}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium">
                    {item.code} · {item.description}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Propuesto por el hallazgo «{item.finding}»
                    {item.toothNumber != null ? ` en la pieza ${item.toothNumber}` : ""}
                  </span>
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
                      { toothNumber: item.toothNumber, surfaces: item.surfaces },
                    )
                  }
                >
                  {isChosen(item) ? "Elegido" : "Usar"}
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

      <DiagnosisSearch
        label={
          searchStep > 1 ? `${searchStep} · Buscar en toda la lista` : "Buscar en toda la lista"
        }
        value={value}
        system={system}
        disabled={disabled}
        onChange={(code, description, nextSystem) =>
          onChange({ code, description, system: nextSystem })
        }
      />
    </section>
  )
}
