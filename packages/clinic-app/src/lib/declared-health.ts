/**
 * Las palabras de lo que dijo el paciente (mesa del 13 nov): una sola forma de
 * decirlo en la franja de la ficha y de la atención, Antecedentes, el aviso de
 * la atención y los cuestionarios. Qué sigue sin revisar, quién lo dijo y
 * cuándo lo decide el servidor (`PatientHealth.declared`, un grupo por
 * declaración; `FormResponse.respondent`): aquí solo se escribe. Nunca se
 * deduce quién fue por quién figura hoy como su representante.
 */
import {
  type HealthDeclarant,
  KINSHIP_LABELS,
  type PregnancyToday,
  saidNoWords,
  saidWhenWords,
  specificKin,
  whoWords,
} from "@odentia/clinical"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"
import type { DeclaredHealthGroup, PatientContactLink } from "./patients"

export type { HealthDeclarant }
// Quién lo dijo, en palabras: las mismas de la copia de la historia (`declared-words.ts` de `@odentia/clinical`).
export { saidNoWords, whoWords }

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
  return { kin: specificKin(kin) ?? "representante", name: guardian.displayName }
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
  return `${saidWhenWords(by, at ? shortDay(at) : "", sex)}, sin revisar`
}

/** «lo dijo ella», para una fila: «lo dijo ella · por revisar». */
export function saidByWords(by: HealthDeclarant, sex: Sex): string {
  if (by.kind === "staff") return "lo anotó el equipo"
  if (by.kind === "unknown") return "declarado"
  const who = whoWords(by, sex)
  return who ? `lo dijo ${who}` : "lo dijo"
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
  // Sin una semana de diferencia, «20 semanas hoy (20 el 14 nov)» repite el dato: se dice una vez y el día.
  if (pregnancy.weeksSaid === pregnancy.weeksToday)
    return { title: `Embarazo · ${weeksWords(pregnancy.weeksToday)}`, detail: `lo dijo el ${day}`, confirm: false }
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

/**
 * Lo que quedó sin revisar, en una línea para el cierre de la atención: «lo que
 * dijo ella de su salud el 13 nov». Informa y no frena la firma (QA del 14 nov,
 * H6 de clínica). null si no queda nada.
 */
export function unreviewedWords(groups: readonly DeclaredHealthGroup[] | undefined, sex: Sex): string | null {
  const parts = (groups ?? []).map((group) => {
    const day = group.at ? shortDay(group.at) : ""
    const when = day ? ` el ${day}` : ""
    if (group.by.kind === "staff") return `lo que anotó el equipo de su salud${when}`
    if (group.by.kind === "unknown") return `lo declarado de su salud${when}`
    const who = whoWords(group.by, sex)
    // Con quien habla por ella, su nombre va entre comas: «lo que dijo de su salud su madre, Carla, el 1 nov».
    if (who.includes(",")) return `lo que dijo de su salud ${who}${when ? `,${when}` : ""}`
    return `lo que dijo${who ? ` ${who}` : ""} de su salud${when}`
  })
  if (parts.length === 0) return null
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`
}

const INTERVIEW_ANSWER_WORDS: Record<string, string> = { si: "Sí", no: "No", no_sabe: "No sabe" }
const DECLARED_TOBACCO_WORDS: Record<string, string> = { nunca: "Nunca fumó", fuma: "Fuma", dejo: "Lo dejó" }
const DECLARED_CIGARETTE_WORDS: Record<string, string> = { menos_10: "menos de 10 al día", "10_o_mas": "10 o más al día" }

/**
 * Lo demás que dijo en una declaración, tal como llegó, en filas: el corazón, el antibiótico, la
 * anestesia, el tabaco, la lactancia y sus operaciones (QA del 14 nov: «Ver declaración original»
 * no lo traía). Lo que no respondió no sale.
 */
export function declaredInterviewRows(health: Record<string, unknown>): Array<{ label: string; value: string }> {
  const rec = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const dental = rec(health["dental"])
  const heart = rec(dental["corazon"])
  const medical = rec(health["medical"])
  const personal = rec(health["personal"])
  const answer = (value: unknown) => (typeof value === "string" ? (INTERVIEW_ANSWER_WORDS[value] ?? value) : null)
  const rows: Array<{ label: string; value: string | null }> = [
    { label: "Válvula, problema del corazón de nacimiento o endocarditis", value: answer(heart["riesgoEndocarditis"]) },
    { label: "Su médico le indicó antibiótico antes del dentista", value: answer(heart["antibioticoPrevio"]) },
    { label: "Problema con la anestesia o sangrado tras una extracción", value: answer(dental["problemaAnestesia"]) },
    {
      label: "Tabaco",
      value:
        typeof medical["tabaco"] === "string"
          ? [DECLARED_TOBACCO_WORDS[medical["tabaco"]] ?? medical["tabaco"], DECLARED_CIGARETTE_WORDS[String(medical["cigarrillos"])]]
              .filter(Boolean)
              .join(", ")
          : null,
    },
    { label: "Lactancia", value: typeof medical["lactancia"] === "boolean" ? (medical["lactancia"] ? "Sí" : "No") : null },
    { label: "Operaciones", value: typeof personal["cirugias"] === "string" && personal["cirugias"].trim() ? personal["cirugias"] : null },
    {
      label: "Hospitalizaciones",
      value: typeof personal["hospitalizaciones"] === "string" && personal["hospitalizaciones"].trim() ? personal["hospitalizaciones"] : null,
    },
    {
      label: "Transfusiones",
      value: typeof personal["transfusiones"] === "string" && personal["transfusiones"].trim() ? personal["transfusiones"] : null,
    },
  ]
  return rows.filter((row): row is { label: string; value: string } => row.value !== null)
}
