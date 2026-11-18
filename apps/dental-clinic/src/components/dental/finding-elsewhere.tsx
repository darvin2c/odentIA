import { apiFetch } from "@odentia/clinic-app/lib/api"
import { INDICATED_QUERY_KEYS } from "@odentia/clinic-app/lib/budgets"
import { addDiagnosisApi } from "@odentia/clinic-app/lib/encounters"
import { fetchServices, type ServiceCatalogItem } from "@odentia/clinic-app/lib/services"
import { diagnosisCodeLabel } from "@odentia/clinical"
import { anatomyFitRank } from "@odentia/dental"
import { Button } from "@odentia/ui"
import { common, EmptyState, submitErrorMessage } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { SearchX } from "lucide-react"
import { useEffect, useState } from "react"
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
/** Lo que se planifica desde la pieza es de la pieza o de sus caras. */
const TOOTH_SCOPES: readonly string[] = ["tooth", "surfaces"]

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
}: {
  patientId: string
  encounterId: string
  toothNumber: number
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
  const servicesQuery = useQuery({
    queryKey: ["services", "picker", debounced, "todas"],
    queryFn: () => fetchServices({ q: debounced || undefined, state: "active", limit: 30 }),
    enabled: debounced.length > 0,
    staleTime: 30_000,
  })
  const [saving, setSaving] = useState<string | null>(null)
  const [done, setDone] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const diagnoses = withDiagnoses
    ? (diagnosesQuery.data?.data ?? []).filter((row) => !row.isCategory).slice(0, MAX_DIAGNOSES)
    : []
  // El que encaja en la pieza primero (la endodoncia de molar en la 36), como en «Tratamiento».
  const [service] = [...(servicesQuery.data?.data ?? [])]
    .filter((row) => TOOTH_SCOPES.includes(row.scope ?? ""))
    .sort(
      (a, b) =>
        anatomyFitRank(a.toothAnatomy ? toothAnatomyOf(a.toothAnatomy) : null, toothNumber) -
        anatomyFitRank(b.toothAnatomy ? toothAnatomyOf(b.toothAnatomy) : null, toothNumber),
    )
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
      `${row.description} quedó en la ${toothNumber} como presuntivo: lo cambias en «Diagnósticos».`,
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

  const nothing = diagnoses.length === 0 && !service
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
    <div className="flex flex-col gap-3 rounded-lg border p-3" aria-live="polite">
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
              <p role="status" className="text-sm text-muted-foreground">
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
      {service ? (
        <div className={`flex flex-col gap-2 ${diagnoses.length > 0 ? "border-t pt-3" : ""}`}>
          <p className="text-sm">
            <span className="font-medium">{service.name}</span> es un tratamiento.
          </p>
          {done[`sv:${service.id}`] ? (
            <p role="status" className="text-sm text-muted-foreground">
              {done[`sv:${service.id}`]}
            </p>
          ) : (
            <Button
              type="button"
              className="h-auto min-h-11 max-w-full self-start whitespace-normal text-left"
              disabled={busy}
              onClick={() => void plan(service)}
            >
              {saving === `sv:${service.id}` ? "Agregando…" : `Agregar ${service.name} al plan`}
            </Button>
          )}
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
