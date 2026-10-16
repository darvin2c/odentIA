/**
 * Contratos de prestaciones y validación del sitio clínico.
 * La biblioteca oficial se importa por sistema, código y edición en la base
 * de datos; los nombres comerciales y precios pertenecen a cada clínica.
 */
import { isValidTooth, surfacesForTooth } from "./anatomy.js"

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
export type TreatmentSpecialty = (typeof TREATMENT_SPECIALTIES)[number]

/** Nombre de cada especialidad de la biblioteca, como lo lee una persona (el agente lo usa en su índice). */
export const TREATMENT_SPECIALTY_NAMES: Record<TreatmentSpecialty, string> = {
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
 * Fase propuesta por la especialidad del servicio; el clínico la cambia. La
 * urgencia nunca se infiere: es un juicio sobre el paciente, no sobre el acto.
 */
export function phaseForSpecialty(specialty: string | null | undefined): TreatmentPhase {
  switch (specialty) {
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

export const TREATMENT_SCOPES = ["general", "tooth", "surfaces", "quadrant", "arch"] as const
export type TreatmentScope = (typeof TREATMENT_SCOPES)[number]

/**
 * Snapshot congelado de codificaciones en plan/presupuesto/atención.
 * Se copia al indicar/cotizar/ejecutar; el histórico nunca sigue al mapeo vigente.
 */
export interface ProcedureCodingSnapshot {
  system: string
  code: string
  version: string
  display: string
}

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
