import { useQuery } from "@tanstack/react-query"
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
  tradeName: string | null
  fiscalDocType: string | null
  fiscalDocNumber: string | null
  billingEmail: string | null
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
}

/**
 * Lo que guarda «Datos de la clínica». `null` vacía un dato opcional; lo que no
 * viaja (el correo de facturación, la impresión) queda como estaba.
 */
export interface OrgProfileInput {
  legalName: string
  tradeName: string | null
  fiscalDocType: string | null
  fiscalDocNumber: string | null
  fiscalAddress: string | null
  countryCode: string
  currency: string
  timezone: string
  locale: string
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

/** Lo que se imprime; se edita en «Medios de pago y ticket». */
export interface OrgPrintingInput {
  receiptWidth: "58" | "80"
  sheetSize: "A4" | "Letter"
  ticketFooter: string
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

/** Lo que el servidor propone para un país (moneda, formato, zona y papel). */
export interface RegionDefaults {
  /** `null`: no se conoce la moneda de ese país y se elige a mano. */
  currency: string | null
  locale: string
  /** Formatos que se ofrecen para ese país (BCP 47), el propuesto primero. */
  locales: string[]
  /** `null`: el país tiene varias zonas horarias. */
  timezone: string | null
  sheetSize: "A4" | "Letter"
}

export async function fetchRegionDefaults(
  countryCode: string,
  language?: string,
): Promise<RegionDefaults> {
  const params = new URLSearchParams({ countryCode })
  if (language) params.set("language", language)
  const result = await apiFetch<{ data: RegionDefaults }>(
    `/api/org-profile/region-defaults?${params}`,
  )
  return result.data
}

/** Clave de la propuesta de un país: la comparten la consulta y quien la pide al cambiar de país. */
export function regionDefaultsKey(countryCode: string, language: string | undefined) {
  return ["region-defaults", countryCode, language ?? ""] as const
}

/** Datos de referencia de un país: no cambian durante la sesión. */
export const REGION_DEFAULTS_STALE_MS = 60 * 60_000
