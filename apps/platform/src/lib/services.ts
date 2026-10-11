import { apiFetch } from "./api"

/** Oferta del tarifario de la clínica (contrato GET /api/services). */
export interface ServiceCatalogItem {
  id: string
  templateId: string | null
  source: "template" | "custom" | "legacy"
  code: string | null
  name: string
  specialty: string | null
  scope: "general" | "tooth" | "surfaces" | "quadrant" | "arch" | null
  /** Toda prestación tiene tarifa explícita; 0 = incluida sin costo. */
  priceCents: number
  currency: string
  durationMin: number | null
  /** Cómo se cobra: 'treatment' una vez, 'session' en cada visita atendida. */
  billingMode: "treatment" | "session"
  isActive: boolean
}

/** Prestación de la biblioteca global (contrato GET /api/services/templates). */
export interface TreatmentTemplateItem {
  id: string
  key: string
  name: string
  specialty: string
  scope: "general" | "tooth" | "surfaces" | "quadrant" | "arch"
  surfaceCountMin: number | null
  surfaceCountMax: number | null
  /** Proyección 1:1 de un código oficial: exactamente un elemento (CPMS primero). */
  codings: Array<{ system: string; code: string; version: string; display: string }>
}

/** Edición oficial vigente de la biblioteca (null si no hay edición importada). */
export interface TreatmentTemplateCatalog {
  system: string
  version: string
  scope: string
  sourceUrl: string
  sourceSha256: string
  expectedCount: number
  availableCount: number
}

export const TREATMENT_SPECIALTIES = [
  "diagnostico",
  "prevencion",
  "restauradora",
  "endodoncia",
  "periodoncia",
  "cirugia",
  "protesis",
  "implantologia",
  "ortodoncia",
  "odontopediatria",
  "estetica",
  "disfuncion",
  "anestesia",
  "general",
] as const

export const TREATMENT_SPECIALTY_LABELS: Record<string, string> = {
  diagnostico: "Diagnóstico",
  prevencion: "Prevención",
  restauradora: "Restauradora",
  endodoncia: "Endodoncia",
  periodoncia: "Periodoncia",
  cirugia: "Cirugía",
  protesis: "Prótesis",
  implantologia: "Implantología",
  ortodoncia: "Ortodoncia",
  odontopediatria: "Odontopediatría",
  estetica: "Estética",
  disfuncion: "Disfunción",
  anestesia: "Anestesia y sedación",
  general: "Servicios odontológicos generales",
}

export const TREATMENT_SCOPE_LABELS: Record<string, string> = {
  general: "General",
  tooth: "Por pieza",
  surfaces: "Por superficies",
  quadrant: "Por cuadrante",
  arch: "Por arcada",
}

/** Opciones del filtro de especialidad de tarifario y biblioteca. */
export const SPECIALTY_FILTER_OPTIONS = [
  { value: "todas", label: "Todas" },
  ...TREATMENT_SPECIALTIES.map((specialty) => ({
    value: specialty,
    label: TREATMENT_SPECIALTY_LABELS[specialty] ?? specialty,
  })),
]

/** Máximo entero admitido por la columna PG integer. */
export const MAX_PRICE_CENTS = 2147483647

export interface ServicesQuery {
  q?: string
  specialty?: string
  state?: "active" | "inactive" | "legacy"
  cursor?: string
  limit?: number
}

function toSearch(
  params: ServicesQuery | { q?: string; specialty?: string; cursor?: string; limit?: number },
): string {
  const search = new URLSearchParams()
  if (params.q) search.set("q", params.q)
  if (params.specialty) search.set("specialty", params.specialty)
  if ("state" in params && params.state) search.set("state", params.state)
  if (params.cursor) search.set("cursor", params.cursor)
  if (params.limit) search.set("limit", String(params.limit))
  const suffix = search.toString()
  return suffix ? `?${suffix}` : ""
}

