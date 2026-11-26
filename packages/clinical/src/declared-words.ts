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
 * El parentesco, si dice cuál es. «Madre, padre o tutor» fue la opción del
 * registro hasta el 15 nov, no un parentesco: lo guardado así no se escribe «su
 * madre, padre o tutor» ni se inventa cuál de los tres fue (QA del 14 nov). Desde
 * entonces el registro guarda «Madre», «Padre» o «Tutor legal» (K15).
 */
const GENERIC_KIN = new Set(["madre, padre o tutor", "madre, padre o tutora", "representante"])

/**
 * Cómo se le habla a alguien, no su parentesco: Clío oía «señora, ¿tiene alguna enfermedad?» y
 * anotaba a la madre de un niño como «su señora» (QA del 21 nov). Tampoco las claves de quién habló.
 */
const NOT_KIN = new Set(["señora", "señor", "señorita", "seño", "doña", "don", "joven", "caballero", "dama", "usted", "dra", "paciente", "acompanante", "acompañante"])

/**
 * El parentesco que dijo Clío, si lo es: sin espacios de más, o vacío si es una forma de hablarle
 * («señora») o una clave («no_se_sabe»). Lo usan la propuesta de salud, los turnos y la pantalla.
 */
export function kinSaid(text: unknown): string {
  if (typeof text !== "string") return ""
  const kin = text.trim()
  const key = kin.toLocaleLowerCase("es").replace(/[.,;:]+$/u, "")
  if (!key || NOT_KIN.has(key) || /^no[\s_]*se[\s_]*sabe$/u.test(key)) return ""
  return kin
}
export function specificKin(relation: string | null | undefined): string | null {
  const kin = kinSaid(relation).toLocaleLowerCase("es")
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
  // Eligió «Madre, padre o tutor» en el registro de antes: quien la cuida, sin decir cuál de los tres.
  if (by.relation && GENERIC_KIN.has(by.relation.trim().toLocaleLowerCase("es"))) return first ? `${caregiver(sex)}, ${first}` : caregiver(sex)
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
 * Lo vigente que volvió a responder sin nombrarlo (entrega 10): «Dijo que cambió el 14 nov», «Su
 * madre, Carla, dijo que cambió el 14 nov». Las mismas palabras en la ficha y en la copia.
 * `day`: el día ya en palabras, o vacío si no consta.
 */
export function changedWhenWords(by: HealthDeclarant, day: string, sex: Sex): string {
  const when = day ? ` el ${day}` : ""
  if (by.kind !== "representative") return `Dijo que cambió${when}`
  const who = whoWords(by, sex)
  return `${who.replace(/^./, (letter) => letter.toLocaleUpperCase("es"))}${who.includes(",") ? "," : ""} dijo que cambió${when}`
}

/**
 * El «No» que marcó quien declaró: «Dijo que no», «Su madre dijo que no». No es
 * el «niega» que anota un profesional cuando se lo pregunta. Con `answer`, su
 * «No sé»: «Su madre dijo que no sabe», que tampoco es «no se le preguntó».
 */
export function saidNoWords(by: HealthDeclarant, sex: Sex, answer: "no" | "no sabe" = "no"): string {
  if (by.kind === "staff") return `El equipo anotó que ${answer}`
  if (by.kind === "representative") {
    const kin = specificKin(by.relation)
    const who = kin ? `su ${kin}` : by.relation ? caregiver(sex) : whoWords(by, sex)
    return `${who.replace(/^./, (letter) => letter.toLocaleUpperCase("es"))} dijo que ${answer}`
  }
  return `Dijo que ${answer}`
}

/**
 * La enfermedad que suele decirse con palabras de todos los días (QA clínica del 26 nov: «para la
 * presión» quedaba como la enfermedad «presión»): «presión», «presión alta» o «la presión» es la
 * hipertensión arterial; «el azúcar», la diabetes mellitus. Es solo una sugerencia que el profesional
 * elige: lo que se guarda sigue siendo lo dicho, y así lo comparan quitarlo por voz y lo ya guardado.
 * `null` si lo dicho no es una de ellas.
 */
export function everydayConditionOf(name: string): string | null {
  const said = name
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:para|de|por|problemas? de|algo de) /, "")
    .replace(/^(?:la|el|lo de la|lo del) /, "")
  if (/^(?:presion|presion alta|alta presion|presion arterial alta)$/.test(said)) return "Hipertensión arterial"
  if (/^(?:azucar|azucar alta|azucar en la sangre)$/.test(said)) return "Diabetes mellitus"
  return null
}
