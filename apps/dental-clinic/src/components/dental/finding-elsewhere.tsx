import { apiFetch } from "@odentia/clinic-app/lib/api"
import { INDICATED_QUERY_KEYS } from "@odentia/clinic-app/lib/budgets"
import { addDiagnosisApi, fetchPatientDiagnoses } from "@odentia/clinic-app/lib/encounters"
import type { PlanItem } from "@odentia/clinic-app/lib/patients"
import { fetchServices, type ServiceCatalogItem } from "@odentia/clinic-app/lib/services"
import { diagnosisCodeLabel, findingDiagnosisCode, isDiagnosisSystem, pulpStateOfDiagnosis } from "@odentia/clinical"
import { anatomyFitRank } from "@odentia/dental"
import { Button } from "@odentia/ui"
import { common, EmptyState, normalizeSearchText, submitErrorMessage } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { SearchX } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { treatmentSearchTerm } from "./finding-search"
import { toothAnatomyOf } from "./tooth-fit-notice"

/** Un código de la lista de la clínica, como lo devuelve su buscador (`/api/diagnosis-codes`). */
interface DiagnosisOption {
  system: string
  code: string
  description: string
  isCategory?: boolean
}

/** Cuántos diagnósticos se ofrecen: el más probable primero, con su botón principal. */
const MAX_DIAGNOSES = 3
/** Cuántos tratamientos que encajan en la pieza se ofrecen, como los diagnósticos. */
const MAX_SERVICES = 3
/** Lo que se planifica desde la pieza es de la pieza o de sus caras. */
const TOOTH_SCOPES: readonly string[] = ["tooth", "surfaces"]
/** Lo indicado que sigue en el plan: lo hecho, cancelado o reemplazado ya no está por hacer. */
const PLANNED_STATUSES: readonly string[] = ["pendiente", "programado", "en_curso", "suspendido"]

/** `anatomyFitRank` de lo que no es para la pieza. */
const NO_FIT = 100

type Pulp = "vital" | "necrotic"
/** La endodoncia vital o no vital, por su familia de la biblioteca o, sin ella, por su nombre. */
function pulpVariant(service: ServiceCatalogItem): Pulp | null {
  const family = service.toothAnatomy?.family
  if (family === "endodoncia-vital") return "vital"
  if (family === "endodoncia-no-vital") return "necrotic"
  const name = service.name.toLowerCase()
  if (!/endodon|conducto/.test(name)) return null
  return /\bno vital\b/.test(name) ? "necrotic" : /\bvital\b/.test(name) ? "vital" : null
}

/**
 * Los tratamientos que se ofrecen para la pieza (reglas clínicas del 18 nov, H5): los que encajan en
 * ella, el más específico primero, como en «Tratamiento», hasta tres (QA de diseño del 18 nov, H3:
 * «sacar muela» en una 48 con raíz retenida ofrecía solo la exodoncia de impactada, no la simple). Si
 * es una endodoncia, la que dice el diagnóstico de la pieza: con pulpitis, la vital; con necrosis o
 * lo que la presupone, la no vital (`pulpStateOfDiagnosis`). Si no se sabe, las dos.
 */
/** Lo que tiene la pieza y nombra una exodoncia: la raíz retenida o la pieza impactada. */
type ExtractionFinding = "root_remnant" | "impaction"
const EXTRACTION_NAMES: Record<ExtractionFinding, RegExp> = {
  root_remnant: /\brestos? radicular/,
  impaction: /\bimpactad|\bretenid/,
}

/**
 * Lo que dice la pieza de su extracción, por sus hallazgos vigentes o sus diagnósticos (K08.3 o DA0A.3
 * la raíz retenida, K01.1 o DA07.8 la impactada, los que propone el odontograma); null si nada.
 */
export function toothExtractionFinding(
  findings: readonly string[],
  diagnoses: ReadonlyArray<{
    diagnosisCode: string
    diagnosisSystem?: string | null
    toothNumber: number | null
    status: string
    voidedAt: string | null
  }>,
  toothNumber: number,
): ExtractionFinding | null {
  const kinds = Object.keys(EXTRACTION_NAMES) as ExtractionFinding[]
  const byFinding = kinds.find((kind) => findings.includes(kind))
  if (byFinding) return byFinding
  const codes = diagnoses.filter((row) => row.toothNumber === toothNumber && row.status === "activo" && !row.voidedAt)
  return (
    kinds.find((kind) =>
      codes.some(
        (row) =>
          isDiagnosisSystem(row.diagnosisSystem) &&
          findingDiagnosisCode(row.diagnosisSystem, kind) === row.diagnosisCode,
      ),
    ) ?? null
  )
}

