import { TRIAGE_QUESTIONS } from "./points.js"
import { answerOf, type DecisionQuestion, type DecisionResult } from "./port.js"

/**
 * Elegir el camino del turno antes de llamar al modelo que escribe. Una sola
 * llamada al modelo de decisión, con las mismas preguntas del triaje, sirve
 * para dos cosas: pasar el caso a una persona cuando está seguro de que hace
 * falta (sin gastar en el que escribe) y decirle al que escribe por dónde ir,
 * con los datos ya traídos, para que resuelva en un solo paso.
 *
 * Solo endurece o abarata: nunca ejecuta un acto por el interlocutor. Sin
 * probabilidades no hay certeza y el turno sigue por el camino abierto de
 * siempre. Versionado: cambiar preguntas u opciones invalida lo medido.
 */
export const ROUTE_VERSION = "route.v3"
export const ROUTE_QUESTIONS: DecisionQuestion[] = TRIAGE_QUESTIONS
/** Desde aquí se pasa el caso a una persona sin llamar al modelo que escribe. Punto de partida, por medir. */
export const ROUTE_HANDOFF = 0.85
/** Desde aquí se da por buena la intención y se acota el turno. */
export const ROUTE_INTENT = 0.6
/**
 * Lo que no es de la clínica se responde con un texto fijo, sin el modelo que
 * escribe, solo si el modelo de decisión está muy seguro: medido con
 * eval:off-topic, con 0.9 ningún mensaje de la clínica cae aquí. Si duda,
 * va al camino abierto.
 */
export const ROUTE_OFF_TOPIC = 0.9

export type RoutePath = "derivar" | "informacion" | "saludo" | "cita" | "cambio_cita" | "clinico" | "fuera_de_tema" | "abierto"

export interface AgentRoute {
  path: RoutePath
  intent: string | null
  /** Probabilidad de que haga falta una persona; nulo si el proveedor no la entrega. */
  handoff: number | null
  /** Probabilidad de la intención elegida; nulo si el proveedor no entrega distribución. */
  confidence: number | null
  /** Urgencia de 0 (sin apuro) a 2 (ahora); nulo si el proveedor no la entrega. */
  urgency: number | null
}

const PATH_BY_INTENT: Record<string, RoutePath> = {
  price_or_service_info: "informacion",
  greeting_or_thanks: "saludo",
  appointment_request: "cita",
  reschedule_or_cancel: "cambio_cita",
  clinical_question: "clinico",
}

export function readRoute(result: DecisionResult): AgentRoute {
  const handoffAnswer = answerOf(result, "handoff", "yesno")
  const intentAnswer = answerOf(result, "intent", "choice")
  const urgencyAnswer = answerOf(result, "urgency", "score")
  const urgency = urgencyAnswer ? urgencyAnswer.score : null
  const handoff = handoffAnswer ? handoffAnswer.probability : null
  const intent = intentAnswer?.choice ?? null
  const confidence = intentAnswer?.probabilities ? (intentAnswer.probabilities[intentAnswer.choice] ?? null) : null
  if (handoff !== null && handoff >= ROUTE_HANDOFF) return { path: "derivar", intent, handoff, confidence, urgency }
  if (intent === "off_topic") {
    return { path: confidence !== null && confidence >= ROUTE_OFF_TOPIC ? "fuera_de_tema" : "abierto", intent, handoff, confidence, urgency }
  }
  const path = intent !== null && confidence !== null && confidence >= ROUTE_INTENT ? (PATH_BY_INTENT[intent] ?? "abierto") : "abierto"
  return { path, intent, handoff, confidence, urgency }
}

/** Qué se decidió, para el libro de decisiones. Nunca lleva el texto del interlocutor. */
export function routeOutcome(route: AgentRoute): Record<string, unknown> {
  return { path: route.path, intent: route.intent, handoff: route.handoff, confidence: route.confidence, urgency: route.urgency }
}

/**
 * Herramientas que viajan al modelo que escribe en cada camino. El manual de
 * las herramientas es la mayor parte de lo que se envía en cada llamada: con
 * el camino elegido solo va el de las que ese camino usa. No es un permiso (lo
 * que el agente puede hacer lo fija su ficha): es lo que se le enseña en este
 * turno, y con WIDEN_TOOL recupera el resto si el camino se eligió mal. Los
 * caminos que no figuran aquí reciben todas.
 */
