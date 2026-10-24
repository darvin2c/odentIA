import { isAffirmative } from "@odentia/services"
import type { DecisionModel, DecisionQuestion } from "./decision/port.js"

/**
 * El sí del paciente a una propuesta (ADR 0023): se entiende la intención, no
 * una frase exacta. «Perfecto», «sí, gracias», «sí, por favor» o «confírmala»
 * los reconoce `isAffirmative` sin modelo; lo demás («me sirve, ahí estaré
 * el lunes») lo decide el modelo de decisión con esta pregunta. El modelo no
 * hace el acto: dice si la persona aceptó, y el servicio comprueba que ese
 * mensaje es suyo y posterior a la propuesta.
 */
export const CONFIRMS_QUESTION: DecisionQuestion = {
  id: "acepta_propuesta",
  kind: "yesno",
  instructions:
    "La clínica le propuso algo a esta persona y le pidió que lo confirme. ¿Su respuesta acepta lo propuesto, tal cual?",
  criteria: {
    yes: "Acepta lo propuesto, aunque lo diga con otras palabras: «perfecto», «sí, gracias», «sí, por favor», «me sirve», «ahí estaré», «resérvala».",
    no: "No acepta o no está claro: dice que no, pide otra cosa (otro horario, otro día, otro profesional), pone una condición, pregunta algo o habla de otro tema.",
  },
}
/** Por encima de esto se da por dicho el sí; por debajo, el agente vuelve a preguntar. */
export const CONFIRMS_MIN = 0.85

/** Lo que lee el modelo de decisión: lo que se le propuso y lo que respondió. */
export function confirmState(input: { proposed: string | null; reply: string }): string {
  return [
    `Lo que la clínica le propuso: «${(input.proposed ?? "una propuesta de la clínica").slice(0, 500)}»`,
    `Lo que respondió la persona: «${input.reply.slice(0, 400)}»`,
  ].join("\n")
}

/**
 * ¿La respuesta acepta la propuesta? Las palabras de siempre bastan; si no
 * bastan y la clínica tiene modelo de decisión, él lo decide. Sin modelo o si
 * falla, no se da por sí: el agente vuelve a preguntar, como antes.
 */
export async function understoodYes(
  decision: DecisionModel | null | undefined,
  input: { proposed: string | null; reply: string },
): Promise<boolean> {
  if (isAffirmative(input.reply)) return true
  if (!decision) return false
  try {
    const result = await decision.decide(confirmState(input), [CONFIRMS_QUESTION])
    const answer = result.answers.find((item) => item.id === CONFIRMS_QUESTION.id)
    return answer?.kind === "yesno" && answer.probability >= CONFIRMS_MIN
  } catch {
    return false
  }
}
