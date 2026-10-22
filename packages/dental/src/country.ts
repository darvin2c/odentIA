/**
 * Lo dental que cambia con el país de la clínica (ADR 0036 y 0079): el
 * odontograma oficial, las especialidades con que nace la clínica y el título
 * que se propone al profesional. Lo demás del país (documentos, dirección,
 * seguros, diagnósticos, lista de servicios) es común y vive en
 * `clinicalProfileFor` de `@odentia/clinical`.
 */

import { normalizeCountryCode } from "@odentia/clinical"
import { isTreatmentKind, type TreatmentKind } from "./treatment-templates.js"

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

export interface DentalCountryProfile {
  /** País de la clínica (ISO 3166-1 alfa-2) o null si aún no lo eligió. */
  country: string | null
  /** Odontograma oficial del país, o null: el núcleo internacional. */
  odontogram: OdontogramStandardProfile | null
  /** Título y colegio que se proponen al completar el perfil profesional. */
  professional: { title: string; registrationBody: string } | null
  /** Las especialidades con que nace la clínica, y de qué norma salen. */
  specialties: SpecialtiesProfile
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

const CORE: Omit<DentalCountryProfile, "country"> = {
  odontogram: null,
  professional: null,
  specialties: CORE_SPECIALTIES,
}

/**
 * Lo dental de cada país con perfil o especialidades propias. Perú: NTS
 * 188-MINSA/DGIESP-2022 (RM 559-2022-MINSA), obligatoria en todos los
 * establecimientos, públicos, privados y mixtos (III), y colegiatura del
 * Colegio Odontológico del Perú (COP).
 */
const BY_COUNTRY: Record<string, Omit<DentalCountryProfile, "country">> = {
  PE: {
    odontogram: {
      standard: "NTS 188-MINSA/DGIESP-2022",
      shortName: "NTS 188",
      authority: "MINSA",
      strictVariants: true,
      signedOdontogram: true,
    },
    professional: { title: "Cirujano dentista", registrationBody: "COP" },
    specialties: PERU_SPECIALTIES,
  },
  CO: { ...CORE, specialties: COLOMBIA_SPECIALTIES },
  CL: { ...CORE, specialties: CHILE_SPECIALTIES },
}

/**
 * Lo dental que vale en las clínicas de un país. Sin país, o sin perfil
 * propio, el núcleo internacional: nunca se asume el de otro país.
 */
export function dentalProfileFor(country: string | null | undefined): DentalCountryProfile {
  const code = normalizeCountryCode(country)
  return { country: code, ...(code && BY_COUNTRY[code] ? BY_COUNTRY[code] : CORE) }
}

/**
 * La especialidad del país que recibe un tipo de la biblioteca: la regla con
 * que un servicio de la biblioteca toma su especialidad (ADR 0069).
 */
export function specialtyForKind(profile: DentalCountryProfile, kind: string): SpecialtyProfile | null {
  return profile.specialties.list.find((item) => (item.receives as readonly string[]).includes(kind)) ?? null
}

/** El tipo que toma un servicio propio por su especialidad (su clave), o null. */
export function kindOfSpecialty(profile: DentalCountryProfile, specialtyKey: string | null | undefined): TreatmentKind | null {
  if (!specialtyKey) return null
  const kind = profile.specialties.list.find((item) => item.key === specialtyKey)?.kind
  if (kind) return kind
  // Una especialidad que la clínica conservó con la clave de un tipo de la
  // biblioteca (las de antes de ADR 0069, p. ej. «Estética») sigue siendo ese tipo.
  return isTreatmentKind(specialtyKey) ? specialtyKey : null
}
