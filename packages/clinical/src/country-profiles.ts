/**
 * Lo que cambia con el país de la clínica (ADR 0036). La base de odentIA es
 * igual en todos los países: numeración FDI, rojo y azul en el odontograma,
 * una sola firma con el perfil profesional, documento con su país emisor,
 * dirección internacional y seguro con un tipo general. Lo que solo vale en
 * un país se enciende solo por el país que la clínica eligió en «Datos de la
 * clínica» (`org_profile.country_code`, ISO 3166-1 alfa-2): no hay interruptor
 * ni paso de configuración.
 *
 * Es la única pieza que dice qué es de Perú. Un país nuevo se añade aquí, con
 * su fuente, cuando llegue la primera clínica de allá; mientras tanto recibe
 * el núcleo internacional, nunca lo peruano.
 *
 * Lo ya firmado conserva su norma aunque la clínica cambie de país: cada
 * documento guarda la suya (p. ej. `odontogram_assessment.standard`).
 */

/** Tipos de documento de identidad. Las etiquetas valen en cualquier clínica. */
export const IDENTITY_DOC_TYPES = ["NACIONAL", "DNI", "CE", "PASAPORTE", "CNV", "DIE", "OTRO"] as const
export type IdentityDocType = (typeof IDENTITY_DOC_TYPES)[number]

/**
 * Quién emite un documento: un país fijo (el DNI lo emite el Perú), un país
 * distinto del de la clínica (documento extranjero), el que se elija sin
 * suponer ninguno (el pasaporte) o, si no se elige, el de la clínica (el
 * documento nacional).
 */
export type DocumentIssuer =
  | { kind: "fixed"; country: string }
  | { kind: "foreign" }
  | { kind: "chosen" }
  | { kind: "any" }

export interface DocumentTypeProfile {
  code: IdentityDocType
  issuer: DocumentIssuer
}

/**
 * Tipo general del seguro, igual en todos los países: lo que permitirá, más
 * adelante, conectar con los seguros de cada país sin tocar la ficha de los
 * demás. Correspondencia con HL7 FHIR Coverage.type (v3 ActCode): público →
 * PUBLICPOL, privado → EHCPOL (o el plan privado que corresponda), particular
 * → pago de bolsillo (`pay`, coverage-selfpay).
 */
export const INSURANCE_TYPES = ["PUBLICO", "PRIVADO", "PARTICULAR", "OTRO"] as const
export type InsuranceType = (typeof INSURANCE_TYPES)[number]
export const INSURANCE_TYPE_LABELS: Record<InsuranceType, string> = {
  PUBLICO: "Público",
  PRIVADO: "Privado",
  PARTICULAR: "Particular, sin seguro",
  OTRO: "Otro",
}

/** Régimen con nombre propio en un país (SIS en Perú) y su tipo general. */
export interface InsuranceScheme {
  code: string
  label: string
  type: InsuranceType
}

/** Subdivisión de primer nivel (ISO 3166-2) que se elige de una lista. */
export interface RegionOption {
  code: string
  label: string
}

export interface AddressProfile {
  /** Cómo se llama la región: «Región», «Departamento». */
  regionLabel: string
  /** Lista oficial (ISO 3166-2) o null: la región se escribe. */
  regions: readonly RegionOption[] | null
  /** Nivel entre región y ciudad (FHIR Address.district): «Provincia» en Perú; null si no se pide. */
  districtLabel: string | null
  /** Localidad (FHIR Address.city): «Ciudad», «Distrito». */
  cityLabel: string
  postalCode: boolean
  /** «Referencia» del domicilio («frente al parque»). */
  reference: boolean
}

/** Cómo se reconoce un teléfono nacional escrito sin código de país. */
export interface NationalPhoneProfile {
  callingCode: string
  national: RegExp
  hint: string
}