const ALWAYS = ["send_reply", "send_template", "request_human_handoff"] as const
export const ROUTE_TOOLS: Partial<Record<RoutePath, readonly string[]>> = {
  // El caso ya está derivado: solo queda el aviso, y nada más puede hacerse en este turno.
  derivar: ["request_human_handoff"],
  informacion: [...ALWAYS, "consultar_conocimiento", "ver_sedes_y_servicios", "buscar_en_la_clinica"],
  // Un agradecimiento o una despedida pueden cerrar la conversación (ADR 0024).
  saludo: [...ALWAYS, "despedirse_y_cerrar"],
  clinico: [...ALWAYS],
  cita: [
    ...ALWAYS, "ver_sedes_y_servicios", "buscar_en_la_clinica", "consultar_conocimiento", "buscar_huecos", "proponer_cita", "enviar_enlace_cita", "confirmar_propuesta",
    "ver_contexto_paciente", "ver_resumen_paciente", "anotar_caso", "recordar_dato",
  ],
  cambio_cita: [
    ...ALWAYS, "ver_sedes_y_servicios", "buscar_huecos", "reprogramar_cita", "cancelar_cita", "confirmar_propuesta",
    "ver_contexto_paciente", "ver_resumen_paciente", "anotar_caso",
  ],
}
/** Con esta herramienta el modelo que escribe pide el resto cuando el camino no alcanza. */
export const WIDEN_TOOL = "ampliar_herramientas"
/**
 * Lo que cada camino no trae, dicho con sus palabras: el modelo pide el resto
 * solo por eso. Nombrar aquí algo que el camino ya tiene (reservar, en el de
 * cita) hace que lo pida sin necesidad y pague el manual completo.
 */
const NOT_IN_PATH: Partial<Record<RoutePath, string>> = {
  informacion: "reservar, cambiar o cancelar una cita; registrar una oportunidad, una tarea o un seguimiento",
  saludo: "reservar, cambiar o cancelar una cita; consultar el conocimiento; registrar una oportunidad, una tarea o un seguimiento",
  clinico: "reservar, cambiar o cancelar una cita; consultar el conocimiento; registrar una oportunidad, una tarea o un seguimiento",
  cita: "cambiar o cancelar una cita que ya existe; registrar una oportunidad, una tarea o un seguimiento",
  cambio_cita: "reservar una cita nueva; consultar el conocimiento; registrar una oportunidad, una tarea o un seguimiento",
}
export function widenDescription(path: RoutePath): string {
  return `Este turno trae solo las herramientas del camino elegido, y con ellas se resuelve casi siempre. Llama a esta, sola en su paso, únicamente si lo que pide el interlocutor es otra cosa (${NOT_IN_PATH[path] ?? "algo que estas herramientas no cubren"}): en el siguiente paso tendrás todas.`
}

/**
 * Cómo llega al equipo un caso que el modelo de decisión pasó a una persona:
 * qué clase de caso es y con qué prioridad. La urgencia y la intención salen
 * de lo que la persona escribió; quien toma el caso puede cambiarlas. Un
 * reclamo nunca entra por debajo de «media».
 */
export function routeHandoff(route: AgentRoute): { reason: string; priority: "alta" | "media" | "baja" } {
  const urgent = route.urgency !== null && route.urgency >= 1.5
  const reason =
    route.intent === "complaint"
      ? "Reclamo"
      : route.intent === "clinical_question"
        ? urgent
          ? "Urgencia clínica"
          : "Consulta clínica"
        : urgent
          ? "Urgencia"
          : "Pide hablar con una persona"
  const priority = urgent ? "alta" : route.urgency !== null && route.urgency < 0.5 && route.intent !== "complaint" ? "baja" : "media"
  return { reason, priority }
}

/** Aviso que recibe la persona si el modelo que escribe no pudo redactar el suyo: nunca queda sin respuesta. */
/**
 * Varios mensajes seguidos nunca van por el camino «saludo». Medido: con «Quiero
 * cancelar mi cita… / Gracias» o «¿cuánto cuesta…? / gracias», el modelo de
 * decisión pesa demasiado el agradecimiento final y elige saludo, y en ese
 * camino el modelo que escribe recibe «responde breve, sin consultar nada»:
 * la cancelación o el precio quedarían sin atender. Es una regla del código,
 * no depende de que un modelo acierte.
 */
