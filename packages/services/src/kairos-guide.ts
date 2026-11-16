/**
 * Kairós le pregunta a Ariadna (ADR 0194): cuando quien todavía no usa la app
 * pregunta por una función («¿puedo firmar el consentimiento en la tablet?»),
 * Kairós busca en la guía de la Ayuda de ese producto, la misma que usa
 * Ariadna en la app, y responde con eso en su tono de venta. Ariadna no
 * escribe en los chats: toda la ayuda a una clínica que ya tiene su app se da
 * en Soporte, dentro de su app.
 *
 * Solo la guía: sin datos de ninguna clínica, sin pantalla y sin redactar
 * (quien redacta es Kairós). La pregunta viaja a Jev con el filtro de la Ayuda
 * (`withoutPersonData`); lo escrito igual que en la guía responde sin modelo.
 * Lo que la guía no tiene, o no está segura de tener, vuelve como «no está»:
 * Kairós no lo afirma.
 */
import { type ClinicalProduct, withoutPersonData } from "@odentia/clinical"
import { decideHelp, exactHelpOption } from "./help.js"
import { type HelpDecider, helpAnswerText } from "./help-decision.js"
import { agentTextsFor, helpTopicsFor } from "./products.js"

/** Lo que la guía dice de una función, o que no lo dice. */
export type KairosGuideAnswer =
  | { found: true; texts: string[]; topicIds: string[] }
  | { found: false; why: "no_esta" | "duda" | "sin_guia" }

/** Cuántas respuestas de la guía lee Kairós como mucho. */
const MAX_TEXTS = 3

/**
 * Busca en la guía del producto lo que pregunta quien está comprando. El decisor es el de la Ayuda
 * (Jev); sin él, solo lo escrito igual que en la guía responde.
 */
export async function askGuideForSale(
  product: ClinicalProduct,
  question: string,
  decider: HelpDecider | null,
): Promise<KairosGuideAnswer> {
  const asked = question.trim().slice(0, 500)
  if (!asked) return { found: false, why: "no_esta" }
  const topics = helpTopicsFor(product)
  const exact = exactHelpOption(asked, topics)
  if (exact) return { found: true, texts: [helpAnswerText(exact)], topicIds: [exact.topic.id] }
  // Como en la Ayuda: lo que parece el dato de una persona va sin correos ni cifras, y si aun así
  // lo parece, no viaja.
  const forModel = withoutPersonData(asked)
  if (forModel === null || !decider) return { found: false, why: "sin_guia" }
  let decided: Awaited<ReturnType<typeof decideHelp>>
  try {
    decided = await decideHelp(forModel, null, topics, agentTextsFor(product), decider)
  } catch {
    return { found: false, why: "sin_guia" }
  }
  // Sin Jev (falló, tardó o no respondió) `decideHelp` busca por palabras: eso no basta para afirmar.
  if (decided.via !== "jev") return { found: false, why: "sin_guia" }
  const { selection } = decided
  if (selection.verdict === "seguro" && selection.shown.length > 0) {
    const shown = selection.shown.slice(0, MAX_TEXTS)
    return {
      found: true,
      texts: shown.map((option) => helpAnswerText(option)),
      topicIds: [...new Set(shown.map((option) => option.topic.id))],
    }
  }
  return { found: false, why: selection.verdict === "duda" ? "duda" : "no_esta" }
}
