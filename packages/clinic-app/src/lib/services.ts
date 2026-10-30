import { currencyFractionDigits, type PatientGuide } from "@odentia/clinical"
import { apiFetch } from "./api"
import { amountFromCents } from "./workspace"

/** Oferta del tarifario de la clínica (contrato GET /api/services). */
export interface ServiceCatalogItem {
  id: string
  templateId: string | null
  source: "template" | "custom"
  code: string | null
  name: string
  /** La especialidad de la clínica (una sola, ADR 0039). */
  specialtyId: string | null
  /** Su nombre en la clínica; llega en la lista y al pedir uno por id. */
  specialtyName?: string | null
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
  /** Código propio en la lista del país (ADR 0069); uno de la biblioteca usa el de su tratamiento. */
  procedureSystem: string | null
  procedureCode: string | null
  /** Lo que se le explica al paciente; solo lo guardado llega a un presupuesto. */
  patientGuide?: PatientGuide | null
  patientGuideReviewedAt?: string | null
  patientGuideReviewedBy?: string | null
  isActive: boolean
  /**
   * Sus materiales («3 · S/ 2.18» o «Sin materiales», ADR 0067). Solo llega en
   * la lista y solo a quien ve Inventario; el costo, solo a quien ve precios.
   */
  materials?: ServiceMaterialsSummary
}

/** Lo que la lista dice de los materiales de un servicio. */
export interface ServiceMaterialsSummary {
  count: number
  /** Lo que cuestan cada vez con los últimos precios de compra; null sin precios o sin compras con precio. */
  cost: { cents: number; currency: string; unpriced: number } | null
}

/** Un código de la lista oficial del país, con su texto oficial. */
export interface OfficialCoding {
  system: string
  code: string
  version: string
  display: string
}

/**
 * La lista de servicios del país de la clínica (ADR 0069): «CPMS», obligatoria
 * en el Perú; null donde el país no tiene una cargada.
 */
export interface ServiceCodeList {
  system: string
  required: boolean
}

/** Lo que un servicio deja en la pieza: el hallazgo y, si corresponde, su variante. */
export interface LeavesFindingBody {
  condition: string
  variant?: string
}

/** Un tratamiento de la biblioteca de odentIA (contrato GET /api/services/templates). */
export interface TreatmentTemplateItem {
  id: string
  key: string
  name: string
  /** Tipo de tratamiento: agrupa la biblioteca (uso interno). */
  kind: string
  scope: "general" | "tooth" | "surfaces" | "quadrant" | "arch"
  surfaceCountMin: number | null
  surfaceCountMax: number | null
  leavesFinding: LeavesFindingBody | null
  isCommon: boolean
  /** Su código en la lista del país: uno, o ninguno donde no hay lista. */
  codings: OfficialCoding[]
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
  /** Especialidad de la clínica (id). */
  specialtyId?: string
  state?: "active" | "inactive"
  /** Solo estos servicios, en cualquier estado: para nombrar lo ya elegido. */
  ids?: string[]
  cursor?: string
  limit?: number
}

function toSearch(
  params: ServicesQuery | { q?: string; kind?: string; cursor?: string; limit?: number },
): string {
  const search = new URLSearchParams()
  if (params.q) search.set("q", params.q)
  if ("kind" in params && params.kind) search.set("kind", params.kind)
  if ("specialtyId" in params && params.specialtyId) search.set("specialtyId", params.specialtyId)
  if ("ids" in params && params.ids?.length) search.set("ids", params.ids.join(","))
  if ("state" in params && params.state) search.set("state", params.state)
  if (params.cursor) search.set("cursor", params.cursor)
  if (params.limit) search.set("limit", String(params.limit))
  const suffix = search.toString()
  return suffix ? `?${suffix}` : ""
}

/** Una página del tarifario: lo que coincide, el cursor de la siguiente y cuántos son en total. */
export interface ServicesPage {
  data: ServiceCatalogItem[]
  nextCursor: string | null
  total: number
}