/**
 * Cuál va primero entre los que encajan (verificación del 18 nov, H4: «sacar muela» en la 48 resaltaba
 * la de impactada): el que nombra lo que tiene la pieza (la de restos radiculares con la raíz
 * retenida; la simple antes que la quirúrgica) y, si no, la exodoncia simple, la más común.
 */
function extractionPreference(service: ServiceCatalogItem, said: ExtractionFinding | null): number {
  const name = normalizeSearchText(service.name)
  if (said && EXTRACTION_NAMES[said].test(name)) return /\bquirurgic/.test(name) ? 1 : 0
  if (/^exodoncia simple\b/.test(name)) return 2
  return 3
}

export function offeredServices(
  services: readonly ServiceCatalogItem[],
  toothNumber: number,
  pulp: Pulp | null,
  said: ExtractionFinding | null = null,
): ServiceCatalogItem[] {
  const rank = (row: ServiceCatalogItem) =>
    anatomyFitRank(row.toothAnatomy ? toothAnatomyOf(row.toothAnatomy) : null, toothNumber)
  const fitting = services
    .filter((row) => TOOTH_SCOPES.includes(row.scope ?? ""))
    .sort((a, b) => rank(a) - rank(b))
  const [first] = fitting
  if (!first) return []
  if (!pulpVariant(first)) {
    const fit = fitting
      .filter((row) => !pulpVariant(row) && rank(row) < NO_FIT)
      .sort((a, b) => extractionPreference(a, said) - extractionPreference(b, said) || rank(a) - rank(b))
    return fit.length > 0 ? fit.slice(0, MAX_SERVICES) : [first]
  }
  const best = fitting.filter((row) => pulpVariant(row) && rank(row) === rank(first))
  const matching = pulp ? best.find((row) => pulpVariant(row) === pulp) : undefined
  if (matching) return [matching]
  const vital = best.find((row) => pulpVariant(row) === "vital")
  const necrotic = best.find((row) => pulpVariant(row) === "necrotic")
  return [vital, necrotic].filter((row): row is ServiceCatalogItem => !!row)
}

/** La pulpa que dicen los diagnósticos vigentes de la pieza; null si ninguno lo dice o dicen las dos. */
export function toothPulp(
  diagnoses: ReadonlyArray<{
    diagnosisCode: string
    toothNumber: number | null
    status: string
    voidedAt: string | null
  }>,
  toothNumber: number,
): Pulp | null {
  const states = new Set(
    diagnoses
      .filter((row) => row.toothNumber === toothNumber && row.status === "activo" && !row.voidedAt)
      .flatMap((row) => pulpStateOfDiagnosis(row.diagnosisCode) ?? []),
  )
  return states.size === 1 ? ([...states][0] ?? null) : null
}

/**
 * Lo que no es un hallazgo y se escribió en «¿Qué observas?» (reglas clínicas del 18 nov): un
 * diagnóstico («Pulpitis es un diagnóstico») con «Anotar Pulpitis en la 36», que lo deja como
 * presuntivo en esta atención con la pieza (`addEncounterDiagnosis`), o un tratamiento
 * («Endodoncia es un tratamiento») con «Agregar Endodoncia al plan», la misma operación que
 * «Añadir un tratamiento al plan». Mientras guarda, el botón se desactiva: el plan sí duplicaría.
 */
