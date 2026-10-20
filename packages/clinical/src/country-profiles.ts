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

import type { DiagnosisSystemKey } from "./diagnoses.js"
import type { MaritalStatus } from "./identity.js"
import type { TreatmentKind } from "./treatment-templates.js"

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
  /** Estados civiles que se ofrecen, en el orden de la lista (HL7 o la palabra del país). */
  maritalStatuses: readonly MaritalStatus[]
  /**
   * Lista de diagnósticos (decisión 26 de la fase 4): la que se propone al
   * crear la clínica y, por lista, lo que se le avisa si elige otra.
   */
  diagnosis: DiagnosisProfile
  /**
   * La lista de servicios del país (ADR 0067), o null: sin lista, los
   * servicios no llevan código.
   */
  services: ServiceListProfile | null
  /** Las especialidades con que nace la clínica, y de qué norma salen. */
  specialties: SpecialtiesProfile
}

export interface ServiceListProfile {
  /** La lista en el catálogo (`procedure_code_system.key`), p. ej. «CPMS». */
  system: string
  /** Su nombre corto en pantalla: «Código CPMS», «Código CIE-9-MC». */
  label: string
  /**
   * Obligatoria: la norma pide que la clínica privada codifique con ella, así
   * que todo servicio lleva su código. De referencia: solo cuando lo tiene.
   */
  required: boolean
  /** La norma que la fija, para «Normas de tu país». */
  norm: string
}

/**
 * Una especialidad con que nace la clínica. `receives` son los tipos de la
 * biblioteca que la usan: cada tipo va a una sola especialidad del país.
 * `kind` es el tipo que toma un servicio propio de esta especialidad (para la
 * fase del plan y las palabras del agente); null si no tiene uno claro.
 */
export interface SpecialtyProfile {
  key: string
  name: string
  kind: TreatmentKind | null
  receives: readonly TreatmentKind[]
}