/** Lista ofertas del tarifario con paginación por cursor estable y el total de lo que coincide. */
export function fetchServices(query: ServicesQuery = {}): Promise<ServicesPage> {
  return apiFetch<ServicesPage>(`/api/services${toSearch(query)}`)
}

/**
 * Un servicio por id, en cualquier estado: el que llega elegido aunque no esté
 * en la primera página. `officialCoding` es su código vigente en la lista del
 * país (null sin lista, sin código o con uno retirado).
 */
export function fetchService(
  id: string,
): Promise<{ data: ServiceCatalogItem & { officialCoding: OfficialCoding | null } }> {
  return apiFetch<{ data: ServiceCatalogItem & { officialCoding: OfficialCoding | null } }>(
    `/api/services/${encodeURIComponent(id)}`,
  )
}

/** Una página de la biblioteca, con la lista de códigos del país. */
export interface TreatmentTemplatesPage {
  data: TreatmentTemplateItem[]
  nextCursor: string | null
  total: number
  codeList: ServiceCodeList | null
}

/** La biblioteca de odentIA como la ve la clínica: con el código de su país, sin precios. */
export function fetchTreatmentTemplates(
  query: { q?: string; kind?: string; cursor?: string; limit?: number } = {},
): Promise<TreatmentTemplatesPage> {
  return apiFetch<TreatmentTemplatesPage>(`/api/services/templates${toSearch(query)}`)
}

/**
 * El buscador del código oficial de un servicio propio, por nombre o por
 * código; sin lista en el país, vacío con `codeList: null`.
 */
export function fetchOfficialCodes(
  query: { q?: string; limit?: number } = {},
): Promise<{ data: OfficialCoding[]; codeList: ServiceCodeList | null }> {
  return apiFetch<{ data: OfficialCoding[]; codeList: ServiceCodeList | null }>(
    `/api/services/official-codes${toSearch(query)}`,
  )
}

/** Un tratamiento de la biblioteca por id (solo lectura, incluye retirados). */
export function fetchTreatmentTemplate(id: string): Promise<{ data: TreatmentTemplateItem }> {
  return apiFetch<{ data: TreatmentTemplateItem }>(
    `/api/services/templates/${encodeURIComponent(id)}`,
  )
}

/** El texto sugerido por la biblioteca: un punto de partida, nunca sale a un paciente. */
export function fetchTemplatePatientGuide(templateId: string): Promise<{ data: { suggestion: PatientGuide | null } }> {
  return apiFetch<{ data: { suggestion: PatientGuide | null } }>(
    `/api/services/templates/${encodeURIComponent(templateId)}/patient-guide`,
  )
}

export interface CreateServiceBody {
  templateId?: string | null
  name?: string | null
  specialtyId?: string | null
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
  /** Código del servicio propio en la lista del país. */
  officialCode?: string | null
  isActive?: boolean
}