/** Odontograma con simbología oficial de un país. */
export interface OdontogramStandardProfile {
  /** Norma que se guarda en lo firmado. */
  standard: string
  /** Nombre corto: «NTS 188». */
  shortName: string
  /** Autoridad que la publica, para la hoja oficial: «MINSA». */
  authority: string
  /**
   * Variante y sigla obligatorias como en la norma. Sin norma la variante es
   * opcional y se pide por su nombre clínico («Profundidad», «Material»).
   */
  strictVariants: boolean
  /**
   * Odontograma firmado: se firma solo al cerrar la atención que cambió el
   * gráfico (inicio del plan, nuevos hallazgos, culminación) y con un botón
   * para lo judicial, lo personal y el reingreso.
   */
  signedOdontogram: boolean
}

export interface ClinicalCountryProfile {
  /** País de la clínica (ISO 3166-1 alfa-2) o null si aún no lo eligió. */
  country: string | null
  /** Odontograma oficial del país, o null: el núcleo internacional. */
  odontogram: OdontogramStandardProfile | null
  /** Documentos que se ofrecen, en el orden de la lista. */
  documentTypes: readonly DocumentTypeProfile[]
  /** Regímenes de seguro con nombre propio. */
  insuranceSchemes: readonly InsuranceScheme[]
  address: AddressProfile
  phone: NationalPhoneProfile | null
  /** «Procedencia»: dato censal que solo se pide en Perú. */
  origin: boolean
  /** Título y colegio que se proponen al completar el perfil profesional. */
  professional: { title: string; registrationBody: string } | null
}

/** Documentos del núcleo: el nacional, el pasaporte u otro, siempre con su país emisor. */
const CORE_DOCUMENTS: readonly DocumentTypeProfile[] = [
  { code: "NACIONAL", issuer: { kind: "any" } },
  { code: "PASAPORTE", issuer: { kind: "chosen" } },
  { code: "OTRO", issuer: { kind: "any" } },
]

const CORE_ADDRESS: AddressProfile = {
  regionLabel: "Región",
  regions: null,
  districtLabel: null,
  cityLabel: "Ciudad",
  postalCode: true,
  reference: false,
}

/** Núcleo internacional: lo que recibe cualquier país sin perfil propio. */
const CORE: Omit<ClinicalCountryProfile, "country"> = {
  odontogram: null,
  documentTypes: CORE_DOCUMENTS,
  insuranceSchemes: [],
  address: CORE_ADDRESS,
  phone: null,
  origin: false,
  professional: null,
}

/**
 * Departamentos del Perú con su código ISO 3166-2:PE. La norma separa Lima
 * Metropolitana (PE-LMA) de la región Lima (PE-LIM); se nombran como se dicen
 * en el país.
 */
const PERU_REGIONS: readonly RegionOption[] = [
  { code: "PE-AMA", label: "Amazonas" },
  { code: "PE-ANC", label: "Áncash" },
  { code: "PE-APU", label: "Apurímac" },
  { code: "PE-ARE", label: "Arequipa" },
  { code: "PE-AYA", label: "Ayacucho" },
  { code: "PE-CAJ", label: "Cajamarca" },
  { code: "PE-CAL", label: "Callao" },
  { code: "PE-CUS", label: "Cusco" },
  { code: "PE-HUV", label: "Huancavelica" },
  { code: "PE-HUC", label: "Huánuco" },
  { code: "PE-ICA", label: "Ica" },
  { code: "PE-JUN", label: "Junín" },
  { code: "PE-LAL", label: "La Libertad" },
  { code: "PE-LAM", label: "Lambayeque" },
  { code: "PE-LMA", label: "Lima Metropolitana" },
  { code: "PE-LIM", label: "Lima Provincias" },
  { code: "PE-LOR", label: "Loreto" },
  { code: "PE-MDD", label: "Madre de Dios" },
  { code: "PE-MOQ", label: "Moquegua" },
  { code: "PE-PAS", label: "Pasco" },
  { code: "PE-PIU", label: "Piura" },
  { code: "PE-PUN", label: "Puno" },
  { code: "PE-SAM", label: "San Martín" },
  { code: "PE-TAC", label: "Tacna" },
  { code: "PE-TUM", label: "Tumbes" },
  { code: "PE-UCA", label: "Ucayali" },
]

