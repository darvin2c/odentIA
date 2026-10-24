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
/** Una conversación solo está abierta o cerrada (`conversation.status`). */
const CONVERSATION_STATUS_LABELS: Record<string, string> = {
  open: "Abierta",
  closed: "Cerrada",
}

/** Motivo de cierre (`conversation.close_reason`), en las palabras de la interfaz. */
const CONVERSATION_CLOSE_REASON_LABELS: Record<string, string> = {
  resuelta: "Resuelta",
  sin_respuesta: "Sin respuesta del paciente",
  equipo: "Resuelta por el equipo",
  manual: "Cerrada sin resolver",
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
  cierre: CONVERSATION_CLOSE_REASON_LABELS,
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

/**
 * El estado de una conversación en la ficha: «Abierta», o «Cerrada · motivo»
 * con quién la cerró si fue una persona. Sin el motivo del servidor, solo «Cerrada».
 */
export function conversationStatusLabel(
  status: string,
  closure: { reason: string; byName: string | null } | null | undefined,
  /** Quien atiende las conversaciones: el agente de recepción de la clínica. */
  receptionName: string,
): string {
  const base = label("conversacion", status)
  if (status !== "closed" || !closure) return base
  if (closure.reason === "equipo" && closure.byName) return `${base} · resuelta por ${closure.byName}`
  if (closure.reason === "manual" && closure.byName) return `${base} · por ${closure.byName}`
  if (closure.reason === "resuelta") return `${base} · resuelta por ${receptionName}`
  const reason = label("cierre", closure.reason)
  return `${base} · ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`
}
