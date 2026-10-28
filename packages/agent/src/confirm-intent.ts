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
    yes: "Acepta lo propuesto, aunque lo diga con otras palabras: «perfecto», «sí, gracias», «sí, por favor», «me sirve», «ahí estaré», «resérvala». Si acepta y además pregunta o comenta otra cosa («sí, resérvala; ¿y cuánto cuesta?»), también acepta.",
    no: "No acepta o no está claro: dice que no, pide otra cosa (otro horario, otro día, otro profesional), acepta solo si se cumple algo («si no cuesta más, sí»), o solo pregunta o habla de otro tema sin aceptar.",
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

/**
 * Quien ya escribió «resérvame mañana a las 2 con la Dra. Ana» dio su sí antes
 * de la propuesta (ADR 0097): se reserva sin volver a pedírselo. Solo lo
 * decide el modelo de decisión, y solo si pidió reservar esa misma cita; un
 * «¿qué horarios hay?» o un «a las 2 o a las 4» no es elegirla.
 */
export const CHOSE_QUESTION: DecisionQuestion = {
  id: "eligio_esa_cita",
  kind: "yesno",
  instructions:
    "La persona escribió esto antes de que la clínica le ofreciera una cita. ¿Ya pidió reservar exactamente esa cita?",
  criteria: {
    yes: "Pide que le reserven o separen esa cita y todo coincide: el día (si dice «hoy», «mañana» o un día de la semana, cuéntalo desde la fecha de hoy que trae la cita), la hora, el profesional y la sede si los nombró («con cualquiera» sirve cualquiera) y la persona («para mí» es quien escribe; si nombró a alguien, esa persona). Si además pregunta otra cosa (un precio, una promoción, si tiene costo), igual la pidió.",
    no: "Algo no coincide (otro día, otra hora, otro profesional, otra sede u otra persona), solo pregunta qué horarios hay, duda entre varias horas, la pide solo si se cumple algo («si no cuesta, sepárala»), o no dice día y hora. Ante la duda, no.",
  },
}

export async function choseThisSlot(
  decision: DecisionModel | null | undefined,
  input: { proposed: string; said: string },
): Promise<boolean> {
  if (!decision) return false
  try {
    const state = [
      `Lo que escribió la persona: «${input.said.slice(0, 600)}»`,
      `La cita que la clínica le va a ofrecer: «${input.proposed.slice(0, 400)}»`,
    ].join("\n")
    const result = await decision.decide(state, [CHOSE_QUESTION])
    const answer = result.answers.find((item) => item.id === CHOSE_QUESTION.id)
    return answer?.kind === "yesno" && answer.probability >= CONFIRMS_MIN
  } catch {
    return false
  }
}