/**
 * Perú. Fuentes: NTS 188-MINSA/DGIESP-2022 (RM 559-2022-MINSA), obligatoria en
 * todos los establecimientos, públicos, privados y mixtos (III); documentos de
 * RENIEC (DNI, CNV) y Migraciones (CE); SIS y EsSalud como seguros públicos y
 * las EPS como privados (Ley 26790); colegiatura del Colegio Odontológico del
 * Perú (COP).
 */
const PERU: Omit<ClinicalCountryProfile, "country"> = {
  odontogram: {
    standard: "NTS 188-MINSA/DGIESP-2022",
    shortName: "NTS 188",
    authority: "MINSA",
    strictVariants: true,
    signedOdontogram: true,
  },
  documentTypes: [
    { code: "DNI", issuer: { kind: "fixed", country: "PE" } },
    { code: "CE", issuer: { kind: "fixed", country: "PE" } },
    { code: "PASAPORTE", issuer: { kind: "chosen" } },
    { code: "CNV", issuer: { kind: "fixed", country: "PE" } },
    { code: "DIE", issuer: { kind: "foreign" } },
    { code: "OTRO", issuer: { kind: "any" } },
  ],
  insuranceSchemes: [
    { code: "SIS", label: "SIS", type: "PUBLICO" },
    { code: "ESSALUD", label: "EsSalud", type: "PUBLICO" },
    { code: "EPS", label: "EPS", type: "PRIVADO" },
  ],
  address: {
    regionLabel: "Departamento",
    regions: PERU_REGIONS,
    districtLabel: "Provincia",
    cityLabel: "Distrito",
    postalCode: false,
    reference: true,
  },
  // Celular de 9 dígitos que empieza por 9.
  phone: { callingCode: "51", national: /^9\d{8}$/, hint: "un celular de 9 dígitos" },
  origin: true,
  professional: { title: "Cirujano dentista", registrationBody: "COP" },
}

const PROFILES: Record<string, Omit<ClinicalCountryProfile, "country">> = { PE: PERU }

/** Código de país normalizado (ISO 3166-1 alfa-2 en mayúsculas) o null. */
export function normalizeCountryCode(country: string | null | undefined): string | null {
  const code = country?.trim().toUpperCase()
  return code && /^[A-Z]{2}$/.test(code) ? code : null
}

/**
 * Lo que vale en las clínicas de un país. Sin país, o sin perfil propio, el
 * núcleo internacional: nunca se asume el de otro país.
 */
export function clinicalProfileFor(country: string | null | undefined): ClinicalCountryProfile {
  const code = normalizeCountryCode(country)
  return { country: code, ...(code && PROFILES[code] ? PROFILES[code] : CORE) }
}

/** El tipo de documento que se ofrece en ese país, o undefined. */
export function documentTypeProfile(
  profile: ClinicalCountryProfile,
  docType: string | null | undefined,
): DocumentTypeProfile | undefined {
  return profile.documentTypes.find((item) => item.code === docType)
}

/** Régimen de seguro con nombre propio del país, o undefined. */
export function insuranceScheme(
  profile: ClinicalCountryProfile,
  scheme: string | null | undefined,
): InsuranceScheme | undefined {
  return profile.insuranceSchemes.find((item) => item.code === scheme)
}

/** Región elegida de la lista del país, o undefined (también si se escribe). */
export function regionOption(
  profile: ClinicalCountryProfile,
  region: string | null | undefined,
): RegionOption | undefined {
  return profile.address.regions?.find((item) => item.code === region)
}
