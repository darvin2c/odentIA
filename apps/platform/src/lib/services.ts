import { currencyFractionDigits } from "@odentia/clinical"
import { apiFetch } from "./api"
import { amountFromCents } from "./workspace"

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
  /** Cómo dice el precio el agente; caja y presupuesto usan siempre la tarifa. */
  priceDisclosure: PriceDisclosure
  /** La evaluación que ofrece el agente cuando el precio no es exacto. */
  evaluationServiceId: string | null
  /** Qué deja en la pieza al completarse (lo tratado queda dibujado); null = nada. */
  leavesFinding: LeavesFindingBody | null
  isActive: boolean
}

/** Lo que un servicio deja en la pieza: el hallazgo y, si corresponde, su variante. */
export interface LeavesFindingBody {
  condition: string
  variant?: string
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
  /** Proyección 1:1 de un código oficial de la biblioteca: el primario primero. */
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

/**
 * Importe sin símbolo de moneda, con el formato de la clínica: para precios
 * secundarios que acompañan a otro dato («a 79.00 en vez de 120.00»), donde
 * repetir el símbolo solo añade ruido. El importe principal usa `formatMoney`.
 */
export function formatAmount(cents: number, currency: string, locale: string): string {
  const digits = currencyFractionDigits(currency)
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountFromCents(String(cents), currency))
}

/**
 * Símbolo de una moneda tal como lo escribe el formato de la clínica: el
 * prefijo del campo de un importe. Nunca un símbolo fijo en el código.
 */
export function currencySymbol(currency: string, locale: string): string {
  try {
    const parts = new Intl.NumberFormat(locale, { style: "currency", currency }).formatToParts(0)
    return parts.find((part) => part.type === "currency")?.value ?? currency
  } catch {
    return currency
  }
}

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
  priceDisclosure?: PriceDisclosure | null
  evaluationServiceId?: string | null
  leavesFinding?: LeavesFindingBody | null
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
  priceDisclosure?: PriceDisclosure
  evaluationServiceId?: string | null
  leavesFinding?: LeavesFindingBody | null
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

export type BillingMode = "treatment" | "session"

/** Cómo dice el precio el agente (ADR 0021). */
export type PriceDisclosure = "exacto" | "desde" | "evaluacion"

/** Cada opción con lo que diría el agente, para que se entienda antes de elegirla. */
export const PRICE_DISCLOSURE_OPTIONS: ReadonlyArray<{ value: PriceDisclosure; label: string; says: string }> = [
  { value: "exacto", label: "Precio exacto", says: "Dice el precio de la tarifa tal cual." },
  { value: "desde", label: "Desde", says: "Lo dice como mínimo, con «desde», y aclara que el precio final se define en la evaluación." },
  { value: "evaluacion", label: "Solo con evaluación", says: "No dice ningún número y ofrece la evaluación." },
]

/** Etiqueta junto al precio en la lista: solo cuando no es exacto. */
export const PRICE_DISCLOSURE_TAG: Record<PriceDisclosure, string | null> = {
  exacto: null,
  desde: "Desde",
  evaluacion: "Con evaluación",
}

/** Cómo se cobra un servicio, con las palabras de la pantalla. */
export const BILLING_MODE_LABELS: Record<BillingMode, string> = {
  treatment: "Por tratamiento",
  session: "Por sesión",
}

/** «Dónde se hace» un servicio propio: así la atención sabe qué pedir al registrarlo. */
export const SERVICE_PLACE_OPTIONS: ReadonlyArray<{
  value: NonNullable<ServiceCatalogItem["scope"]>
  label: string
}> = [
  { value: "general", label: "Toda la boca" },
  { value: "tooth", label: "Una pieza" },
  { value: "surfaces", label: "Caras de una pieza" },
  { value: "quadrant", label: "Un cuadrante" },
  { value: "arch", label: "Una arcada" },
]

/** Servicio elegido de la biblioteca, con el nombre que usará la clínica. */
export interface TemplateServiceBody {
  kind: "template"
  templateId: string
  /** Nombre comercial; sin él queda la denominación de la biblioteca. */
  name?: string | null
  /** Tarifa explícita en unidad menor; 0 = incluido sin costo. */
  priceCents: number
  billingMode?: BillingMode | null
  durationMin?: number | null
}

/** Servicio propio de la clínica, sin código oficial. */
export interface CustomServiceBody {
  kind: "custom"
  name: string
  specialty: string
  scope: string
  priceCents: number
  billingMode?: BillingMode | null
  durationMin?: number | null
  leavesFinding?: LeavesFindingBody | null
}

export type QuickAddServiceBody = TemplateServiceBody | CustomServiceBody

/**
 * «Agregar servicios»: lo elegido de la biblioteca y los servicios propios se
 * guardan juntos, con su precio, y quedan activos. Todo o nada.
 */
export function quickAddServicesApi(
  items: QuickAddServiceBody[],
  /** «¿Cómo dice el agente estos precios?»: una sola respuesta para todo lo que se agrega. */
  priceDisclosure: PriceDisclosure,
): Promise<{ data: { created: ServiceCatalogItem[]; existing: ServiceCatalogItem[] } }> {
  return apiFetch<{ data: { created: ServiceCatalogItem[]; existing: ServiceCatalogItem[] } }>(
    "/api/services/batch",
    {
      method: "POST",
      body: JSON.stringify({ items, priceDisclosure }),
    },
  )
}

/** Cuántos servicios se cambian de una vez (lo mismo que acepta el servidor). */
export const PRICE_DISCLOSURE_BATCH = 100

/** «Cómo dice el precio» de varios servicios a la vez. */
export function setServicesPriceDisclosureApi(
  serviceIds: string[],
  priceDisclosure: PriceDisclosure,
): Promise<{ data: { updated: number } }> {
  return apiFetch<{ data: { updated: number } }>("/api/services/price-disclosure", {
    method: "POST",
    body: JSON.stringify({ serviceIds, priceDisclosure }),
  })
}

/** Concepto de «Más usados» con las plantillas de la biblioteca que lo resuelven. */
export interface MostUsedConcept {
  key: string
  label: string
  templates: TreatmentTemplateItem[]
}

/**
 * Punto de partida de una clínica nueva: conceptos generales (consulta,
 * limpieza, resina…) resueltos contra la biblioteca disponible, sin lo que la
 * clínica ya tiene. Vacío si no hay biblioteca.
 */
export function fetchMostUsedServices(): Promise<{ data: MostUsedConcept[] }> {
  return apiFetch<{ data: MostUsedConcept[] }>("/api/services/most-used")
}
