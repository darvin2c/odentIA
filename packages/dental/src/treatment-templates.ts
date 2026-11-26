/**
 * Contratos de prestaciones y validación del sitio clínico.
 * La biblioteca es de odentIA: tratamientos de consultorio con nombre propio,
 * y por debajo el código de la lista de cada país (ADR 0069). Los nombres
 * comerciales y los precios pertenecen a cada clínica.
 */
import { isValidTooth, surfacesForTooth } from "./anatomy.js"
import { isUrgentDiagnosis } from "./diagnoses.js"

/**
 * Tipos de tratamiento de la biblioteca (ADR 0069): ordenan la biblioteca,
 * proponen la fase del plan, guardan las palabras de la calle del agente y
 * dicen qué especialidad del país recibe cada tratamiento. Son de uso
 * interno: la clínica ve y edita la especialidad, nunca el tipo. Antes eran
 * las especialidades con que nacía la clínica (ADR 0039); ahora las
 * especialidades salen del perfil del país.
 */
export const TREATMENT_KINDS = [
  { key: "diagnostico", name: "Diagnóstico" },
  { key: "prevencion", name: "Prevención" },
  { key: "restauradora", name: "Restauradora" },
  { key: "endodoncia", name: "Endodoncia" },
  { key: "periodoncia", name: "Periodoncia" },
  { key: "cirugia", name: "Cirugía" },
  { key: "protesis", name: "Prótesis" },
  { key: "implantologia", name: "Implantología" },
  { key: "ortodoncia", name: "Ortodoncia" },
  { key: "odontopediatria", name: "Odontopediatría" },
  { key: "estetica", name: "Estética" },
  { key: "disfuncion", name: "Disfunción" },
  { key: "anestesia", name: "Anestesia y sedación" },
  { key: "general", name: "Servicios generales" },
] as const
export type TreatmentKind = (typeof TREATMENT_KINDS)[number]["key"]
/** Las claves de los tipos, en su orden. */
export const TREATMENT_KIND_KEYS: readonly TreatmentKind[] = TREATMENT_KINDS.map((item) => item.key)

export function isTreatmentKind(value: unknown): value is TreatmentKind {
  return typeof value === "string" && (TREATMENT_KIND_KEYS as readonly string[]).includes(value)
}

/** El nombre de un tipo, para agrupar la biblioteca. */
export function treatmentKindName(kind: TreatmentKind): string {
  return TREATMENT_KINDS.find((item) => item.key === kind)!.name
}

/**
 * Fases del plan de tratamiento odontológico, en el orden en que se ejecutan:
 * urgencia (dolor, infección, trauma), básica o higiénica (control de caries y
 * periodonto), quirúrgica, rehabilitadora y mantenimiento.
 */
export const TREATMENT_PHASES = [
  "urgencia",
  "basica",
  "quirurgica",
  "rehabilitadora",
  "mantenimiento",
] as const
export type TreatmentPhase = (typeof TREATMENT_PHASES)[number]

export const TREATMENT_PHASE_LABELS: Record<TreatmentPhase, string> = {
  urgencia: "Urgencia",
  basica: "Básica o higiénica",
  quirurgica: "Quirúrgica",
  rehabilitadora: "Rehabilitadora",
  mantenimiento: "Mantenimiento",
}

/**
 * La cirugía que la biblioteca pone en otra especialidad (QA clínica del 18 nov, H1): la periapical
 * (apicectomía, de endodoncia) y la periodontal que abre encía o hueso (colgajos, injertos,
 * gingivectomía, alargamiento de corona, regeneración), de periodoncia. Por el comienzo de su clave
 * en `seeds/biblioteca.csv`. AAOMS 2022 pone el riesgo de osteonecrosis en la cirugía dentoalveolar
 * que expone hueso, también la periapical y la periodontal; SDCEP 2022 (anticoagulantes) las pone
 * entre las de más riesgo de sangrado. Fuera: el raspado, el curetaje y la endodoncia convencional.
 * La misma regla avisa en la fila del plan y la pone en la fase quirúrgica (`phaseForTreatment`).
 */
export const SURGICAL_LIBRARY_KEY_PREFIXES: readonly string[] = [
  "apicectomia-",
  "alargamiento-de-corona-",
  "aloinjerto-de-tejido-blando",
  "cirugia-periodontal-",
  "colgajo-",
  "gingivectomia-",
  "injerto-de-tejido-conectivo",
  "injerto-gingival-libre",
  "regeneracion-guiada-",
  "regeneracion-osea",
]

