import {
  type ClinicalCountryProfile,
  type ClinicalProduct,
  clinicalProfileFor,
  DIAGNOSIS_SYSTEM_INFO,
  type DiagnosisSystemInfo,
  isDiagnosisSystem,
  type OrgTaxes,
  resolveOrgTaxes,
  type TaxCategory,
  type TaxRate,
} from "@odentia/clinical"
import { useQuery } from "@tanstack/react-query"
import { productUi } from "../product/product-ui"
import { apiFetch } from "./api"

/**
 * Perfil de la organización (`org_profile`): lo que define el país, la moneda y
 * la zona horaria con la que se interpretan agenda, historial y documentos.
 *
 * El país y la zona horaria no viven en la organización de Better Auth, así que
 * las pantallas que muestran un teléfono o una zona horaria leen de aquí. Van
 * cacheados: son datos de configuración que cambian de tarde en tarde.
 */
export interface OrgProfile {
  organizationId: string
  legalName: string
  /** El nombre que ven los pacientes (decisión 19): obligatorio. */
  tradeName: string
  fiscalDocType: string | null
  fiscalDocNumber: string | null
  fiscalAddress: string | null
  countryCode: string
  currency: string
  timezone: string
  locale: string
  /** Ancho del ticket térmico: 58 o 80 mm. */
  receiptWidth: string
  /** Tamaño de hoja para el presupuesto: A4 o Letter. */
  sheetSize: string
  /** Frase al pie del ticket (recibo interno por defecto). */
  ticketFooter: string
  /** Días que vale un presupuesto desde que se arma. */
  budgetValidDays?: number
  /** «Cómo se paga» del presupuesto; vacío, esa sección no sale. */
  budgetPaymentTerms?: string | null
  /** «Si el importe cambia» del presupuesto; vacío, esa sección no sale. */
  budgetChangeTerms?: string | null
  /** Lista de diagnósticos de la clínica; null: la que recomienda su país. */
  diagnosisSystem: string | null
  /** Logo público de la clínica (se sube en «Datos de la clínica»); null si no tiene. */
  logo?: string | null
  /** El producto de la clínica (ADR 0079): cada app abre solo las suyas. */
  product?: ClinicalProduct
  /** Teléfono para urgencias (E.164); null si no lo registró. */
  emergencyPhone?: string | null
  /** El nombre del agente de recepción en esta clínica (Sofi si no eligió otro). */
  receptionName?: string
  /**
   * Impuestos de lo cobrado (ADR 0083): solo lo que la clínica cambió; nulo es
   * «lo del país». Lo que vale lo dice `orgTaxesOf`.
   */
  taxLegalForm?: string | null
  servicesTaxCategory?: string | null
  servicesTaxBps?: number | null
  productsTaxCategory?: string | null
  productsTaxBps?: number | null
}

/** Las dos cifras de impuesto que valen hoy para la clínica (o null si su país no tiene impuesto que separar). */
export function orgTaxesOf(profile: OrgProfile | null | undefined): OrgTaxes | null {
  if (!profile) return null
  const rate = (
    category: string | null | undefined,
    bps: number | null | undefined,
  ): TaxRate | null =>
    category && bps != null ? { category: category as TaxCategory, rateBps: bps } : null
  return resolveOrgTaxes(
    profile.countryCode,
    {
      legalForm: profile.taxLegalForm ?? null,
      servicios: rate(profile.servicesTaxCategory, profile.servicesTaxBps),
      productos: rate(profile.productsTaxCategory, profile.productsTaxBps),
    },
    profile.locale,
  )
}

/** Lo que se guarda de los impuestos: null en una cifra es volver a lo del país. */
export interface OrgTaxesInput {
  legalForm: string | null
  servicios: TaxRate | null
  productos: TaxRate | null
}

/**
 * Lo que guarda «Datos de la clínica». `null` vacía un dato opcional; lo que no
 * viaja (la impresión) queda como estaba.
 */
export interface OrgProfileInput {
  legalName: string
  tradeName: string
  fiscalDocType: string | null
  fiscalDocNumber: string | null
  fiscalAddress: string | null
  emergencyPhone: string | null
  countryCode: string
  currency: string
  timezone: string
  locale: string
  /** Solo si la tarjeta «Impuestos» se tocó; al cambiar de país el servidor vuelve a lo del nuevo. */
  taxes?: OrgTaxesInput
}

