import { IMAGE_TYPE_LABELS, REPORT_STATUS_LABELS, SEX_LABELS } from "@odentia/clinical"
import { categoryLabel } from "../components/patient/document-labels"
import { channelLabel } from "./channels"
import {
  CONSENT_STATUS_LABELS,
  FIELD_TYPE_LABELS,
  FORM_RESPONSE_STATUS_LABELS,
  ORDER_STATUS_LABELS,
} from "./clinical-forms"
import { FOLLOW_UP_STATUS_LABELS, PRESCRIPTION_STATUS_LABELS } from "./clinical-journey"
import { DIAGNOSIS_STATUS_LABELS } from "./encounters"
import { APPOINTMENT_STATUS_LABELS } from "./patient-appointments"
import {
  ALLERGY_SEVERITY_LABELS,
  CONDITION_STATUS_LABELS,
  encounterStatusLabel,
  planStatusLabel,
} from "./patients"

/**
 * Glosario de la ficha: un solo lugar para traducir los códigos del dominio
 * (estados, tipos, categorías) a la terminología que ve el usuario. Reúne las
 * etiquetas de cada dominio; ningún código crudo debe llegar a la pantalla.
 */
const CONVERSATION_STATUS_LABELS: Record<string, string> = {
  open: "Abierta",
  pending: "Pendiente",
  snoozed: "Pospuesta",
  closed: "Cerrada",
  resolved: "Resuelta",
}

const DOMAINS = {
  alergia: ALLERGY_SEVERITY_LABELS,
  cita: APPOINTMENT_STATUS_LABELS as Record<string, string>,
  condicion: CONDITION_STATUS_LABELS,
  consentimiento: CONSENT_STATUS_LABELS as Record<string, string>,
  control: FOLLOW_UP_STATUS_LABELS as Record<string, string>,
  conversacion: CONVERSATION_STATUS_LABELS,
  diagnostico: DIAGNOSIS_STATUS_LABELS,
  campo: FIELD_TYPE_LABELS as Record<string, string>,
  formulario: FORM_RESPONSE_STATUS_LABELS as Record<string, string>,
  imagen: IMAGE_TYPE_LABELS as Record<string, string>,
  informe: REPORT_STATUS_LABELS as Record<string, string>,
  orden: ORDER_STATUS_LABELS as Record<string, string>,
  receta: PRESCRIPTION_STATUS_LABELS,
  sexo: SEX_LABELS as Record<string, string>,
} as const

export type GlossaryDomain =
  | keyof typeof DOMAINS
  | "atencion"
  | "canal"
  | "documento"
  | "tratamiento"

/** Último recurso: un código desconocido se muestra legible, nunca con guiones bajos. */
export function humanize(code: string): string {
  const text = code.replace(/[_-]+/g, " ").trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : code
}

export function label(domain: GlossaryDomain, code: string | null | undefined): string {
  if (!code) return "—"
  switch (domain) {
    case "atencion":
      return encounterStatusLabel(code)
    case "canal":
      return channelLabel(code)
    case "documento":
      return categoryLabel(code)
    case "tratamiento":
      return planStatusLabel(code)
    default: {
      const map: Record<string, string> = DOMAINS[domain]
      return map[code] ?? humanize(code)
    }
  }
}