export function guardBurst(route: AgentRoute, messages: number): AgentRoute {
  return route.path === "saludo" && messages > 1 ? { ...route, path: "abierto" } : route
}

/**
 * Respuesta fija a lo que no es de la clínica: no se llama al modelo que
 * escribe (no se usa el agente como chat gratis) y siempre dice lo mismo.
 */
export function offTopicReply(treatment: "tu" | "usted" | null, persona: string | null, name: string): string {
  // Sin punto final propio: «S.A.C.» no deja «S.A.C..».
  const clinic = name.trim().replace(/\.+$/, "")
  const who = persona ? `Soy ${persona}, asistente virtual de ${clinic}` : `Soy el asistente virtual de ${clinic}`
  return treatment === "usted"
    ? `${who}. Solo puedo ayudarle con temas de la clínica: citas, tratamientos, precios o sedes. ¿En qué le ayudo?`
    : `${who}. Solo puedo ayudarte con temas de la clínica: citas, tratamientos, precios o sedes. ¿En qué te ayudo?`
}

export function handoffFallbackNotice(treatment: "tu" | "usted" | null): string {
  return treatment === "usted"
    ? "Recibimos su mensaje. Una persona del equipo le va a responder por aquí."
    : "Recibimos tu mensaje. Una persona del equipo te va a responder por aquí."
}

/**
 * Lo que se le dice al modelo que escribe sobre el camino del turno. Va con lo
 * propio del turno, después de lo estable. Es una indicación: si el dato no
 * está, el modelo aún puede consultar, pedir el resto de herramientas
 * (ROUTE_TOOLS) o pasar el caso.
 */
export function routeInstruction(path: RoutePath, prefetched?: string | null): string | null {
  const head = "Camino de este turno, elegido por lo que escribió el interlocutor:"
  if (path === "informacion") {
    return `${head} pide información. Arriba ya tienes las sedes, los servicios con sus tarifas, los medios de pago que acepta la clínica y las respuestas oficiales que aplican. Responde ahora con send_reply, en este mismo paso y sin llamar otras herramientas. Solo si el dato no está arriba, usa consultar_conocimiento una vez; si tampoco está, dilo y ofrece pasar el caso a una persona.`
  }
  if (path === "saludo") {
    return `${head} un saludo, un agradecimiento o un cierre. Responde en este mismo paso, breve, sin consultar nada: si agradece o se despide y no queda nada pendiente, despídete con despedirse_y_cerrar; si no, con send_reply.`
  }
  if (path === "derivar") {
    return `${head} el caso ya pasó a una persona del equipo y el equipo ya recibió el aviso. En este mismo paso llama a request_human_handoff solo para dejar en message el aviso al interlocutor (no se crea otra derivación; en reason y summary basta «Aviso al interlocutor»). En asks deja una frase con lo que la persona pide, solo con lo que ella dijo, y en pending lo que aún falta preguntarle o hacer para atenderla: es lo que leerá quien tome el caso. El aviso dice, con sus palabras y según lo que contó, que una persona del equipo continuará la atención y qué va a pasar ahora; no le pidas que repita lo que ya escribió; no des consejo clínico ni diagnóstico; no prometas una hora ni un plazo que no figure en este contexto (si aquí están el horario de atención o el teléfono de la sede y vienen al caso, puedes decirlos tal cual).`
  }
  if (path === "clinico") {
    return `${head} una consulta clínica. No des consejo clínico ni diagnóstico. En este mismo paso, pasa el caso a una persona con request_human_handoff y avisa al interlocutor en su campo message.`
  }
  if (path === "cita" && prefetched) {
    return `${head} reservar una cita. Esto se consultó ahora mismo y no hace falta volver a pedirlo (ni con ver_contexto_paciente ni con ver_resumen_paciente):\n${prefetched}\nLas sedes y los servicios, con sus ids, están arriba: no llames a ver_sedes_y_servicios para eso. Si el interlocutor aún no eligió un día y una hora concretos, busca con buscar_huecos y ofrécele dos o tres horarios en tu respuesta, sin reservar nada; proponer_cita va solo cuando ya eligió uno.`
  }
  if (path === "cambio_cita" && prefetched) {
    return `${head} cambiar o cancelar una cita. Esto se consultó ahora mismo y no hace falta volver a pedirlo:\n${prefetched}\nUsa los ids y las versiones exactos de ahí.`
  }
  return null
}
