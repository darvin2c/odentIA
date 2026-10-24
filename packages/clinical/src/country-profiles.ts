/**
 * Lo que cambia con el país de la clínica (ADR 0036), común a todos los
 * productos. La base es igual en todos los países: una sola firma con el
 * perfil profesional, documento con su país emisor, dirección internacional y
 * seguro con un tipo general. Lo que cambia con el país y solo es de un
 * producto (el odontograma oficial, las especialidades) vive en el paquete de
 * ese producto: `dentalProfileFor` de `@odentia/dental` (ADR 0079). Lo que solo vale en
 * un país se enciende solo por el país que la clínica eligió en «Datos de la
 * clínica» (`org_profile.country_code`, ISO 3166-1 alfa-2): no hay interruptor
 * ni paso de configuración.
 *
 * Es la única pieza que dice qué es de Perú. Un país nuevo se añade aquí, con
 * su fuente, cuando llegue la primera clínica de allá; mientras tanto recibe
 * el núcleo internacional, nunca lo peruano.
 *
 * Lo ya firmado conserva su norma aunque la clínica cambie de país: cada
 * documento guarda la suya.
 */

import type { DiagnosisSystemKey } from "./diagnoses.js"
import type { ClinicalProduct } from "./products.js"
import type { MaritalStatus } from "./identity.js"

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
 * Documentos tributarios: con el que una empresa o una persona factura (el RUC
 * de la SUNAT en Perú). Cada país con perfil trae el suyo; el núcleo, que no
 * conoce el de ningún país, uno genérico («Documento tributario»).
 */
export const TAX_DOC_TYPES = ["TRIBUTARIO", "RUC"] as const
export type TaxDocType = (typeof TAX_DOC_TYPES)[number]

/** Tipo de documento de un proveedor: tributario o de persona. */
export type SupplierDocType = TaxDocType | IdentityDocType

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
  /**
   * Otros nombres con que la nombran los mapas, cuando el nombre solo no basta
   * para reconocerla (`regionFromMap`): «Provincia de Lima» es Lima Metropolitana.
   */
  aliases?: readonly string[]
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

export interface ClinicalCountryProfile {
  /** País de la clínica (ISO 3166-1 alfa-2) o null si aún no lo eligió. */
  country: string | null
  /** Documentos que se ofrecen, en el orden de la lista. */
  documentTypes: readonly DocumentTypeProfile[]
  /** Documentos tributarios del país (los primeros que se ofrecen a un proveedor). */
  taxDocumentTypes: readonly TaxDocType[]
  /** Regímenes de seguro con nombre propio. */
  insuranceSchemes: readonly InsuranceScheme[]
  address: AddressProfile
  phone: NationalPhoneProfile | null
  /** «Procedencia»: dato censal que solo se pide en Perú. */
  origin: boolean
  /** Estados civiles que se ofrecen, en el orden de la lista (HL7 o la palabra del país). */
  maritalStatuses: readonly MaritalStatus[]
  /**
   * Lista de diagnósticos (decisión 26 de la fase 4): la que se propone al
   * crear la clínica y, por lista, lo que se le avisa si elige otra.
   */
  diagnosis: DiagnosisProfile
  /**
   * La lista de servicios del país (ADR 0069), o null: sin lista, los
   * servicios no llevan código.
   */
  services: ServiceListProfile | null
  /**
   * La ley de firmas del país, para decir en el documento firmado que una
   * firma manuscrita capturada no es la firma digital que esa ley reconoce;
   * null: se dice sin nombrar ley (#47).
   */
  signatureLaw: string | null
}

export interface ServiceListProfile {
  /** La lista en el catálogo (`procedure_code_system.key`), p. ej. «CPMS». */
  system: string
  /** Su nombre corto, junto al código en la biblioteca: «CPMS D2330». */
  label: string
  /** Cómo se dice su código en una frase: «código CPMS», «código del Colegio de Dentistas». */
  codeName: string
  /** Cómo se nombra la lista en una frase, con su artículo: «la lista CPMS», «el arancel FONASA». */
  listName: string
  /**
   * Obligatoria: la norma pide que la clínica privada codifique con ella, así
   * que todo servicio lleva su código. De referencia: solo cuando lo tiene.
   */
  required: boolean
  /** La norma que la fija, para «Normas de tu país». */
  norm: string
  /**
   * Los productos cuyos servicios están en ella; sin él, todos. Una lista
   * solo odontológica no vale para un consultorio médico (issue 229).
   */
  products?: readonly ClinicalProduct[]
}