/** Lista ofertas del tarifario con paginación por cursor estable. */
export function fetchServices(
  query: ServicesQuery = {},
): Promise<{ data: ServiceCatalogItem[]; nextCursor: string | null }> {
  return apiFetch<{ data: ServiceCatalogItem[]; nextCursor: string | null }>(
    `/api/services${toSearch(query)}`,
  )
}

/** Lista la biblioteca global de prestaciones (sin precios). */
export function fetchTreatmentTemplates(
  query: { q?: string; specialty?: string; cursor?: string; limit?: number } = {},
): Promise<{
  data: TreatmentTemplateItem[]
  nextCursor: string | null
  total: number
  catalog: TreatmentTemplateCatalog | null
}> {
  return apiFetch<{
    data: TreatmentTemplateItem[]
    nextCursor: string | null
    total: number
    catalog: TreatmentTemplateCatalog | null
  }>(`/api/services/templates${toSearch(query)}`)
}

/**
 * Obtiene una plantilla por ID (solo lectura, incluye retiradas).
 * Los mapeos llegan con el primario primero: se usa `codings[0]`.
 */
export function fetchTreatmentTemplate(id: string): Promise<{ data: TreatmentTemplateItem }> {
  return apiFetch<{ data: TreatmentTemplateItem }>(
    `/api/services/templates/${encodeURIComponent(id)}`,
  )
}

export interface CreateServiceBody {
  templateId?: string | null
  name?: string | null
  specialty?: string | null
  scope?: string | null
  code?: string | null
  /** Obligatoria: 0 si la prestación va incluida sin costo. */
  priceCents: number
  currency?: string | null
  durationMin?: number | null
  billingMode?: "treatment" | "session" | null
  isActive?: boolean
}

export function createServiceApi(body: CreateServiceBody): Promise<{ data: ServiceCatalogItem }> {
  return apiFetch<{ data: ServiceCatalogItem }>("/api/services", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export interface UpdateServiceBody {
  templateId?: string | null
  name?: string
  specialty?: string
  scope?: string
  code?: string | null
  priceCents?: number
  currency?: string | null
  durationMin?: number | null
  billingMode?: "treatment" | "session"
  isActive?: boolean
}

export function updateServiceApi(
  id: string,
  patch: UpdateServiceBody,
): Promise<{ data: ServiceCatalogItem }> {
  return apiFetch<{ data: ServiceCatalogItem }>(`/api/services/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })
}

export interface FromTemplateItemBody {
  templateId: string
  /** Tarifa explícita en unidad menor; 0 = incluido sin costo. */
  priceCents: number
  billingMode?: "treatment" | "session" | null
  durationMin?: number | null
}

/**
 * Carga rápida del tarifario: las elegidas entran con su precio y activas en
 * el mismo acto. Sin alta diferida inactiva con tarifa 0.
 */
export function incorporateTemplatesApi(
  items: FromTemplateItemBody[],
): Promise<{ data: { created: ServiceCatalogItem[]; existing: ServiceCatalogItem[] } }> {
  return apiFetch<{ data: { created: ServiceCatalogItem[]; existing: ServiceCatalogItem[] } }>(
    "/api/services/from-templates",
    {
      method: "POST",
      body: JSON.stringify({ items }),
    },
  )
}

export interface MostUsedServiceItem {
  service: ServiceCatalogItem
  indications: number
}

/** Ofertas activas más indicadas, por concepto de uso real. */
export function fetchMostUsedServices(
  query: { specialty?: string; limit?: number } = {},
): Promise<{ data: MostUsedServiceItem[] }> {
  const params = new URLSearchParams()
  if (query.specialty) params.set("specialty", query.specialty)
  if (query.limit) params.set("limit", String(query.limit))
  const qs = params.toString()
  return apiFetch<{ data: MostUsedServiceItem[] }>(
    `/api/services/most-used${qs ? `?${qs}` : ""}`,
  )
}
