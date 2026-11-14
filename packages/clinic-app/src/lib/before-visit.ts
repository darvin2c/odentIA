/**
 * Lo que ve recepción de «Antes de su cita» (mesa de formularios del 13 nov, entrega 10, C10):
 * «respondió el 13 nov» o «por responder», y cuándo se le envió su enlace. Nunca qué respondió:
 * eso lo lee el equipo clínico. Lo decide el servidor (`GET /api/patients/:id/personal-link/before-visit`,
 * con `patients.write`, como «Faltan datos»); aquí solo se escribe.
 */
import { apiFetch } from "./api"
import { shortDay } from "./declared-health"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"

export interface BeforeVisitStatus {
  appointmentId: string
  startsAt: string
  state: "respondio" | "por_responder"
  answeredAt: string | null
  linkSent: { at: string; channel: string } | null
}

export const beforeVisitKey = (patientId: string) => ["before-visit", patientId]

export function fetchBeforeVisit(patientId: string): Promise<{ data: BeforeVisitStatus | null }> {
  return apiFetch(`/api/patients/${patientId}/personal-link/before-visit`)
}

/** Por dónde salió, dicho como lo diría recepción; vacío si es otro canal. */
const CHANNEL_WORDS: Record<string, string> = {
  whatsapp: "por WhatsApp",
  email: "por correo",
  webchat: "por el chat de la web",
  telegram: "por Telegram",
  instagram: "por Instagram",
  messenger: "por Messenger",
}

/** «12 nov, 6:10 p. m.», en la zona de la clínica. */
function dayAndTime(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ""
  const time = date.toLocaleTimeString(activeOrgLocale(), { hour: "numeric", minute: "2-digit", timeZone: activeOrgTimeZone() })
  return `${shortDay(at)}, ${time}`
}

/**
 * La línea de la ficha: «Antes de su cita: respondió el 13 nov. Lo lee el equipo clínico.» o
 * «Antes de su cita: por responder · su enlace se le envió por WhatsApp el 12 nov, 6:10 p. m.».
 * Sin decir qué le falta («y su salud» ya diría algo de lo clínico).
 */
export function beforeVisitWords(status: BeforeVisitStatus): { state: string; detail: string } {
  if (status.state === "respondio")
    return {
      state: status.answeredAt ? `respondió el ${shortDay(status.answeredAt)}` : "respondió",
      detail: "Lo lee el equipo clínico.",
    }
  const sent = status.linkSent
  const via = sent ? CHANNEL_WORDS[sent.channel] : undefined
  return {
    state: "por responder",
    detail: sent
      ? `su enlace se le envió${via ? ` ${via}` : ""} el ${dayAndTime(sent.at)}`
      : "aún no se le envió su enlace",
  }
}
