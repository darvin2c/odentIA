/**
 * Las palabras de lo que dijo el paciente (mesa del 13 nov): una sola forma de
 * decirlo en la franja de la ficha y de la atención, Antecedentes, el aviso de
 * la atención y los formularios. Qué es «dicho por la persona y sin revisar» lo
 * decide el servidor (`PatientHealth.declared`); aquí solo se nombra.
 */
import { KINSHIP_LABELS, type PregnancyToday } from "@odentia/clinical"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"
import type { PatientContactLink } from "./patients"

/** Quien decide por la persona cuando tiene representante: el preferido primero. */
export function guardianOf(
  contacts: readonly PatientContactLink[],
): { kin: string; name: string; firstName: string } | null {
  const [guardian] = contacts
    .filter((contact) => contact.isActive && contact.relationship === "guardian")
    .sort((a, b) => Number(b.isPreferred) - Number(a.isPreferred))
  if (!guardian) return null
  // El parentesco, el de HL7 si se conoce o el escrito al vincularlo.
  const kin =
    guardian.kinship && guardian.kinship in KINSHIP_LABELS
      ? KINSHIP_LABELS[guardian.kinship as keyof typeof KINSHIP_LABELS]
      : guardian.relationshipDetail?.trim()
  return {
    kin: (kin || "representante").toLocaleLowerCase("es"),
    name: guardian.displayName,
    firstName: guardian.displayName.trim().split(/\s+/)[0] ?? guardian.displayName,
  }
}

/**
 * A quién se le pregunta cuando la persona tiene representante (QA del 10 nov, B11): «su padre
 * (Luis Ríos)», como lo dice la ficha. Sin representante vigente, null: se le pregunta a ella.
 */
export function askWhom(contacts: readonly PatientContactLink[]): string | null {
  const guardian = guardianOf(contacts)
  return guardian ? `su ${guardian.kin} (${guardian.name})` : null
}

/** De quién se habla: su sexo registrado y quien decide por ella, si lo hay. */
export interface SaidBy {
  sex?: string | null
  contacts?: readonly PatientContactLink[]
}

/**
 * «ella», «él» o, con representante, «su madre, Carla»: quien lo dijo. Sin sexo
 * registrado no se supone ninguno (cadena vacía: «Lo dijo el 13 nov»).
 */
export function saidByWho({ sex, contacts = [] }: SaidBy): string {
  const guardian = guardianOf(contacts)
  if (guardian) return `su ${guardian.kin}, ${guardian.firstName}`
  return sex === "F" ? "ella" : sex === "M" ? "él" : ""
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

/** «Lo dijo ella el 13 nov, sin revisar», la marca única de lo declarado. */
export function declaredMarkWords(by: SaidBy, at: string | null | undefined): string {
  const who = saidByWho(by)
  const day = at ? shortDay(at) : ""
  // Con quien habla por ella, su nombre va entre comas: «Lo dijo su madre, Carla, el 13 nov, sin revisar».
  const subject = who ? ` ${who}${who.includes(",") && day ? "," : ""}` : ""
  return `Lo dijo${subject}${day ? ` el ${day}` : ""}, sin revisar`
}

/** «lo dijo ella», para una fila: «lo dijo ella · por revisar». */
export function saidByWords(by: SaidBy): string {
  const who = saidByWho(by)
  return who ? `lo dijo ${who}` : "lo dijo en línea"
}

/**
 * El «No» que marcó la persona: «Dijo que no», o «Su madre dijo que no» si
 * respondió quien decide por ella. No es el «niega» que anota quien se lo pregunta.
 */
export function saidNoWords(by: SaidBy): string {
  const guardian = guardianOf(by.contacts ?? [])
  return guardian ? `Su ${guardian.kin} dijo que no` : "Dijo que no"
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
