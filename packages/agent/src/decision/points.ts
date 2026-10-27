import { answerOf, type DecisionQuestion, type DecisionResult } from "./port.js"
import { clinicWord, type ProductAgentTexts } from "@odentia/services"

/**
 * Primera ola de puntos de decisión, en modo sombra: se registran sin
 * actuar. Instrucciones y claves en inglés (idioma principal de los
 * proveedores) con el estado en español; versionadas para que un cambio
 * de redacción u orden de opciones invalide los umbrales calibrados.
 */
export const TRIAGE_VERSION = "triage.v5"

/** Las preguntas de cada mensaje, con las palabras del producto (odentIA: «dental clinic», la boca). */
export const triageQuestions = (texts: ProductAgentTexts): DecisionQuestion[] => [
  {
    id: "requires_reply",
    kind: "yesno",
    instructions: `Does the latest message from the contact need a reply from the ${clinicWord(texts, "en")}?`,
    criteria: { yes: "The contact asks something, requests something or expects an answer.", no: "A closing, thanks or acknowledgement that needs no reply." },
  },
  {
    id: "handoff",
    kind: "yesno",
    instructions:
      // Contar un síntoma para pedir cita no es pedir una persona (triage.v5): medido con
      // eval/sintomas-y-cita.json, la versión anterior derivaba a casi todo paciente con un síntoma.
      "Should a person from the clinic take over instead of the automated assistant? Yes if the contact asks for a human, complains or is upset, asks for clinical advice that only a professional can give (what to take, whether something is serious, what to do about a symptom, test results), or describes something that needs care right now: severe pain, bleeding that does not stop, swelling, high fever in a baby, chest pain, trouble breathing, an accident or distress. No if the contact mentions a symptom only to ask for an appointment, a price or availability: the assistant books that visit.",
  },
  {
    id: "urgency",
    kind: "score",
    instructions: "How urgent is the latest message from the contact?",
    levels: [
      { label: "low", description: "No time pressure: general information or a routine request." },
      { label: "medium", description: "Needs attention today: wants an appointment soon, follow-up or a change." },
      { label: "high", description: "Needs attention now: pain, bleeding, swelling, accident or distress." },
    ],
  },
  {
    id: "intent",
    kind: "choice",
    instructions: "What is the main intent of the latest message from the contact?",
    options: [
      { value: "appointment_request", description: "Wants to book an appointment or asks what dates or times are available." },
      { value: "reschedule_or_cancel", description: "Wants to move or cancel an existing appointment." },
      { value: "price_or_service_info", description: "Asks for general information about the clinic or how it works: prices, treatments offered, locations, hours, payment methods, instalments, insurance, parking, whether walk-ins are accepted or what to bring. A question to answer, not a request to book or to do something for them." },
      {
        value: "clinical_question",
        description:
          "Asks for clinical advice (what to take, whether it is serious, what to do about a symptom) or describes an emergency. Mentioning a symptom while asking for an appointment, a price or availability is not this: choose that request.",
      },
      { value: "complaint", description: "Complains about the service or the clinic." },
      { value: "unsubscribe", description: "Asks to stop receiving messages." },
      { value: "greeting_or_thanks", description: "Greeting, thanks or closing with no request." },
      // Medido con eval:off-topic (fuera-de-tema.json): con 0.9 atrapa todo lo ajeno sin marcar nada de la clínica.
      {
        value: "off_topic",
        description:
          `Unrelated to ${texts.care.scope ? `${texts.care.scope} or ` : ""}the clinic: cooking, homework, programming, sports, politics, general knowledge, translations, writing texts or jokes. Never use it for anything about ${texts.care.topics ? `${texts.care.topics}, ` : ""}the clinic's services, prices, payment, insurance, paperwork, access or appointments.`,
      },
      { value: "other", description: "None of the above or unclear." },
    ],
  },
  {
    id: "unsubscribe",
    kind: "yesno",
    instructions: "Does the contact ask the clinic to stop sending messages?",
  },
  // Spam (issue 77, ADR 0054): solo se aplica con `ROUTE_SPAM` y a quien puede
  // ir solo a Spam; lo que habla de la clínica nunca lo es (`readRoute`).
  {
    id: "spam",
    kind: "choice",
    instructions:
      "Is the latest message from the contact spam: unsolicited advertising, a scam, a chain message, an automatic reply from another business, or a company selling something to the clinic? A person writing for themselves is never spam.",
    options: [
      {
        value: "not_spam",
        description:
          `A person writing for themselves: about ${texts.care.body ? `${texts.care.body}, ` : ""}the clinic, appointments, prices, payments, a complaint, a greeting, a wrong number or anything personal. When in doubt, choose this.`,
      },
      { value: "advertising", description: "Mass advertising or offers from others: earn money, loans, investments, products or promotions." },
      { value: "scam", description: "Fraud or phishing: asks to pay or click a link for a package, prize, bank, account or delivery." },
      { value: "chain", description: "A chain message that asks to forward it to other people." },
      { value: "automated_reply", description: "An automatic reply or bot of another business: thanks for writing, we will reply soon; away messages; menus." },
      { value: "selling_to_clinic", description: "A company or agency offering its products or services to the clinic: websites, marketing, software, supplies or laboratories." },
    ],
  },
]

