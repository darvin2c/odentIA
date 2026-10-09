import { SEX_LABELS } from "@odentia/clinical"
/** Presentación del perfil/listado de pacientes (filtros, orden y anamnesis legible). */
import type { FilterDef, SortOption } from "@odentia/ui-patterns"
import type { Patient } from "./patients"

/** Fila del listado server: Patient + teléfono informativo. */
export interface PatientListRow extends Patient {
  phone: string | null
}

export const PATIENT_SORT_OPTIONS: SortOption[] = [
  { value: "name", label: "Nombre" },
  { value: "created", label: "Registro" },
  { value: "number", label: "HC" },
]

export const PATIENT_FILTERS: FilterDef[] = [
  {
    key: "isActive",
    label: "Estado",
    type: "select",
    options: [
      { value: "true", label: "Activos" },
      { value: "false", label: "Inactivos" },
    ],
  },
  {
    key: "sex",
    label: "Sexo",
    type: "select",
    options: [
      { value: "M", label: "Masculino" },
      { value: "F", label: "Femenino" },
    ],
  },
  {
    key: "docType",
    label: "Documento",
    type: "select",
    options: [
      { value: "DNI", label: "DNI" },
      { value: "CE", label: "CE" },
      { value: "PASAPORTE", label: "Pasaporte" },
      { value: "OTRO", label: "Otro" },
    ],
  },
]

export function sexLabel(sex: string | null | undefined): string {
  return sex && sex in SEX_LABELS ? SEX_LABELS[sex as keyof typeof SEX_LABELS] : "No registrado"
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