/** ¿Es cirugía, aunque la biblioteca lo ponga en otra especialidad? Por su clave de la biblioteca. */
export function isSurgicalLibraryKey(key: string | null | undefined): boolean {
  return !!key && SURGICAL_LIBRARY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/**
 * Lo que va sobre el implante ya puesto (la corona, el pilar, el retenedor, la barra o la prótesis): la
 * biblioteca lo pone en implantología, pero es rehabilitación y va después de la cirugía (revisión de
 * la guía del plan por fases, 26 nov: la corona sobre el implante del 46 caía en la quirúrgica). Por el
 * comienzo de su clave en `seeds/biblioteca.csv`; la colocación y el retiro del implante siguen en la
 * quirúrgica.
 */
export const IMPLANT_PROSTHESIS_LIBRARY_KEY_PREFIXES: readonly string[] = [
  "barra-de-conexion-sobre-implantes",
  "corona-",
  "pilar-",
  "protesis-",
  "reparacion-de-pilar-",
  "reparacion-de-protesis-",
  "retenedor-",
]

/** ¿Es la prótesis sobre un implante, aunque la biblioteca la ponga en implantología? */
export function isImplantProsthesisLibraryKey(key: string | null | undefined): boolean {
  return !!key && IMPLANT_PROSTHESIS_LIBRARY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/**
 * Fase propuesta por el tipo de tratamiento del servicio; el clínico la
 * cambia. Sin tipo, la básica. El tipo nunca propone la urgencia: es un juicio
 * sobre el paciente, no sobre el acto (la propone su diagnóstico,
 * `phaseForTreatment`).
 */
export function phaseForKind(kind: string | null | undefined): TreatmentPhase {
  switch (kind) {
    case "cirugia":
    case "implantologia":
      return "quirurgica"
    case "protesis":
    case "ortodoncia":
    case "estetica":
    case "disfuncion":
      return "rehabilitadora"
    default:
      return "basica"
  }
}

/** Un diagnóstico de lo que se indica, con su lista («ICD-10-PE», «K04.0»). */
export interface PhaseDiagnosis {
  system: string | null
  code: string | null
}

/**
 * Fase propuesta para un tratamiento que se indica o se cambia: la de su tipo
 * (`phaseForKind`), adelantada a «Urgencia» si uno de sus diagnósticos (el
 * suyo, o uno de la atención en la misma pieza) es de dolor, infección aguda o
 * trauma (`isUrgentDiagnosis`) y su tipo lo dejaría en la básica o la
 * quirúrgica. La urgencia sale del paciente, no del acto: la rehabilitadora
 * nunca se adelanta (la corona de una pieza con pulpitis va después de la
 * endodoncia). Es una propuesta: el odontólogo la mueve con «Planificar…».
 */
export function phaseForTreatment(
  kind: string | null | undefined,
  diagnoses: readonly PhaseDiagnosis[],
  /**
   * Su clave en la biblioteca: la apicectomía o un colgajo van en la quirúrgica, como cirugía, y la
   * corona sobre un implante en la rehabilitadora, como prótesis.
   */
  libraryKey?: string | null,
): TreatmentPhase {
  const phase = phaseForKind(
    isSurgicalLibraryKey(libraryKey) ? "cirugia" : kind === "implantologia" && isImplantProsthesisLibraryKey(libraryKey) ? "protesis" : kind,
  )
  if (phase !== "basica" && phase !== "quirurgica") return phase
  return diagnoses.some((diagnosis) => isUrgentDiagnosis(diagnosis.system, diagnosis.code)) ? "urgencia" : phase
}

export const TREATMENT_SCOPES = ["general", "tooth", "surfaces", "quadrant", "arch"] as const
export type TreatmentScope = (typeof TREATMENT_SCOPES)[number]

export interface TreatmentSiteInput {
  toothNumber?: number | null
  surfaces?: string[] | null
  quadrant?: number | null
  arch?: string | null
}

/**
 * Valida el sitio clínico según el ámbito. No deriva anatomía de etiquetas:
 * usa `isValidTooth` y `surfacesForTooth`. Lanza Error con mensaje en español.
 */
export function assertTreatmentSite(
  scope: TreatmentScope,
  site: TreatmentSiteInput,
  surfaceLimits?: { min: number | null; max: number | null },
): void {
  const { toothNumber = null, surfaces = null, quadrant = null, arch = null } = site
  const hasSurfaces = Array.isArray(surfaces) && surfaces.length > 0
  if (scope === "general") {
    if (toothNumber != null || hasSurfaces || quadrant != null || arch != null) {
      throw new Error("La prestación general no lleva pieza, superficies, cuadrante ni arcada")
    }
    return
  }
  if (scope === "tooth") {
    if (toothNumber == null || !Number.isInteger(toothNumber) || !isValidTooth(toothNumber)) {
      throw new Error("La prestación requiere una pieza FDI válida")
    }
    if (hasSurfaces || quadrant != null || arch != null) {
      throw new Error("La prestación por pieza no lleva superficies, cuadrante ni arcada")
    }
    return
  }
  if (scope === "surfaces") {
    if (toothNumber == null || !Number.isInteger(toothNumber) || !isValidTooth(toothNumber)) {
      throw new Error("La prestación requiere una pieza FDI válida")
    }
    if (!hasSurfaces) throw new Error("La prestación requiere al menos una superficie")
    const valid = new Set(surfacesForTooth(toothNumber))
    const seen = new Set<string>()
    for (const s of surfaces!) {
      if (seen.has(s)) throw new Error("Las superficies no deben repetirse")
      seen.add(s)
      if (!valid.has(s as never))
        throw new Error(`Superficie inválida para la pieza ${toothNumber}`)
    }
    const min = surfaceLimits?.min ?? null
    const max = surfaceLimits?.max ?? null
    if (min != null && seen.size < min)
      throw new Error(`La prestación requiere al menos ${min} superficie(s)`)
    if (max != null && seen.size > max)
      throw new Error(`La prestación admite como máximo ${max} superficie(s)`)
    if (quadrant != null || arch != null)
      throw new Error("La prestación por superficies no lleva cuadrante ni arcada")
    return
  }
  if (scope === "quadrant") {
    if (!Number.isInteger(quadrant) || (quadrant as number) < 1 || (quadrant as number) > 8) {
      throw new Error("La prestación requiere un cuadrante FDI de 1 a 8")
    }
    if (toothNumber != null || hasSurfaces || arch != null) {
      throw new Error("La prestación por cuadrante no lleva pieza, superficies ni arcada")
    }
    return
  }
  // arch
  if (arch !== "upper" && arch !== "lower") {
    throw new Error("La prestación requiere arcada superior o inferior")
  }
  if (toothNumber != null || hasSurfaces || quadrant != null) {
    throw new Error("La prestación por arcada no lleva pieza, superficies ni cuadrante")
  }
}