export function FindingElsewhere({
  patientId,
  encounterId,
  toothNumber,
  query,
  diagnoses: withDiagnoses,
  disabled = false,
  beforeWrite,
  onChanged,
  onPendingChange,
  toothFindings = [],
}: {
  patientId: string
  encounterId: string
  toothNumber: number
  /** Los hallazgos vigentes de la pieza («root_remnant»): deciden qué exodoncia va primero. */
  toothFindings?: readonly string[]
  /** Lo escrito en el buscador. */
  query: string
  /** Ningún hallazgo coincide: se buscan también diagnósticos, y sin nada se dice «Sin resultados». */
  diagnoses: boolean
  disabled?: boolean
  beforeWrite?: () => Promise<void>
  onChanged: () => void | Promise<void>
  onPendingChange?: (pending: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [debounced, setDebounced] = useState(query.trim())
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])
  // Las mismas claves que el buscador de diagnósticos y el de tratamientos: comparten lo ya pedido.
  const diagnosesQuery = useQuery({
    queryKey: ["diagnosis-codes", debounced],
    queryFn: () =>
      apiFetch<{ data: DiagnosisOption[] }>(
        `/api/diagnosis-codes?q=${encodeURIComponent(debounced)}`,
      ),
    enabled: withDiagnoses && debounced.length > 0,
    staleTime: 60_000,
  })
  // «sacar muela», «extraer»: se busca el servicio por su nombre, la exodoncia.
  const treatment = treatmentSearchTerm(debounced)
  const servicesQuery = useQuery({
    queryKey: ["services", "picker", treatment, "todas"],
    queryFn: () => fetchServices({ q: treatment || undefined, state: "active", limit: 30 }),
    enabled: treatment.length > 0,
    staleTime: 30_000,
  })
  // Lo que la pieza ya tiene en el plan, con las mismas claves que el plan: no se ofrece otra vez.
  const planQuery = useQuery({
    queryKey: ["plan-items", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
    enabled: debounced.length > 0,
  })
  // La pulpa de la pieza, por sus diagnósticos: decide la endodoncia vital o la no vital.
  const toothDiagnoses = useQuery({
    queryKey: ["patient-diagnoses", patientId],
    queryFn: () => fetchPatientDiagnoses(patientId),
    enabled: debounced.length > 0,
  })
  const [saving, setSaving] = useState<string | null>(null)
  const [done, setDone] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  // El botón se reemplaza por lo que quedó: el foco va a esa frase, no al inicio de la página (H5).
  const rootRef = useRef<HTMLDivElement>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  useEffect(() => {
    if (!focusKey) return
    rootRef.current?.querySelector<HTMLElement>(`[data-done="${focusKey}"]`)?.focus()
    setFocusKey(null)
  }, [focusKey])

  const diagnoses = withDiagnoses
    ? (diagnosesQuery.data?.data ?? []).filter((row) => !row.isCategory).slice(0, MAX_DIAGNOSES)
    : []
  // El que encaja en la pieza primero (la endodoncia de molar en la 36), como en «Tratamiento».
  const services = offeredServices(
    servicesQuery.data?.data ?? [],
    toothNumber,
    toothPulp(toothDiagnoses.data?.data ?? [], toothNumber),
    toothExtractionFinding(toothFindings, toothDiagnoses.data?.data ?? [], toothNumber),
  )
  const planned = (planQuery.data?.data ?? []).filter(
    (item) => item.toothNumber === toothNumber && PLANNED_STATUSES.includes(item.status),
  )
  // Lo que ya está indicado en la pieza no se ofrece otra vez (H4): el mismo servicio o, si es una
  // endodoncia, la otra variante (la pieza ya tiene su endodoncia).
  const inPlan = (row: ServiceCatalogItem) =>
    planned.find(
      (item) =>
        item.serviceId === row.id ||
        (pulpVariant(row) !== null &&
          (servicesQuery.data?.data ?? []).some(
            (other) => other.id === item.serviceId && pulpVariant(other) !== null,
          )),
    ) ?? null
  const searching =
    query.trim() !== debounced || diagnosesQuery.isFetching || servicesQuery.isFetching
  const busy = disabled || saving !== null

  const run = async (
    key: string,
    said: string,
    write: () => Promise<unknown>,
    keys: readonly string[],
  ) => {
    if (busy) return
    setSaving(key)
    setError(null)
    onPendingChange?.(true)
    try {
      await beforeWrite?.()
      await write()
      await Promise.all(
        keys.map((name) => queryClient.invalidateQueries({ queryKey: [name, patientId] })),
      )
      await onChanged()
      setDone((before) => ({ ...before, [key]: said }))
      setFocusKey(key)
    } catch (err) {
      setError(submitErrorMessage(err))
    } finally {
      setSaving(null)
      onPendingChange?.(false)
    }
  }
  const annotate = (row: DiagnosisOption) =>
    run(
      `dx:${row.code}`,
      `${row.description} quedó en la ${toothNumber} como presuntivo: lo cambias en «Diagnóstico».`,
      () =>
        addDiagnosisApi(patientId, encounterId, {
          diagnosisCode: row.code,
          diagnosisSystem: row.system,
          diagnosisType: "provisional",
          toothNumber,
        }),
      [
        "encounter",
        "encounter-closing",
        "diagnosis-suggestions",
        "patient-diagnoses",
        "timeline",
        "tooth-history",
      ],
    )
  const plan = (row: ServiceCatalogItem) =>
    run(
      `sv:${row.id}`,
      `${row.name} quedó en el plan, en la ${toothNumber}.`,
      () =>
        apiFetch(`/api/patients/${patientId}/plan/items`, {
          method: "POST",
          body: JSON.stringify({ serviceId: row.id, sourceEncounterId: encounterId, toothNumber }),
        }),
      [...INDICATED_QUERY_KEYS, "encounter", "encounter-closing", "tooth-history"],
    )

  // Con la endodoncia ya indicada, se dice una vez, sin ofrecer la otra variante.
  const indicated = services.find((row) => inPlan(row))
  const shown = indicated && services.length > 1 ? [indicated] : services
  const nothing = diagnoses.length === 0 && shown.length === 0
  if (nothing && searching) {
    return withDiagnoses ? (
      <p role="status" className="text-sm text-muted-foreground">
        Buscando en diagnósticos y tratamientos…
      </p>
    ) : null
  }
  if (nothing) {
    return withDiagnoses ? (
      <EmptyState
        icon={SearchX}
        title={common.filters.noResults}
        description="Ningún hallazgo, diagnóstico ni tratamiento coincide con la búsqueda. Prueba otro nombre."
        className="p-6"
      />
    ) : null
  }
  return (
    <div ref={rootRef} className="flex flex-col gap-3 rounded-lg border p-3" aria-live="polite">
      {diagnoses.map((row, index) => {
        const key = `dx:${row.code}`
        return (
          <div key={key} className="flex flex-col gap-2">
            <p className="text-sm">
              <span className="font-medium">{row.description}</span> es un diagnóstico: no se dibuja
              en el diente.{" "}
              <span className="text-muted-foreground">
                {diagnosisCodeLabel(row.system, row.code)}
              </span>
            </p>
            {done[key] ? (
              <p
                role="status"
                tabIndex={-1}
                data-done={key}
                className="text-sm text-muted-foreground outline-none"
              >
                {done[key]}
              </p>
            ) : (
              <Button
                type="button"
                className="h-auto min-h-11 max-w-full self-start whitespace-normal text-left"
                variant={index === 0 ? "default" : "outline"}
                disabled={busy}
                onClick={() => void annotate(row)}
              >
                {saving === key ? "Anotando…" : `Anotar ${row.description} en la ${toothNumber}`}
              </Button>
            )}
          </div>
        )
      })}
      {diagnoses.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Para lo que ves en la pieza, busca por ejemplo «caries».
        </p>
      ) : null}
      {shown.length > 0 ? (
        <div className={`flex flex-col gap-3 ${diagnoses.length > 0 ? "border-t pt-3" : ""}`}>
          {shown.length > 1 ? (
            <p className="text-sm">
              {shown.every((row) => pulpVariant(row))
                ? `Son tratamientos. Elige según la pulpa de la ${toothNumber}: la vital con pulpitis, la no vital con necrosis.`
                : `Son tratamientos que encajan en la ${toothNumber}. Elige el que harás.`}
            </p>
          ) : null}
          {shown.map((service, index) => {
            const key = `sv:${service.id}`
            const already = inPlan(service)
            return (
              <div key={key} className="flex flex-col gap-2">
                {shown.length === 1 ? (
                  <p className="text-sm">
                    <span className="font-medium">{service.name}</span> es un tratamiento.
                  </p>
                ) : null}
                {done[key] ? (
                  <p
                    role="status"
                    tabIndex={-1}
                    data-done={key}
                    className="text-sm text-muted-foreground outline-none"
                  >
                    {done[key]}
                  </p>
                ) : already ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    {already.title} ya está en el plan de la {toothNumber}.
                  </p>
                ) : (
                  <Button
                    type="button"
                    className="h-auto min-h-11 max-w-full self-start whitespace-normal text-left"
                    variant={index === 0 ? "default" : "outline"}
                    disabled={busy}
                    onClick={() => void plan(service)}
                  >
                    {saving === key ? "Agregando…" : `Agregar ${service.name} al plan`}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
