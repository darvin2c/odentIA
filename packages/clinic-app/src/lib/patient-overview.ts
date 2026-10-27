import { SEX_LABELS } from "@odentia/clinical"
/** Palabras de la ficha: sexo, categorías de documento y anamnesis legible. */

export function sexLabel(sex: string | null | undefined): string {
  return sex && sex in SEX_LABELS ? SEX_LABELS[sex as keyof typeof SEX_LABELS] : "No registrado"
}

/**
 * «atenderlo» o «atenderla» según la persona; sin sexo registrado, «atenderla»
 * (la persona). Lo mismo para cualquier verbo con el pronombre al final.
 */
export function attendWord(sex: string | null | undefined, verb = "atender"): string {
  return `${verb}${sex === "M" ? "lo" : "la"}`
}

export function documentCategoryLabel(category: string): string {
  if (category === "radiografia") return "Radiografía"
  if (category === "foto_clinica") return "Foto clínica"
  if (category === "consentimiento") return "Consentimiento"
  if (category === "receta") return "Receta"
  if (category === "informe") return "Informe"
  if (category === "otro") return "Otro"
  return category
}

const TOP_LABELS: Record<string, string> = {
  motivoConsulta: "Motivo de consulta",
  motivo: "Motivo de consulta",
  tiempoEnfermedad: "Tiempo de enfermedad",
  antecedentesFamiliares: "Antecedentes familiares",
  diagnosticoPresuntivo: "Diagnóstico presuntivo",
  diagnosticoCie10: "Códigos CIE-10",
  observaciones: "Observaciones",
}

const PERSONALES_LABELS: Record<string, string> = {
  enfermedades: "Enfermedades",
  hospitalizaciones: "Hospitalizaciones",
  cirugias: "Cirugías",
  transfusiones: "Transfusiones",
  medicacionHabitual: "Medicación habitual",
  embarazo: "Embarazo",
  semanasEmbarazo: "Semanas de embarazo",
}

const ODONTO_LABELS: Record<string, string> = {
  ultimaVisita: "Última visita",
  cepilladosAlDia: "Cepillados al día",
  experienciaPrevia: "Experiencia previa",
  ansiedadDental: "Ansiedad dental",
  hiloDental: "Hilo dental",
  bruxismo: "Bruxismo",
  habitos: "Hábitos",
}

const EXTRAORAL_LABELS: Record<string, string> = {
  atm: "ATM",
  ganglios: "Ganglios",
  labios: "Labios",
}

const INTRAORAL_LABELS: Record<string, string> = {
  encias: "Encías",
  lengua: "Lengua",
  paladar: "Paladar",
  pisoBoca: "Piso de boca",
  carrillos: "Carrillos",
  orofaringe: "Orofaringe",
}

const ENUM_LABELS: Record<string, string> = {
  positiva: "Positiva",
  regular: "Regular",
  traumatica: "Traumática",
  ninguna: "Ninguna",
  leve: "Leve",
  moderada: "Moderada",
  alta: "Alta",
  buena: "Buena",
  mala: "Mala",
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim()
  if (typeof value === "number") return String(value)
  if (typeof value === "boolean") return value ? "Sí" : "No"
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => scalarText(item))
      .filter((part): part is string => part !== null)
    return parts.length > 0 ? parts.join(", ") : null
  }
  return null
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
