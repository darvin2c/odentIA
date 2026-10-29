/**
 * Lo que una respuesta dice que se hizo: que el equipo lo verá o ya lo tiene, o
 * que quedó anotado. En las rondas de la auditoría del ADR 0104 Sofi decía
 * «recepción lo revisará» sin haberlo pasado y «ya lo anoté» sin anotar nada, y
 * el juez lo daba por falso. Solo reconoce las frases: si es cierto lo decide
 * quien llama, con lo que consta (`send_reply`).
 */

/** Sin tildes ni mayúsculas, con la puntuación: una frase termina en «.», «?» o «!». */
const plain = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019]/g, "'")

/** «Recepción revisará…», «el equipo te escribirá», «lo paso al equipo», «the team will check». */
const TEAM_WILL =
  /\b(recepcion|el equipo|nuestro equipo|una persona del equipo|un profesional|reception|the team|our team|someone from (the|our) team)\b[^.?!\n]{0,60}?\b(revisa|revisara|revisaran|vera|veran|te escribira|te escribiran|te contactara|te contactaran|te avisara|te avisaran|te confirmara|te confirmaran|te respondera|te responderan|continuara|will (check|review|look|get back|contact|reach out|let you know|confirm|follow up|be in touch|reply)|is (checking|reviewing|looking))\b/
const PASSED_ON =
  /\b(lo paso|te paso|se lo paso|lo pase|se lo pase|lo hice llegar|se lo hice llegar|lo deje con|i'll pass|i will pass|i've passed|i have passed)\b/
/** «Ya lo anoté», «tomé nota», «quedó anotado», «I've noted». */
const NOTED = /\b(anote|anotado|anotada|tome nota|i've noted|i have noted|i noted|i've made a note|i made a note)\b/

export function claimsOf(text: string): { team: boolean; note: boolean } {
  const said = plain(text)
  return { team: TEAM_WILL.test(said) || PASSED_ON.test(said), note: NOTED.test(said) }
}
