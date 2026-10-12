import { answerOf, type DecisionQuestion, type DecisionResult } from "./port.js"

/**
 * Primera ola de puntos de decisión, en modo sombra: se registran sin
 * actuar. Instrucciones y claves en inglés (idioma principal de los
 * proveedores) con el estado en español; versionadas para que un cambio
 * de redacción u orden de opciones invalide los umbrales calibrados.
 */
export const TRIAGE_VERSION = "triage.v2"

export const TRIAGE_QUESTIONS: DecisionQuestion[] = [
  {
    id: "requires_reply",
    kind: "yesno",
    instructions: "Does the latest message from the contact need a reply from the dental clinic?",
    criteria: { yes: "The contact asks something, requests something or expects an answer.", no: "A closing, thanks or acknowledgement that needs no reply." },
  },
  {
    id: "handoff",
    kind: "yesno",
    instructions:
      "Should a person from the clinic take over instead of the automated assistant? Yes if the contact asks for a human, complains, is upset, or describes pain, bleeding, swelling or any clinical situation.",
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
      { value: "clinical_question", description: "Describes symptoms or asks for clinical advice." },
      { value: "complaint", description: "Complains about the service or the clinic." },
      { value: "unsubscribe", description: "Asks to stop receiving messages." },
      { value: "greeting_or_thanks", description: "Greeting, thanks or closing with no request." },
      { value: "other", description: "None of the above or unclear." },
    ],
  },
  {
    id: "unsubscribe",
    kind: "yesno",
    instructions: "Does the contact ask the clinic to stop sending messages?",
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
