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
  /** null = Sin tarifa (no seleccionable para nueva indicación). */
  priceCents: number | null
  currency: string
  durationMin: number | null
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

/** Máximo entero admitido por la columna PG integer. */
export const MAX_PRICE_CENTS = 2147483647

/** Formatea centavos a moneda legible (es-PE). Solo lectura: nunca edita tarifas. */
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("es-PE", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

/**
 * Convierte una tarifa escrita ("120", "120.50", "120,50") a centavos enteros.
 * Estricto: el vacío NO está permitido al guardar (lanza "Ingresa la tarifa").
 */
export function parsePriceToCents(raw: string): number {
  const value = raw.trim().replace(",", ".")
  if (!value) throw new Error("Ingresa la tarifa")
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new Error("Tarifa inválida: usa números con hasta 2 decimales")
  }
  const cents = Math.round(Number(value) * 100)
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error("Tarifa inválida: debe ser mayor o igual a 0")
  }
  if (cents > MAX_PRICE_CENTS) throw new Error("Tarifa demasiado alta")
  return cents
}

/** Presenta centavos como texto editable ("120.00"). */
export function formatPriceInput(cents: number): string {
  return (cents / 100).toFixed(2)
}

export interface ServicesQuery {
  q?: string
  specialty?: string
  state?: "active" | "inactive" | "unpriced" | "legacy"
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
  priceCents?: number | null
  currency?: string | null
  durationMin?: number | null
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
  priceCents?: number | null
  currency?: string | null
  durationMin?: number | null
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

/** Incorpora prestaciones de la biblioteca al tarifario (tarifa nula). */
export function incorporateTemplatesApi(
  templateIds: string[],
): Promise<{ data: { created: ServiceCatalogItem[]; existing: ServiceCatalogItem[] } }> {
  return apiFetch<{ data: { created: ServiceCatalogItem[]; existing: ServiceCatalogItem[] } }>(
    "/api/services/from-templates",
    {
      method: "POST",
      body: JSON.stringify({ templateIds }),
    },
  )
}
