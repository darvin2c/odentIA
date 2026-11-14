/**
 * Quién dijo algo de la salud de la persona, en palabras (mesa del 13 nov): una
 * sola forma de decirlo en la ficha (`declared-health.ts` de las pantallas) y en
 * la copia de la historia. Quién fue y cuándo lo decide el servidor
 * (`HealthDeclarant`): aquí solo se escribe. El día llega ya dicho, porque cada
 * lugar lo escribe a su manera («13 nov» en la pantalla, la fecha entera en el papel).
 */
import type { HealthDeclarant } from "./health-review.js"

type Sex = string | null | undefined

/**
 * El parentesco, si dice cuál es. «Madre, padre o tutor» es la opción del
 * registro, no un parentesco: no se escribe «su madre, padre o tutor» ni se
 * inventa cuál de los tres fue (QA del 14 nov).
 */
const GENERIC_KIN = new Set(["madre, padre o tutor", "madre, padre o tutora", "representante"])
export function specificKin(relation: string | null | undefined): string | null {
  const kin = relation?.trim().toLocaleLowerCase("es")
  return kin && !GENERIC_KIN.has(kin) ? kin : null
}

/** «quien la cuida» (o «lo»), y sin sexo registrado, «su representante»: no se supone ninguno. */
const caregiver = (sex: Sex): string =>
  sex === "F" ? "quien la cuida" : sex === "M" ? "quien lo cuida" : "su representante"

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
  const kin = specificKin(by.relation)
  if (kin && first) return `su ${kin}, ${first}`
  if (kin) return `su ${kin}`
  // Eligió «Madre, padre o tutor» en el registro: quien la cuida, sin decir cuál de los tres.
  if (by.relation) return first ? `${caregiver(sex)}, ${first}` : caregiver(sex)
  if (first) return first
  return sex === "F" ? "quien habla por ella" : sex === "M" ? "quien habla por él" : "quien habla en su nombre"
}

/**
 * «Lo dijo ella el 13 nov», «Lo dijo su madre, Carla, el 13 nov». Lo que anotó
 * el equipo porque se lo dijeron: «Lo anotó el equipo el 13 nov»; lo que no dice
 * quién fue: «Declarado el 13 nov». `day`: el día ya en palabras, o vacío si no consta.
 */
export function saidWhenWords(by: HealthDeclarant, day: string, sex: Sex): string {
  const when = day ? ` el ${day}` : ""
  if (by.kind === "staff") return `Lo anotó el equipo${when}`
  if (by.kind === "unknown") return `Declarado${when}`
  const who = whoWords(by, sex)
  // Con quien habla por ella, su nombre va entre comas: «Lo dijo su madre, Carla, el 13 nov».
  const subject = who ? ` ${who}${who.includes(",") && day ? "," : ""}` : ""
  return `Lo dijo${subject}${when}`
}

/**
 * El «No» que marcó quien declaró: «Dijo que no», «Su madre dijo que no». No es
 * el «niega» que anota un profesional cuando se lo pregunta.
 */
export function saidNoWords(by: HealthDeclarant, sex: Sex): string {
  if (by.kind === "staff") return "El equipo anotó que no"
  if (by.kind === "representative") {
    const kin = specificKin(by.relation)
    const who = kin ? `su ${kin}` : by.relation ? caregiver(sex) : whoWords(by, sex)
    return `${who.replace(/^./, (letter) => letter.toLocaleUpperCase("es"))} dijo que no`
  }
  return "Dijo que no"
}
