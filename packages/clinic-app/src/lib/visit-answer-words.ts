import { visitAnswerLine, visitPainWords } from "@odentia/clinical"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"
import type { VisitAnswerView } from "./patients"

/**
 * Cómo se dice lo que la persona contó antes de su cita (mesa del 13 nov, entrega 8), igual en
 * «Hoy viene a…», la atención firmada y la Historia: quién lo contó, cuándo y por dónde, y quién lo
 * vio al atender. Lo que contó, con `visitAnswerLine` de `@odentia/clinical`.
 */

/** «13 nov», en la zona de la clínica. */
function shortDay(iso: string): string {
  return new Date(iso)
    .toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", timeZone: activeOrgTimeZone() })
    .replace(".", "")
}

/** «lun 16 nov», en la zona de la clínica. */
function weekDay(iso: string): string {
  return new Date(iso)
    .toLocaleDateString(activeOrgLocale(), { weekday: "short", day: "numeric", month: "short", timeZone: activeOrgTimeZone() })
    .replace(/[.,]/g, "")
}

/**
 * «Para su cita del lun 16 nov»: lo contó para otra cita suya, no para la de esta atención (vino
 * sin cita, o antes de esa cita; QA final de formularios, 15 nov, H2).
 */
export function visitForAppointmentWords(answer: Pick<VisitAnswerView, "appointmentStartsAt">): string {
  return `Para su cita del ${weekDay(answer.appointmentStartsAt)}`
}

/** «3:02 p. m.», en la zona de la clínica. */
function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(activeOrgLocale(), { hour: "numeric", minute: "2-digit", timeZone: activeOrgTimeZone() })
}

/** El primer nombre de un nombre entero. */
function firstOf(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] ?? ""
}

/**
 * «Lo que contó Marta antes de venir (13 nov, desde su enlace)»; si lo contó quien decide por ella,
 * con su vínculo: «Lo que contó su madre, Carla, antes de venir (…)». Si lo contó para otra cita
 * suya (`otherAppointment`), lo dice primero: «Para su cita del lun 16 nov, Rosa contó (…)».
 */
export function visitToldHeading(
  answer: Pick<VisitAnswerView, "by" | "submittedAt" | "submittedVia" | "appointmentStartsAt"> & { otherAppointment?: boolean },
  patientFirstName: string | null,
): string {
  const when = `(${shortDay(answer.submittedAt)}, desde su ${answer.submittedVia === "portal" ? "portal" : "enlace"})`
  const who =
    answer.by.kind === "representative"
      ? answer.by.relation
        ? `su ${answer.by.relation}${answer.by.name ? `, ${firstOf(answer.by.name)},` : ""}`
        : firstOf(answer.by.name) || "quien la acompaña"
      : (patientFirstName ?? "")
  if (answer.otherAppointment) return `${visitForAppointmentWords(answer)}${who ? `, ${who}` : ""} contó ${when}`
  return who ? `Lo que contó ${who} antes de venir ${when}` : `Lo que contó antes de venir ${when}`
}

/** «lo vio Dra. Ana Torres al atender, 3:02 p. m.»; nulo si nadie lo vio aún en una atención. */
export function visitSeenWords(answer: Pick<VisitAnswerView, "seen">): string | null {
  return answer.seen ? `lo vio ${answer.seen.by} al atender, ${timeOf(answer.seen.at)}` : null
}

/** La línea de la Historia: lo que contó, cuándo lo envió y quién lo vio al atender. */
export function visitHistoryLine(answer: VisitAnswerView): string {
  return [
    visitAnswerLine(answer),
    `lo envió el ${shortDay(answer.submittedAt)}, ${timeOf(answer.submittedAt)}`,
    visitSeenWords(answer),
  ]
    .filter(Boolean)
    .join(" · ")
}

export { visitPainWords }
