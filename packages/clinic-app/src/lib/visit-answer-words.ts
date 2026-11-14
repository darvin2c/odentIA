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
 * con su vínculo: «Lo que contó su madre, Carla, antes de venir (…)».
 */
export function visitToldHeading(answer: Pick<VisitAnswerView, "by" | "submittedAt" | "submittedVia">, patientFirstName: string | null): string {
  const when = `(${shortDay(answer.submittedAt)}, desde su ${answer.submittedVia === "portal" ? "portal" : "enlace"})`
  if (answer.by.kind === "representative") {
    const who = answer.by.relation
      ? `su ${answer.by.relation}${answer.by.name ? `, ${firstOf(answer.by.name)},` : ""}`
      : firstOf(answer.by.name) || "quien la acompaña"
    return `Lo que contó ${who} antes de venir ${when}`
  }
  return patientFirstName ? `Lo que contó ${patientFirstName} antes de venir ${when}` : `Lo que contó antes de venir ${when}`
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