export async function fetchOrgProfile(): Promise<OrgProfile | null> {
  const { data } = await apiFetch<{ data: OrgProfile | null }>("/api/org-profile")
  return data
}

export async function saveOrgProfile(input: OrgProfileInput): Promise<OrgProfile> {
  const { data } = await apiFetch<{ data: OrgProfile }>("/api/org-profile", {
    method: "PUT",
    body: JSON.stringify(input),
  })
  return data
}

/** Lo que se imprime y las condiciones del presupuesto; se edita en «Medios de pago y ticket». */
export interface OrgPrintingInput {
  receiptWidth: "58" | "80"
  sheetSize: "A4" | "Letter"
  ticketFooter: string
  budgetValidDays?: number
  budgetPaymentTerms?: string | null
  budgetChangeTerms?: string | null
}

export async function saveOrgPrinting(input: OrgPrintingInput): Promise<OrgProfile> {
  const { data } = await apiFetch<{ data: OrgProfile }>("/api/org-profile/printing", {
    method: "PUT",
    body: JSON.stringify(input),
  })
  return data
}

/** Perfil de la organización, cacheado para toda la sesión de pantalla. */
export function useOrgProfile() {
  return useQuery({
    queryKey: ["org-profile"],
    queryFn: fetchOrgProfile,
    staleTime: 5 * 60_000,
  })
}

/**
 * Lo que vale en las clínicas del país de esta (ADR 0036): documentos, seguro,
 * dirección y diagnósticos. Mientras carga, o sin país, el núcleo internacional:
 * nunca se muestra lo de un país que la clínica no eligió.
 */
export function useClinicalProfile(): ClinicalCountryProfile {
  const profile = useOrgProfile()
  // La lista de servicios es la del producto de la app: la misma regla que el servidor.
  return clinicalProfileFor(profile.data?.countryCode, productUi().product)
}

/**
 * La lista de diagnósticos con la que trabaja la clínica (decisión 26): la
 * guardada o, sin ella, la que recomienda su país. La misma regla que el servidor.
 */
export function effectiveDiagnosisSystem(
  profile: Pick<OrgProfile, "diagnosisSystem" | "countryCode"> | null | undefined,
): DiagnosisSystemInfo {
  const saved = profile?.diagnosisSystem
  const key = isDiagnosisSystem(saved)
    ? saved
    : clinicalProfileFor(profile?.countryCode).diagnosis.recommended
  return DIAGNOSIS_SYSTEM_INFO[key]
}

/** La lista de diagnósticos de la clínica, para decirla junto al buscador. */
export function useDiagnosisSystem(): DiagnosisSystemInfo {
  return effectiveDiagnosisSystem(useOrgProfile().data)
}

/** Cambia la lista de la clínica: los diagnósticos nuevos se eligen en ella; nada se reescribe. */
export async function saveDiagnosisSystem(
  diagnosisSystem: string,
): Promise<{ diagnosisSystem: string }> {
  const { data } = await apiFetch<{ data: { diagnosisSystem: string } }>(
    "/api/org-profile/diagnosis-system",
    {
      method: "PUT",
      body: JSON.stringify({ diagnosisSystem }),
    },
  )
  return data
}

/** Lo que el servidor propone para un país (moneda, formato, zona y papel). */
export interface RegionDefaults {
  /** `null`: no se conoce la moneda de ese país y se elige a mano. */
  currency: string | null
  /** Siempre el español del país (`es-PE`): odentIA está en español (#48). */
  locale: string
  /** `null`: el país tiene varias zonas horarias. */
  timezone: string | null
  sheetSize: "A4" | "Letter"
}

export async function fetchRegionDefaults(countryCode: string): Promise<RegionDefaults> {
  const params = new URLSearchParams({ countryCode })
  const result = await apiFetch<{ data: RegionDefaults }>(
    `/api/org-profile/region-defaults?${params}`,
  )
  return result.data
}

/** Clave de la propuesta de un país: la comparten la consulta y quien la pide al cambiar de país. */
export function regionDefaultsKey(countryCode: string) {
  return ["region-defaults", countryCode] as const
}

/** Datos de referencia de un país: no cambian durante la sesión. */
export const REGION_DEFAULTS_STALE_MS = 60 * 60_000