/** Antigüedad máxima de un entrante sin responder para contar como parte de la misma ráfaga. */
export const BURST_HORIZON_MS = 30 * 60_000
/** Mensajes seguidos del contacto que se leen juntos, contando el último. */
export const BURST_MESSAGES = 8

/**
 * Estado mínimo para el triaje: lo último que escribió el contacto y hasta dos
 * mensajes previos suyos. La gente escribe en varios mensajes seguidos y lo
 * importante puede estar en el primero: los mensajes sin responder de la misma
 * ráfaga (`burst`, del más antiguo al más reciente, sin el último) viajan
 * juntos y se leen como uno solo. No se añade nada de la ficha (nombre, notas,
 * teléfono) ni lo que escribió la clínica; el texto del contacto puede
 * contener lo que él mismo haya escrito.
 */
export function triageState(
  history: Array<{ direction: "in" | "out"; body: string | null }>,
  latest: string,
  burst: Array<string | null> = [],
): string {
  const previous = history
    .slice(-2)
    .map((m) => `${m.direction === "in" ? "Contact" : "Clinic"}: ${(m.body ?? "[attachment]").slice(0, 300)}`)
  const run = [...burst.slice(-(BURST_MESSAGES - 1)).map((body) => (body ?? "[attachment]").slice(0, 300)), latest.slice(0, 1000)]
  if (run.length === 1) return [...previous, `Contact (latest): ${run[0]}`].join("\n")
  return [
    ...previous,
    `Contact (latest, ${run.length} messages sent in a row; read them together as one message):`,
    ...run.map((text, index) => `${index + 1}. ${text}`),
  ].join("\n")
}

/** Qué habría hecho cada punto con umbrales ilustrativos; solo se registra. */
export function triageOutcome(result: DecisionResult): Record<string, unknown> {
  const reply = answerOf(result, "requires_reply", "yesno")
  const handoff = answerOf(result, "handoff", "yesno")
  const urgency = answerOf(result, "urgency", "score")
  const intent = answerOf(result, "intent", "choice")
  const unsubscribe = answerOf(result, "unsubscribe", "yesno")
  return {
    wouldSkipReply: reply ? reply.probability < 0.1 : null,
    wouldHandoff: handoff ? handoff.probability >= 0.7 : null,
    urgencyLevel: urgency ? Math.round(urgency.score) : null,
    intent: intent?.choice ?? null,
    wouldFlagUnsubscribe: unsubscribe ? unsubscribe.probability >= 0.7 : null,
  }
}