export interface DiagnosisProfile {
  recommended: DiagnosisSystemKey
  /** Aviso al elegir una lista que no es la recomendada; sin texto propio, uno general. */
  notices: Partial<Record<DiagnosisSystemKey, string>>
  /**
   * La hoja del registro oficial del país dice el tipo del diagnóstico como
   * su norma (en Perú, el HIS: P, D o R, con R para «ya diagnosticado antes»).
   */
  officialRecordTypes: boolean
}

/** Documentos del núcleo: el nacional, el pasaporte u otro, siempre con su país emisor. */
const CORE_DOCUMENTS: readonly DocumentTypeProfile[] = [
  { code: "NACIONAL", issuer: { kind: "any" } },
  { code: "PASAPORTE", issuer: { kind: "chosen" } },
  { code: "OTRO", issuer: { kind: "any" } },
]

/** HL7 v3 MaritalStatus, sin palabras de un país. */
const CORE_MARITAL: readonly MaritalStatus[] = ["S", "M", "T", "L", "D", "W"]

/**
 * La CIE-10 sigue siendo la lista de casi todos los países de habla hispana
 * (Perú, Chile, México, Argentina…): es la que se propone sin perfil propio.
 */
const CORE_DIAGNOSIS: DiagnosisProfile = { recommended: "ICD-10", notices: {}, officialRecordTypes: false }

/**
 * Lista recomendada en países sin otro perfil. Colombia adopta la CIE-11 por
 * norma (Resolución 1442 de 2024 del Ministerio de Salud, con hasta 36 meses
 * de transición).
 */
const DIAGNOSIS_BY_COUNTRY: Record<string, DiagnosisProfile> = {
  CO: { recommended: "ICD-11", notices: {}, officialRecordTypes: false },
}

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
  documentTypes: CORE_DOCUMENTS,
  taxDocumentTypes: ["TRIBUTARIO"],
  insuranceSchemes: [],
  address: CORE_ADDRESS,
  phone: null,
  origin: false,
  maritalStatuses: CORE_MARITAL,
  diagnosis: CORE_DIAGNOSIS,
  services: null,
  signatureLaw: null,
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
  { code: "PE-LMA", label: "Lima Metropolitana", aliases: ["Provincia de Lima", "Municipalidad Metropolitana de Lima"] },
  { code: "PE-LIM", label: "Lima Provincias", aliases: ["Lima", "Región Lima", "Departamento de Lima"] },
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
 * Perú. Fuentes: documentos de
 * RENIEC (DNI, CNV) y Migraciones (CE); el RUC de la SUNAT como documento
 * tributario; SIS y EsSalud como seguros públicos y las EPS como privados (Ley
 * 26790). Lo dental del país (NTS 188, COP, especialidades) está en
 * `dentalProfileFor` de `@odentia/dental` (ADR 0079).
 */
const PERU: Omit<ClinicalCountryProfile, "country"> = {
  documentTypes: [
    { code: "DNI", issuer: { kind: "fixed", country: "PE" } },
    { code: "CE", issuer: { kind: "fixed", country: "PE" } },
    { code: "PASAPORTE", issuer: { kind: "chosen" } },
    { code: "CNV", issuer: { kind: "fixed", country: "PE" } },
    { code: "DIE", issuer: { kind: "foreign" } },
    { code: "OTRO", issuer: { kind: "any" } },
  ],
  taxDocumentTypes: ["RUC"],
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
  // «Conviviente» es la palabra del país; al enviarse a otro sistema sale como HL7 T.
  maritalStatuses: ["S", "M", "PE:conviviente", "L", "D", "W"],
  // El registro HIS del MINSA codifica los diagnósticos con la CIE-10.
  diagnosis: {
    recommended: "ICD-10",
    notices: {
      "ICD-11": "En Perú, el registro oficial (HIS) pide la CIE-10. Con la CIE-11, esa hoja no se podrá llenar.",
    },
    officialRecordTypes: true,
  },
  // La RM 550-2023-MINSA (art. 2) obliga a las IPRESS públicas, privadas y
  // mixtas a usar el CPMS en sus sistemas.
  services: {
    system: "CPMS",
    label: "CPMS",
    codeName: "código CPMS",
    listName: "la lista CPMS",
    required: true,
    norm: "RM 550-2023-MINSA",
  },
  // Ley de Firmas y Certificados Digitales.
  signatureLaw: "Ley 27269",
}

const PROFILES: Record<string, Omit<ClinicalCountryProfile, "country">> = { PE: PERU }

/**
 * La lista de servicios de un país que
 * no tiene perfil propio (ADR 0069): lo demás es el núcleo. Solo entra un país
 * cuando su lista está cargada con su archivo oficial y su huella.
 */
