/**
 * Para las pruebas de la copia de la historia: el paquete FHIR con cada referencia escrita como
 * `Tipo/id`. La copia las resuelve dentro del paquete (`urn:uuid:…`); aquí se vuelven a leer por
 * su recurso para que una prueba diga «el Encounter de esta atención» sin calcular su UUID.
 * Una referencia que no se resuelve dentro del paquete queda tal cual, y se nota.
 */
import { patientRecordFhirBundle } from "./patient-record.js"

export type FhirResource = Record<string, unknown> & { resourceType: string; id: string }
type Bundle = { entry: Array<{ fullUrl: string; resource: FhirResource }> }

function relative(value: unknown, back: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => relative(item, back))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
      key,
      key === "reference" && typeof inner === "string"
        ? (back.get(inner) ?? inner)
        : relative(inner, back),
    ]),
  )
}

/** Los recursos del paquete, con sus referencias como `Tipo/id`. */
export function relativeResources(bundle: Record<string, unknown>): FhirResource[] {
  const entries = (bundle as Bundle).entry
  const back = new Map(
    entries.map((entry) => [entry.fullUrl, `${entry.resource.resourceType}/${entry.resource.id}`]),
  )
  return entries.map((entry) => relative(entry.resource, back) as FhirResource)
}

/** Lo mismo, de una historia ya cargada. */
export function recordResources(
  record: Parameters<typeof patientRecordFhirBundle>[0],
): FhirResource[] {
  return relativeResources(patientRecordFhirBundle(record))
}
