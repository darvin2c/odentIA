/**
 * Las palabras de lo que dijo el paciente (mesa del 13 nov): una sola forma de
 * decirlo en la franja de la ficha y de la atención, Antecedentes, el aviso de
 * la atención y los cuestionarios. Qué sigue sin revisar, quién lo dijo y
 * cuándo lo decide el servidor (`PatientHealth.declared`, un grupo por
 * declaración; `FormResponse.respondent`): aquí solo se escribe. Nunca se
 * deduce quién fue por quién figura hoy como su representante.
 */
import { type HealthDeclarant, KINSHIP_LABELS, type PregnancyToday } from "@odentia/clinical"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"
import type { DeclaredHealthGroup, PatientContactLink } from "./patients"

export type { HealthDeclarant }

/** Quien decide por la persona cuando tiene representante: el preferido primero. */
function guardianOf(contacts: readonly PatientContactLink[]): { kin: string; name: string } | null {
  const [guardian] = contacts
    .filter((contact) => contact.isActive && contact.relationship === "guardian")
    .sort((a, b) => Number(b.isPreferred) - Number(a.isPreferred))
  if (!guardian) return null
  // El parentesco, el de HL7 si se conoce o el escrito al vincularlo.
  const kin =
    guardian.kinship && guardian.kinship in KINSHIP_LABELS
      ? KINSHIP_LABELS[guardian.kinship as keyof typeof KINSHIP_LABELS]
      : guardian.relationshipDetail?.trim()
  return { kin: (kin || "representante").toLocaleLowerCase("es"), name: guardian.displayName }
}

/**
 * A quién se le pregunta cuando la persona tiene representante (QA del 10 nov, B11): «su padre
 * (Luis Ríos)», como lo dice la ficha. Sin representante vigente, null: se le pregunta a ella.
 * Es a quién preguntar hoy, no quién declaró algo antes: eso lo dice cada declaración.
 */
export function askWhom(contacts: readonly PatientContactLink[]): string | null {
  const guardian = guardianOf(contacts)
  return guardian ? `su ${guardian.kin} (${guardian.name})` : null
}

type Sex = string | null | undefined

/** «ella», «él» o, sin sexo registrado, nada: no se supone ninguno. */
const pronoun = (sex: Sex): string => (sex === "F" ? "ella" : sex === "M" ? "él" : "")

/**
 * Quién lo dijo, en palabras: «ella», «él», «su madre, Carla» o «el equipo».
 * Cadena vacía si lo dijo la persona y no se sabe su sexo, o si no consta
 * quién fue (lo anterior a guardarlo): la frase se arma sin sujeto.
 */
export function whoWords(by: HealthDeclarant, sex: Sex): string {
  if (by.kind === "patient") return pronoun(sex)
  if (by.kind === "staff") return "el equipo"
  if (by.kind === "unknown") return ""
  const first = by.name?.trim().split(/\s+/)[0] ?? ""
  if (by.relation && first) return `su ${by.relation}, ${first}`
  if (by.relation) return `su ${by.relation}`
  if (first) return first
  return sex === "F" ? "quien habla por ella" : sex === "M" ? "quien habla por él" : "quien habla en su nombre"
}

/**
 * «13 nov», y de otro año «13 nov 2025». Un día de calendario (`2026-11-13`) se
 * dice tal cual; un instante, en la zona de la clínica.
 */
export function shortDay(value: string, now: Date = new Date()): string {
  const calendarDay = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const date = new Date(calendarDay ? `${value}T12:00:00Z` : value)
  if (Number.isNaN(date.getTime())) return ""
  const timeZone = calendarDay ? "UTC" : activeOrgTimeZone()
  const year = (at: Date, zone: string) => at.toLocaleDateString("en", { year: "numeric", timeZone: zone })
  return date
    .toLocaleDateString(activeOrgLocale(), {
      day: "numeric",
      month: "short",
      ...(year(date, timeZone) === year(now, activeOrgTimeZone()) ? {} : { year: "numeric" }),
      timeZone,
    })
    .replace(/\./g, "")
}

/**
 * «Lo dijo ella el 13 nov, sin revisar», la marca de una declaración. Lo que
 * anotó el equipo porque se lo dijeron: «Lo anotó el equipo el 13 nov…»; lo que
 * no dice quién fue: «Declarado el 13 nov…».
 */
export function declaredMarkWords(by: HealthDeclarant, at: string | null | undefined, sex: Sex): string {
  const day = at ? shortDay(at) : ""
  const when = day ? ` el ${day}` : ""
  if (by.kind === "staff") return `Lo anotó el equipo${when}, sin revisar`
  if (by.kind === "unknown") return `Declarado${when}, sin revisar`
  const who = whoWords(by, sex)
  // Con quien habla por ella, su nombre va entre comas: «Lo dijo su madre, Carla, el 13 nov, sin revisar».
  const subject = who ? ` ${who}${who.includes(",") && day ? "," : ""}` : ""
  return `Lo dijo${subject}${when}, sin revisar`
}