const SERVICES_BY_COUNTRY: Record<string, { services: ServiceListProfile }> = {
  // Res. 2706 de 2025, art. 2: toda IPS, sin distinguir pública o privada.
  CO: {
    services: {
      system: "CUPS",
      label: "CUPS",
      codeName: "código CUPS",
      listName: "la lista CUPS",
      required: true,
      norm: "Res. 2706 de 2025",
    },
  },
  // NOM-024-SSA3-2012: el software de expediente clínico usa el catálogo de
  // procedimientos de la DGIS, también en el privado.
  MX: {
    services: {
      system: "CIE9MC-MX",
      label: "CIE-9-MC",
      codeName: "código CIE-9-MC",
      listName: "la lista CIE-9-MC de la DGIS",
      required: true,
      norm: "NOM-024-SSA3-2012",
    },
  },
  // Solo para quien atiende con bono FONASA (Modalidad Libre Elección).
  CL: {
    services: {
      system: "FONASA",
      label: "FONASA",
      codeName: "código FONASA",
      listName: "el arancel FONASA",
      required: false,
      norm: "Arancel MLE 2026, Res. Ex. 347/2026",
    },
  },
  // Lo obligatorio del tarifario del Colegio (Ley 10352, art. 5 inc. y) es el
  // precio mínimo, no el código: la lista es de referencia.
  CR: {
    services: {
      system: "COLEGIO-CR",
      label: "Colegio de Dentistas",
      codeName: "código del Colegio de Dentistas",
      listName: "el tarifario del Colegio de Dentistas",
      required: false,
      norm: "tarifas mínimas del Colegio, La Gaceta 19 de 2025",
      products: ["dental"],
    },
  },
  // Adaptación propia del MINSAL: el mismo número puede ser otro acto que en
  // la CIE-9-MC internacional.
  SV: {
    services: {
      system: "CIE9MC-SV",
      label: "CIE-9-MC",
      codeName: "código CIE-9-MC",
      listName: "la lista CIE-9-MC del MINSAL",
      required: false,
      norm: "CIE-9-MC 2024 del MINSAL",
      // Se cargaron solo los capítulos y rúbricas odontológicos.
      products: ["dental"],
    },
  },
}


/** Código de país normalizado (ISO 3166-1 alfa-2 en mayúsculas) o null. */
export function normalizeCountryCode(country: string | null | undefined): string | null {
  const code = country?.trim().toUpperCase()
  return code && /^[A-Z]{2}$/.test(code) ? code : null
}

/**
 * Lo que vale en las clínicas de un país. Sin país, o sin perfil propio, el
 * núcleo internacional: nunca se asume el de otro país. Con el producto, la
 * lista de servicios es la que tiene los suyos (la del Colegio de Dentistas
 * de Costa Rica no vale para un consultorio médico); sin él, la del país.
 */
export function clinicalProfileFor(
  country: string | null | undefined,
  product?: ClinicalProduct,
): ClinicalCountryProfile {
  const code = normalizeCountryCode(country)
  const base = code && PROFILES[code] ? PROFILES[code] : CORE
  const diagnosis = code && !PROFILES[code] && DIAGNOSIS_BY_COUNTRY[code] ? DIAGNOSIS_BY_COUNTRY[code] : base.diagnosis
  const lists = code && !PROFILES[code] ? SERVICES_BY_COUNTRY[code] : undefined
  const services = lists ? lists.services : base.services
  return {
    country: code,
    ...base,
    diagnosis,
    services: services && product && services.products && !services.products.includes(product) ? null : services,
  }
}

/** El tipo de documento que se ofrece en ese país, o undefined. */
export function documentTypeProfile(
  profile: ClinicalCountryProfile,
  docType: string | null | undefined,
): DocumentTypeProfile | undefined {
  return profile.documentTypes.find((item) => item.code === docType)
}

/**
 * Documentos de persona que no identifican a quien vende: el del recién
 * nacido (CNV) y el documento de identidad extranjero (DIE), que es el del
 * paciente que vive fuera. Un proveedor que es una persona se identifica con
 * el documento del país, el de residente extranjero o el pasaporte.
 */
const NOT_FOR_SUPPLIERS: ReadonlySet<IdentityDocType> = new Set(["CNV", "DIE"])

/**
 * Los tipos de documento que se ofrecen a un proveedor, en el orden de la
 * lista: los tributarios del país, los de persona que sirven a quien vende (en
 * Perú DNI, carné de extranjería y pasaporte) y «Otro» al final. Es una lista
 * cerrada: el servidor rechaza cualquier otro valor.
 */
export function supplierDocumentTypes(profile: ClinicalCountryProfile): readonly SupplierDocType[] {
  const people = profile.documentTypes
    .map((item) => item.code)
    .filter((code) => code !== "OTRO" && !NOT_FOR_SUPPLIERS.has(code))
  return [...profile.taxDocumentTypes, ...people, "OTRO"]
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

