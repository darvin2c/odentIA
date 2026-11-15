/**
 * «¿Cambió algo en tu salud o en tus medicinas desde tu última visita?» (mesa de formularios del
 * 13 nov, entrega 10, decisión 5): antes de cada cita, si su última declaración de salud tiene más
 * de un mes. Las guías (ADA, AAPD) piden revisarlo en cada visita; el mes es un supuesto para no
 * preguntarlo en sesiones semanales, por confirmar con una clínica real. Con «No» queda anotado
 * que dijo que nada cambió, con su fecha; con «Sí» vuelve a responder su salud y sus medicinas.
 */

import type { RegistrationFieldKey } from "./patient-registration.js"

/** Cuántos meses de calendario pasan antes de volver a preguntarle. */
export const HEALTH_CHECK_AFTER_MONTHS = 1

/**
 * «Sí, cambió» abre «¿Qué cambió?» (revisión final de formularios, 15 nov, D3): sus medicinas, sus
 * enfermedades o sus alergias, y solo se le muestra eso. Antes volvía a responder todo, y quien
 * empezó una medicina pasaba por cuatro pasos en blanco. Lo de la salud que no es una enfermedad
 * pero cambia la atención (un embarazo, una operación, el corazón, la anestesia) va con «enfermedades».
 */
export const HEALTH_CHANGE_TOPICS = ["medicinas", "enfermedades", "alergias"] as const
export type HealthChangeTopic = (typeof HEALTH_CHANGE_TOPICS)[number]

/** Las preguntas de cada tema, con las claves del registro. */
export const HEALTH_CHANGE_TOPIC_KEYS: Record<HealthChangeTopic, readonly RegistrationFieldKey[]> = {
  medicinas: ["anticoagulants", "boneMedicines", "medications"],
  enfermedades: [
    "conditions",
    "dental.corazon",
    "dental.problemaAnestesia",
    "personal.embarazo",
    "personal.cirugias",
    "personal.hospitalizaciones",
    "personal.transfusiones",
    "medical.lactancia",
  ],
  alergias: ["allergies"],
}

/** De lo que la clínica pregunta (`questions`), lo de los temas que eligió. */
export function healthChangeQuestions(
  topics: readonly HealthChangeTopic[],
  questions: readonly RegistrationFieldKey[],
): RegistrationFieldKey[] {
  const wanted = new Set(topics.flatMap((topic) => HEALTH_CHANGE_TOPIC_KEYS[topic]))
  return questions.filter((key) => wanted.has(key))
}

/**
 * El mismo instante un mes de calendario después. Un día que el mes siguiente no tiene (31 de
 * enero) queda en su último día (28 o 29 de febrero): «un mes» nunca se alarga a dos.
 */
export function addCalendarMonths(at: Date, months: number): Date {
  const out = new Date(at.getTime())
  const day = out.getUTCDate()
  out.setUTCDate(1)
  out.setUTCMonth(out.getUTCMonth() + months)
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate()
  out.setUTCDate(Math.min(day, last))
  return out
}

/**
 * Si toca preguntarle: lo último que se supo de su salud (lo que dijo, también «nada cambió», o lo
 * que anotó el equipo) tiene más de un mes. Sin nada sabido no se le pregunta esto: lo que falta de
 * su salud se le pregunta aparte, dato por dato (entrega 6).
 */
export function healthCheckDue(lastSaidAt: Date | null, now: Date): boolean {
  if (!lastSaidAt) return false
  return now.getTime() > addCalendarMonths(lastSaidAt, HEALTH_CHECK_AFTER_MONTHS).getTime()
}

/** Por qué llega una declaración de salud: lo primero que dijo, que algo cambió, una corrección o que nada cambió. */
export const HEALTH_DECLARATION_REASONS = ["cambio", "correccion", "sin_cambios"] as const
export type HealthDeclarationReason = (typeof HEALTH_DECLARATION_REASONS)[number]
/**
 * Por qué llegó, en palabras: el título de «Declaración original» en la ficha y, en la copia de la
 * historia, el título y el motivo (`Provenance.reason`) de lo que volvió a responder.
 */
export const HEALTH_DECLARATION_REASON_LABELS: Record<HealthDeclarationReason, string> = {
  cambio: "Dijo que algo cambió en su salud o en sus medicinas",
  correccion: "Corrigió lo que había enviado",
  sin_cambios: "Dijo que nada cambió en su salud ni en sus medicinas",
}