/**
 * La marca de lo vigente que la persona volvió a responder sin nombrarlo (entrega 10): «Dijo que
 * cambió el 14 may», «Su madre, Carla, dijo que cambió el 14 may». No se borra: lo decide quien
 * la atiende.
 */
export function changedMarkWords(by: HealthDeclarant, at: string | null | undefined, sex: Sex): string {
  const day = at ? shortDay(at) : ""
  const when = day ? ` el ${day}` : ""
  if (by.kind !== "representative") return `Dijo que cambió${when}`
  const who = whoWords(by, sex)
  return `${who.replace(/^./, (letter) => letter.toLocaleUpperCase("es"))}${who.includes(",") ? "," : ""} dijo que cambió${when}`
}

/** «Dijo el 14 may que nada cambió en su salud ni en sus medicinas» (entrega 10). */
export function unchangedWords(by: HealthDeclarant, at: string, sex: Sex): string {
  const day = shortDay(at)
  const who = by.kind === "representative" ? whoWords(by, sex) : ""
  const subject = who ? `${who.replace(/^./, (letter) => letter.toLocaleUpperCase("es"))} dijo` : "Dijo"
  return `${subject}${day ? ` el ${day}` : ""} que nada cambió en su salud ni en sus medicinas`
}

/** «lo dijo ella», para una fila: «lo dijo ella · por revisar». */
export function saidByWords(by: HealthDeclarant, sex: Sex): string {
  if (by.kind === "staff") return "lo anotó el equipo"
  if (by.kind === "unknown") return "declarado"
  const who = whoWords(by, sex)
  return who ? `lo dijo ${who}` : "lo dijo"
}

/**
 * El «No» que marcó quien declaró: «Dijo que no», «Su madre dijo que no». No es
 * el «niega» que anota un profesional cuando se lo pregunta.
 */
export function saidNoWords(by: HealthDeclarant, sex: Sex): string {
  if (by.kind === "staff") return "El equipo anotó que no"
  if (by.kind === "representative") {
    const who = by.relation ? `su ${by.relation}` : whoWords(by, sex)
    return `${who.replace(/^./, (letter) => letter.toLocaleUpperCase("es"))} dijo que no`
  }
  return "Dijo que no"
}

type Topic = "allergies" | "conditions" | "medications"

/** La declaración que trajo esta fila y sigue sin revisar, si la hay. */
export function declaredGroupOf(
  groups: readonly DeclaredHealthGroup[] | undefined,
  topic: Topic,
  id: string | undefined,
): DeclaredHealthGroup | undefined {
  return id ? groups?.find((group) => group[topic].includes(id)) : undefined
}

/** La declaración que dijo «No» a este grupo y sigue sin revisar, si la hay. */
export function saidNoGroupOf(
  groups: readonly DeclaredHealthGroup[] | undefined,
  topic: Topic,
): DeclaredHealthGroup | undefined {
  return groups?.find((group) => group.saidNo[topic])
}

/** La declaración que dijo el embarazo y sigue sin revisar, si la hay. */
export function pregnancyGroupOf(groups: readonly DeclaredHealthGroup[] | undefined): DeclaredHealthGroup | undefined {
  return groups?.find((group) => group.pregnancy)
}

const weeksWords = (weeks: number): string => `${weeks} ${weeks === 1 ? "semana" : "semanas"}`

/**
 * El embarazo en palabras. En pie: «Embarazo · 32 semanas hoy» y «30 el 13 nov».
 * Pasado el término o sin fecha ya no se afirma: `confirm` pide preguntarle.
 */
export function pregnancyWords(pregnancy: PregnancyToday): { title: string; detail: string; confirm: boolean } {
  const day = pregnancy.saidOn ? shortDay(pregnancy.saidOn) : null
  if (pregnancy.state === "por_confirmar") {
    return {
      title: "Embarazo por confirmar",
      detail: day
        ? `lo dijo el ${day}${pregnancy.weeksSaid === null ? "" : `, con ${weeksWords(pregnancy.weeksSaid)}`}`
        : "anotado sin fecha",
      confirm: true,
    }
  }
  if (pregnancy.weeksToday === null)
    return { title: "Embarazo", detail: `lo dijo el ${day}, sin las semanas`, confirm: false }
  return {
    title: `Embarazo · ${weeksWords(pregnancy.weeksToday)} hoy`,
    detail: `${pregnancy.weeksSaid} el ${day}`,
    confirm: false,
  }
}

/** La misma línea para una insignia: «Embarazo · 32 semanas hoy (30 el 13 nov)». */
export function pregnancyChip(pregnancy: PregnancyToday): string {
  const words = pregnancyWords(pregnancy)
  return !words.confirm && pregnancy.weeksToday !== null
    ? `${words.title} (${words.detail})`
    : `${words.title} · ${words.detail}`
}