export interface SpecialtiesProfile {
  /** La norma que reconoce estas especialidades; null = la lista general de odentIA. */
  source: string | null
  list: readonly SpecialtyProfile[]
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

/**
 * Especialidades del núcleo: las que reconocen casi todos los países de la
 * región, con los nombres más comunes, y Odontología general para lo demás.
 * No hay una lista internacional (la FDI no publica una).
 */
const CORE_SPECIALTIES: SpecialtiesProfile = {
  source: null,
  list: [
    {
      key: "odontologia_general",
      name: "Odontología general",
      kind: "general",
      receives: ["diagnostico", "prevencion", "restauradora", "estetica", "anestesia", "general"],
    },
    { key: "endodoncia", name: "Endodoncia", kind: "endodoncia", receives: ["endodoncia"] },
    { key: "periodoncia", name: "Periodoncia", kind: "periodoncia", receives: ["periodoncia"] },
    { key: "ortodoncia", name: "Ortodoncia", kind: "ortodoncia", receives: ["ortodoncia"] },
    { key: "odontopediatria", name: "Odontopediatría", kind: "odontopediatria", receives: ["odontopediatria"] },
    { key: "cirugia_oral", name: "Cirugía oral y maxilofacial", kind: "cirugia", receives: ["cirugia"] },
    { key: "rehabilitacion_oral", name: "Rehabilitación oral", kind: "protesis", receives: ["protesis", "disfuncion"] },
    { key: "implantologia", name: "Implantología", kind: "implantologia", receives: ["implantologia"] },
  ],
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
  maritalStatuses: CORE_MARITAL,
  diagnosis: CORE_DIAGNOSIS,
  services: null,
  specialties: CORE_SPECIALTIES,
}

/**
 * Especialidades de Perú: las del art. 26 del Reglamento de la Ley 27878
 * (DS 023-2020-SA) que atienden pacientes en un consultorio, y Odontología
 * general. Quedan fuera Salud Pública Estomatológica, Salud Familiar y
 * Comunitaria, Odontología Forense, Auditoría Odontológica y Administración y
 * Gestión en Estomatología (decisión 5 del lienzo del issue 40).
 */
const PERU_SPECIALTIES: SpecialtiesProfile = {
  source: "DS 023-2020-SA",
  list: [
    {
      key: "odontologia_general",
      name: "Odontología general",
      kind: "general",
      receives: ["diagnostico", "prevencion", "anestesia", "general"],
    },
    { key: "cirugia_bucal_maxilofacial", name: "Cirugía Bucal y Maxilofacial", kind: "cirugia", receives: ["cirugia"] },
    { key: "endodoncia", name: "Endodoncia", kind: "endodoncia", receives: ["endodoncia"] },
    { key: "medicina_patologia_estomatologica", name: "Medicina y Patología Estomatológica", kind: "diagnostico", receives: [] },
    { key: "odontopediatria", name: "Odontopediatría", kind: "odontopediatria", receives: ["odontopediatria"] },
    { key: "ortodoncia_ortopedia_maxilar", name: "Ortodoncia y Ortopedia Maxilar", kind: "ortodoncia", receives: ["ortodoncia"] },
    { key: "periodoncia_implantologia", name: "Periodoncia e Implantología", kind: "periodoncia", receives: ["periodoncia"] },
    { key: "radiologia_bucal_maxilofacial", name: "Radiología Bucal y Maxilofacial", kind: "diagnostico", receives: [] },
    { key: "rehabilitacion_oral", name: "Rehabilitación Oral", kind: "protesis", receives: ["protesis", "disfuncion"] },
    { key: "pacientes_especiales", name: "Estomatología de Pacientes Especiales", kind: "general", receives: [] },
    {
      key: "restauradora_estetica",
      name: "Odontología Restauradora y Estética",
      kind: "restauradora",
      receives: ["restauradora", "estetica"],
    },
    { key: "odontogeriatria", name: "Odontogeriatría", kind: "general", receives: [] },
    { key: "implantologia_oral_integral", name: "Implantología Oral Integral", kind: "implantologia", receives: ["implantologia"] },
  ],
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
  services: { system: "CPMS", label: "CPMS", required: true, norm: "RM 550-2023-MINSA" },
  specialties: PERU_SPECIALTIES,
}

const PROFILES: Record<string, Omit<ClinicalCountryProfile, "country">> = { PE: PERU }

/**
 * Especialidades de Colombia: las nueve que la CUPS (Res. 2706 de 2025)
 * reconoce en sus códigos de consulta (890217 a 890224 y 890236), y
 * Odontología general (890203), que recibe también lo restaurador y lo
 * estético: la CUPS no tiene consulta propia de operatoria ni de estética.
 */
const COLOMBIA_SPECIALTIES: SpecialtiesProfile = {
  source: "CUPS, Res. 2706 de 2025",
  list: [
    {
      key: "odontologia_general",
      name: "Odontología general",
      kind: "general",
      receives: ["diagnostico", "prevencion", "restauradora", "estetica", "anestesia", "general"],
    },
    { key: "cirugia_oral", name: "Cirugía oral", kind: "cirugia", receives: ["cirugia", "implantologia"] },
    { key: "endodoncia", name: "Endodoncia", kind: "endodoncia", receives: ["endodoncia"] },
    { key: "estomatologia_cirugia_oral", name: "Estomatología y cirugía oral", kind: "cirugia", receives: [] },
    { key: "odontopediatria", name: "Odontopediatría", kind: "odontopediatria", receives: ["odontopediatria"] },
    { key: "periodoncia", name: "Periodoncia", kind: "periodoncia", receives: ["periodoncia"] },
    { key: "ortodoncia", name: "Ortodoncia", kind: "ortodoncia", receives: ["ortodoncia"] },
    { key: "radiologia_oral_maxilofacial", name: "Radiología oral y maxilofacial", kind: "diagnostico", receives: [] },
    { key: "rehabilitacion_oral", name: "Rehabilitación oral", kind: "protesis", receives: ["protesis", "disfuncion"] },
    { key: "cirugia_maxilofacial", name: "Cirugía maxilofacial", kind: "cirugia", receives: [] },
  ],
}

/**
 * Especialidades de Chile: las del Decreto 8 de 2013 (con los Decretos 17 de
 * 2017 y 30 de 2024) que certifica CONACEO y atienden pacientes en un
 * consultorio, y Odontología general. Quedan fuera Odontología legal y Salud
 * pública.
 */
const CHILE_SPECIALTIES: SpecialtiesProfile = {
  source: "Decreto 8 de 2013 (CONACEO)",
  list: [
    {
      key: "odontologia_general",
      name: "Odontología general",
      kind: "general",
      receives: ["diagnostico", "prevencion", "restauradora", "estetica", "anestesia", "general"],
    },
    {
      key: "cirugia_traumatologia_bucomaxilofacial",
      name: "Cirugía y traumatología buco maxilofacial",
      kind: "cirugia",
      receives: ["cirugia"],
    },
    { key: "endodoncia", name: "Endodoncia", kind: "endodoncia", receives: ["endodoncia"] },
    { key: "imagenologia_oral_maxilofacial", name: "Imagenología oral y maxilofacial", kind: "diagnostico", receives: [] },
    { key: "implantologia_bucomaxilofacial", name: "Implantología buco maxilofacial", kind: "implantologia", receives: ["implantologia"] },
    { key: "odontopediatria", name: "Odontopediatría", kind: "odontopediatria", receives: ["odontopediatria"] },
    {
      key: "ortodoncia_ortopedia_dentomaxilofacial",
      name: "Ortodoncia y ortopedia dento maxilofacial",
      kind: "ortodoncia",
      receives: ["ortodoncia"],
    },
    { key: "patologia_oral_maxilofacial", name: "Patología oral y maxilofacial", kind: "diagnostico", receives: [] },
    { key: "periodoncia", name: "Periodoncia", kind: "periodoncia", receives: ["periodoncia"] },
    { key: "rehabilitacion_oral", name: "Rehabilitación oral", kind: "protesis", receives: ["protesis"] },
    { key: "somatoprotesis", name: "Somato-prótesis", kind: "protesis", receives: [] },
    {
      key: "trastornos_temporomandibulares",
      name: "Trastornos temporomandibulares y dolor orofacial",
      kind: "disfuncion",
      receives: ["disfuncion"],
    },
    { key: "odontogeriatria", name: "Odontogeriatría", kind: "general", receives: [] },
  ],
}

/**
 * La lista de servicios (y, si las tiene, las especialidades) de un país que
 * no tiene perfil propio (ADR 0067): lo demás es el núcleo. Solo entra un país
 * cuando su lista está cargada con su archivo oficial y su huella.
 */
const SERVICES_BY_COUNTRY: Record<string, { services: ServiceListProfile; specialties?: SpecialtiesProfile }> = {
  // Res. 2706 de 2025, art. 2: toda IPS, sin distinguir pública o privada.
  CO: {
    services: { system: "CUPS", label: "CUPS", required: true, norm: "Res. 2706 de 2025" },
    specialties: COLOMBIA_SPECIALTIES,
  },
  // NOM-024-SSA3-2012: el software de expediente clínico usa el catálogo de
  // procedimientos de la DGIS, también en el privado.
  MX: { services: { system: "CIE9MC-MX", label: "CIE-9-MC", required: true, norm: "NOM-024-SSA3-2012" } },
  // Solo para quien atiende con bono FONASA (Modalidad Libre Elección).
  CL: {
    services: { system: "FONASA", label: "FONASA", required: false, norm: "Arancel MLE 2026, Res. Ex. 347/2026" },
    specialties: CHILE_SPECIALTIES,
  },
  // Lo obligatorio del tarifario del Colegio (Ley 10352, art. 5 inc. y) es el
  // precio mínimo, no el código: la lista es de referencia.
  CR: {
    services: {
      system: "COLEGIO-CR",
      label: "Colegio de Dentistas",
      required: false,
      norm: "tarifas mínimas del Colegio, La Gaceta 19 de 2025",
    },
  },
  // Adaptación propia del MINSAL: el mismo número puede ser otro acto que en
  // la CIE-9-MC internacional.
  SV: { services: { system: "CIE9MC-SV", label: "CIE-9-MC", required: false, norm: "CIE-9-MC 2024 del MINSAL" } },
}


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
  const base = code && PROFILES[code] ? PROFILES[code] : CORE
  const diagnosis = code && !PROFILES[code] && DIAGNOSIS_BY_COUNTRY[code] ? DIAGNOSIS_BY_COUNTRY[code] : base.diagnosis
  const lists = code && !PROFILES[code] ? SERVICES_BY_COUNTRY[code] : undefined
  return {
    country: code,
    ...base,
    diagnosis,
    services: lists ? lists.services : base.services,
    specialties: lists?.specialties ?? base.specialties,
  }
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

/**
 * La especialidad del país que recibe un tipo de la biblioteca: la regla con
 * que un servicio de la biblioteca toma su especialidad (ADR 0067).
 */
export function specialtyForKind(profile: ClinicalCountryProfile, kind: string): SpecialtyProfile | null {
  return profile.specialties.list.find((item) => (item.receives as readonly string[]).includes(kind)) ?? null
}

/** El tipo que toma un servicio propio por su especialidad (su clave), o null. */
export function kindOfSpecialty(profile: ClinicalCountryProfile, specialtyKey: string | null | undefined): TreatmentKind | null {
  if (!specialtyKey) return null
  return profile.specialties.list.find((item) => item.key === specialtyKey)?.kind ?? null
}
