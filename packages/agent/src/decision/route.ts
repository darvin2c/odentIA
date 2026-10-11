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
export const ROUTE_VERSION = "route.v2"
export const ROUTE_QUESTIONS: DecisionQuestion[] = TRIAGE_QUESTIONS
/** Desde aquí se pasa el caso a una persona sin llamar al modelo que escribe. Punto de partida, por medir. */
export const ROUTE_HANDOFF = 0.85
/** Desde aquí se da por buena la intención y se acota el turno. */
export const ROUTE_INTENT = 0.6

export type RoutePath = "derivar" | "informacion" | "saludo" | "cita" | "cambio_cita" | "clinico" | "abierto"

export interface AgentRoute {
  path: RoutePath
  intent: string | null
  /** Probabilidad de que haga falta una persona; nulo si el proveedor no la entrega. */
  handoff: number | null
  /** Probabilidad de la intención elegida; nulo si el proveedor no entrega distribución. */
  confidence: number | null
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
  const handoff = handoffAnswer ? handoffAnswer.probability : null
  const intent = intentAnswer?.choice ?? null
  const confidence = intentAnswer?.probabilities ? (intentAnswer.probabilities[intentAnswer.choice] ?? null) : null
  if (handoff !== null && handoff >= ROUTE_HANDOFF) return { path: "derivar", intent, handoff, confidence }
  const path = intent !== null && confidence !== null && confidence >= ROUTE_INTENT ? (PATH_BY_INTENT[intent] ?? "abierto") : "abierto"
  return { path, intent, handoff, confidence }
}

/** Qué se decidió, para el libro de decisiones. Nunca lleva el texto del interlocutor. */
export function routeOutcome(route: AgentRoute): Record<string, unknown> {
  return { path: route.path, intent: route.intent, handoff: route.handoff, confidence: route.confidence }
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
  informacion: [...ALWAYS, "consultar_conocimiento", "ver_sedes_y_servicios"],
  saludo: [...ALWAYS],
  clinico: [...ALWAYS],
  cita: [
    ...ALWAYS, "ver_sedes_y_servicios", "consultar_conocimiento", "buscar_huecos", "proponer_cita", "confirmar_propuesta",
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

/** Motivo de la derivación por decisión, tal como lo ve el equipo. */
export const ROUTE_HANDOFF_REASON = "El mensaje pide a una persona o describe algo que el agente no debe atender"

/**
 * Lo que se le dice al modelo que escribe sobre el camino del turno. Va con lo
 * propio del turno, después de lo estable. Es una indicación: si el dato no
 * está, el modelo aún puede consultar, pedir el resto de herramientas
 * (ROUTE_TOOLS) o pasar el caso.
 */
export function routeInstruction(path: RoutePath, prefetched?: string | null): string | null {
  const head = "Camino de este turno, elegido por lo que escribió el interlocutor:"
  if (path === "informacion") {
    return `${head} pide información. Arriba ya tienes las sedes, los servicios con sus tarifas y las respuestas oficiales que aplican. Responde ahora con send_reply, en este mismo paso y sin llamar otras herramientas. Solo si el dato no está arriba, usa consultar_conocimiento una vez; si tampoco está, dilo y ofrece pasar el caso a una persona.`
  }
  if (path === "saludo") {
    return `${head} un saludo, un agradecimiento o un cierre. Responde en este mismo paso con send_reply, breve, sin consultar nada.`
  }
  if (path === "clinico") {
    return `${head} una consulta clínica. No des consejo clínico ni diagnóstico. En este mismo paso, pasa el caso a una persona con request_human_handoff y avisa al interlocutor en su campo message.`
  }
  if (path === "cambio_cita" && prefetched) {
    return `${head} cambiar o cancelar una cita. Esto se consultó ahora mismo y no hace falta volver a pedirlo:\n${prefetched}\nUsa los ids y las versiones exactos de ahí.`
  }
  return null
}