export function createServiceApi(body: CreateServiceBody): Promise<{ data: ServiceCatalogItem }> {
  return apiFetch<{ data: ServiceCatalogItem }>("/api/services", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export interface UpdateServiceBody {
  /** Lo que se le explica al paciente; null la quita. */
  patientGuide?: PatientGuide | null
  templateId?: string | null
  name?: string
  specialtyId?: string
  scope?: string
  code?: string | null
  priceCents?: number
  currency?: string | null
  durationMin?: number | null
  billingMode?: "treatment" | "session"
  priceDisclosure?: PriceDisclosure
  evaluationServiceId?: string | null
  leavesFinding?: LeavesFindingBody | null
  officialCode?: string | null
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

/** Servicio propio de la clínica, con el código que elige en la lista de su país. */
export interface CustomServiceBody {
  kind: "custom"
  name: string
  /** Especialidad de la clínica. */
  specialtyId: string
  scope: string
  priceCents: number
  billingMode?: BillingMode | null
  durationMin?: number | null
  leavesFinding?: LeavesFindingBody | null
  officialCode?: string | null
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

/* ---------------- Materiales de un servicio (ADR 0067) ---------------- */

/** Un material de un servicio: cuánto se usa de un producto cada vez que se hace. */
export interface ServiceMaterialLine {
  productId: string
  name: string
  /** Unidad de uso, en singular («guante»): la cantidad se escribe en ella. */
  unit: string
  quantity: number
  /** «2 guantes». */
  quantityText: string
  /** Falso si el producto se desactivó o ya no se usa en las atenciones: queda, pero no se descuenta. */
  discounted: boolean
  /** Solo para quien ve precios: lo que cuesta cada vez; null si nunca se compró con precio. */
  costCents: number | null
}

export interface ServiceMaterials {
  serviceId: string
  serviceName: string
  items: ServiceMaterialLine[]
  /** Solo para quien ve precios; null sin precios o si ningún material tiene una compra con precio. */
  cost: {
    cents: number
    currency: string
    /** Materiales sin una compra con precio: no entran en la suma. */
    unpriced: number
    /** Qué parte del precio del servicio son (0.018 = 1,8 %); null sin precio o con otra moneda. */
    shareOfPrice: number | null
  } | null
}

/** Cuántos materiales admite un servicio y lo más que se usa de uno cada vez (los mismos topes del servidor). */
export const SERVICE_MATERIALS_MAX = 50
export const MATERIAL_QUANTITY_MAX = 9999

export function fetchServiceMaterials(serviceId: string): Promise<{ data: ServiceMaterials }> {
  return apiFetch<{ data: ServiceMaterials }>(`/api/services/${encodeURIComponent(serviceId)}/materials`)
}

/** Reemplaza la lista entera de materiales del servicio (es de quien lleva el inventario). */
export function saveServiceMaterialsApi(
  serviceId: string,
  items: Array<{ productId: string; quantity: number }>,
): Promise<{ data: ServiceMaterials }> {
  return apiFetch<{ data: ServiceMaterials }>(`/api/services/${encodeURIComponent(serviceId)}/materials`, {
    method: "PUT",
    body: JSON.stringify({ items }),
  })
}

/** «Empieza por estos 5»: los servicios más hechos que aún no tienen materiales. */
export interface ServicesWithoutMaterials {
  days: number
  services: Array<{ serviceId: string; name: string; times: number }>
  totalEncounters: number
  coveredEncounters: number
  /** coveredEncounters ÷ totalEncounters (0.72 = «Son el 72 % de tus atenciones»); null sin atenciones. */
  share: number | null
}

export function fetchServicesWithoutMaterials(): Promise<{ data: ServicesWithoutMaterials }> {
  return apiFetch<{ data: ServicesWithoutMaterials }>("/api/services/without-materials")
}

/** Producto que se puede poner como material: activo y que se usa en las atenciones. */
export interface MaterialProductOption {
  productId: string
  name: string
  /** Unidad de uso, en singular. */
  unit: string
}

export function fetchMaterialProducts(q: string, limit = 20): Promise<{ data: MaterialProductOption[] }> {
  const search = new URLSearchParams({ limit: String(limit) })
  if (q.trim()) search.set("q", q.trim())
  return apiFetch<{ data: MaterialProductOption[] }>(`/api/services/material-products?${search}`)
}

/** Un tipo de tratamiento de «Más usados» con sus tratamientos de la biblioteca. */
export interface MostUsedConcept {
  key: string
  label: string
  templates: TreatmentTemplateItem[]
}

/**
 * Punto de partida de una clínica nueva: los tratamientos que odentIA marcó
 * como más usados, por tipo y sin lo que la clínica ya tiene.
 */
export function fetchMostUsedServices(): Promise<{ data: MostUsedConcept[] }> {
  return apiFetch<{ data: MostUsedConcept[] }>("/api/services/most-used")
}
