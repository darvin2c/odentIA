import type { ProductAgentTexts } from "@odentia/services"
import { triageQuestions } from "./points.js"
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
export const ROUTE_VERSION = "route.v6"
export const routeQuestions = (texts: ProductAgentTexts): DecisionQuestion[] => triageQuestions(texts)
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
/**
 * Spam (ADR 0054): solo con el modelo de decisión muy seguro, y nunca si el
 * mensaje habla de la clínica o pide una persona. Por medir con `eval:spam`.
 */
export const ROUTE_SPAM = 0.9

/** Por qué es spam, con las claves de la persona (`contact.screen_reason`). */
export type DecidedSpamReason = "publicidad" | "estafa" | "cadena" | "respuesta_automatica" | "venta"
const SPAM_REASON_BY_OPTION: Record<string, DecidedSpamReason> = {
  advertising: "publicidad",
  scam: "estafa",
  chain: "cadena",
  automated_reply: "respuesta_automatica",
  selling_to_clinic: "venta",
}
/** Lo que habla de la clínica nunca es spam, aunque el modelo dude. */
const CLINIC_INTENTS = new Set(["appointment_request", "reschedule_or_cancel", "price_or_service_info", "clinical_question", "complaint", "unsubscribe"])

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
  /**
   * Probabilidad de que sea spam y su motivo (ADR 0054). Nulo si el proveedor
   * no la entrega, si habla de la clínica o si pide una persona: entonces no
   * es spam. Lo aplica la corrida, solo a quien puede ir solo a Spam.
   */
  spam?: { probability: number; reason: DecidedSpamReason } | null
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
  const spam = readSpam(result, intent, confidence, handoff)
  if (handoff !== null && handoff >= ROUTE_HANDOFF) return { path: "derivar", intent, handoff, confidence, urgency, spam }
  if (intent === "off_topic") {
    return { path: confidence !== null && confidence >= ROUTE_OFF_TOPIC ? "fuera_de_tema" : "abierto", intent, handoff, confidence, urgency, spam }
  }
  const path = intent !== null && confidence !== null && confidence >= ROUTE_INTENT ? (PATH_BY_INTENT[intent] ?? "abierto") : "abierto"
  return { path, intent, handoff, confidence, urgency, spam }
}

/**
 * La probabilidad de spam es todo lo que no es `not_spam`; el motivo, la
 * opción de spam más probable. Sin probabilidades no hay certeza: no es spam.
 * Lo que habla de la clínica o pide una persona tampoco, diga lo que diga.
 */
function readSpam(
  result: DecisionResult,
  intent: string | null,
  confidence: number | null,
  handoff: number | null,
): AgentRoute["spam"] {
  const answer = answerOf(result, "spam", "choice")
  const notSpam = answer?.probabilities?.not_spam
  if (!answer?.probabilities || notSpam === undefined) return null
  if (intent !== null && CLINIC_INTENTS.has(intent) && confidence !== null && confidence >= ROUTE_INTENT) return null
  if (handoff !== null && handoff >= ROUTE_HANDOFF) return null
  let best: { reason: DecidedSpamReason; p: number } | null = null
  for (const [option, p] of Object.entries(answer.probabilities)) {
    const reason = SPAM_REASON_BY_OPTION[option]
    if (reason && (!best || p > best.p)) best = { reason, p }
  }
  return best ? { probability: Math.max(0, Math.min(1, 1 - notSpam)), reason: best.reason } : null
}

/** Qué se decidió, para el libro de decisiones. Nunca lleva el texto del interlocutor. */
export function routeOutcome(route: AgentRoute): Record<string, unknown> {
  return {
    path: route.path,
    intent: route.intent,
    handoff: route.handoff,
    confidence: route.confidence,
    urgency: route.urgency,
    spam: route.spam ?? null,
  }
}

/**
 * Herramientas que viajan al modelo que escribe en cada camino. El manual de
 * las herramientas es la mayor parte de lo que se envía en cada llamada: con
 * el camino elegido solo va el de las que ese camino usa. No es un permiso (lo
 * que el agente puede hacer lo fija su ficha): es lo que se le enseña en este
 * turno, y con WIDEN_TOOL recupera el resto si el camino se eligió mal. Los
 * caminos que no figuran aquí reciben todas.
 */
// `recordar_tema`: con un tema abierto, la persona puede preguntar por él en cualquier camino (ADR 0050).
// El nombre que dice la persona se guarda en cualquier camino (objetivo de Sofi, ADR 0097).
const ALWAYS = ["send_reply", "request_human_handoff", "recordar_tema", "update_contact"] as const
export const ROUTE_TOOLS: Partial<Record<RoutePath, readonly string[]>> = {
  // El caso ya está derivado: solo queda el aviso, y nada más puede hacerse en este turno.
  // Con el caso ya en el equipo, lo que deja decir algo concreto: su cita y cómo comunicarse con la sede.
  // Y lo que sí puede hacer ella misma: «no me escriban más» llega con la queja (auditoría del ADR 0104).
  derivar: ["request_human_handoff", "ver_contexto_paciente", "ver_resumen_paciente", "ver_sedes_y_servicios", "elegir_mensajes"],
  // «¿Me mandas mi presupuesto?» o «prefiero la de la corona» se leen como una
  // pregunta de precios: el presupuesto de la persona va en este camino.
  informacion: [
    ...ALWAYS, "consultar_conocimiento", "ver_sedes_y_servicios", "buscar_en_la_clinica",
    "ver_presupuesto", "reenviar_presupuesto", "anotar_respuesta_presupuesto", "enviar_comprobante",
    // «Cambié de teléfono y no puedo entrar al portal»: se pide como información.
    "pedir_volver_al_portal",
    // «Ya no me manden promociones» se pide como información: elegir_mensajes (ADR 0040).
    "elegir_mensajes",
  ],
  // Un agradecimiento o una despedida pueden cerrar la conversación (ADR 0024).
  // «Sí, ahí estaré» a un recordatorio puede llegar como saludo: confirmar_cita la confirma.
  // «Sí» a la pregunta del permiso general tras reservar también: responder_permiso_mensajes.
  // «Ya no me manden recordatorios» como respuesta a uno: elegir_mensajes.
  saludo: [...ALWAYS, "despedirse_y_cerrar", "confirmar_cita", "responder_permiso_mensajes", "elegir_mensajes"],
  // Quien cuenta un problema sin pedir consejo recibe una cita, no un pase (ADR 0097).
  clinico: [...ALWAYS, "ver_sedes_y_servicios", "buscar_huecos", "proponer_cita", "reservar_paciente_nuevo", "enviar_enlace_cita", "confirmar_propuesta", "ver_contexto_paciente", "guardar_contacto"],
  cita: [
    ...ALWAYS, "ver_sedes_y_servicios", "buscar_en_la_clinica", "consultar_conocimiento", "buscar_huecos", "proponer_cita", "reservar_paciente_nuevo", "enviar_enlace_cita", "confirmar_propuesta", "confirmar_cita",
    "responder_permiso_mensajes", "elegir_mensajes", "ver_contexto_paciente", "ver_resumen_paciente", "anotar_caso", "recordar_dato", "guardar_contacto",
  ],
  cambio_cita: [
    ...ALWAYS, "ver_sedes_y_servicios", "buscar_huecos", "reprogramar_cita", "cancelar_cita", "confirmar_propuesta", "confirmar_cita",
    "elegir_mensajes", "ver_contexto_paciente", "ver_resumen_paciente", "anotar_caso",
  ],
}
/**
 * Las herramientas del camino con las que de verdad tiene el turno. Con
 * «Presupuestos» apagada, «¿me mandas mi presupuesto?» se atiende dejando una
 * tarea a recepción: `create_task` viaja en el camino «información».
 */
export function routeToolsFor(path: RoutePath, available: ReadonlySet<string>): readonly string[] | undefined {
  const base = ROUTE_TOOLS[path]
  if (!base) return undefined
  if (path === "informacion" && !available.has("ver_presupuesto") && available.has("create_task")) return [...base, "create_task"]
  return base
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
  saludo: "reservar, cambiar o cancelar una cita; consultar el conocimiento; reenviar su presupuesto o anotar su respuesta a uno; registrar una oportunidad, una tarea o un seguimiento",
  clinico: "reservar, cambiar o cancelar una cita; consultar el conocimiento; reenviar su presupuesto o anotar su respuesta a uno; registrar una oportunidad, una tarea o un seguimiento",
  cita: "cambiar o cancelar una cita que ya existe; reenviar su presupuesto o anotar su respuesta a uno; registrar una oportunidad, una tarea o un seguimiento",
  cambio_cita: "reservar una cita nueva; consultar el conocimiento; reenviar su presupuesto o anotar su respuesta a uno; registrar una oportunidad, una tarea o un seguimiento",
}
export function widenDescription(path: RoutePath): string {
  return `Para este mensaje tienes solo las herramientas del camino elegido, y con ellas se resuelve casi siempre. Llama a esta, sola en su paso, únicamente si lo que pide el interlocutor es otra cosa (${NOT_IN_PATH[path] ?? "algo que estas herramientas no cubren"}): en el siguiente paso tendrás todas.`
}

/**
 * Desde esta urgencia (de 0 a 2) un caso es urgente: prioridad alta y el aviso
 * da el teléfono para urgencias de la clínica. Medido con Jev el 2026-10-24,
 * tres veces por mensaje (`eval:urgencia-medica` y `decisiones-ejemplos.json`):
 * lo urgente sacó 1,92 o más en los dos productos, y lo que no lo es, como
 * máximo 1,62 en latidIA («me duele la espalda baja desde la semana pasada»,
 * que con 1,5 se marcaba urgente) y 1,27 en odentIA. 1,8 queda en medio.
 */
export const URGENT_SCORE = 1.8

/**
 * Cómo llega al equipo un caso que el modelo de decisión pasó a una persona:
 * qué clase de caso es y con qué prioridad. La urgencia y la intención salen
 * de lo que la persona escribió; quien toma el caso puede cambiarlas. Un
 * reclamo nunca entra por debajo de «media».
 */
export function routeHandoff(route: AgentRoute): { reason: string; priority: "alta" | "media" | "baja" } {
  const urgent = route.urgency !== null && route.urgency >= URGENT_SCORE
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
 * Responder a lo que se le preguntó no es saludar (ADR 0104). El modelo de
 * decisión solo lee lo que escribió la persona, nunca lo que dijo la clínica:
 * un «dale», «ok» o «sí» a «Tengo el martes a las 10 o a las 11, ¿cuál
 * prefieres?» le parece un agradecimiento, y en el camino «saludo» el que
 * escribe no tiene con qué reservar y recibe «responde breve, sin consultar
 * nada». Si lo último que salió de la clínica preguntaba algo, el turno va
 * por el camino abierto. Es una regla del código, como `guardBurst`.
 */
export function guardAnswer(route: AgentRoute, answersQuestion: boolean): AgentRoute {
  return route.path === "saludo" && answersQuestion ? { ...route, path: "abierto" } : route
}

/** ¿Lo que salió de la clínica le preguntaba algo? */
export function asksSomething(text: string | null | undefined): boolean {
  return Boolean(text?.includes("?"))
}

/**
 * Respuesta fija a lo que no es de la clínica: no se llama al modelo que
 * escribe (no se usa el agente como chat gratis) y siempre dice lo mismo.
 */
export function offTopicReply(treatment: "tu" | "usted" | null, persona: string, name: string, informs = true): string {
  // Sin punto final propio: «S.A.C.» no deja «S.A.C..».
  const clinic = name.trim().replace(/\.+$/, "")
  // Siempre con nombre: Sofi, o el que eligió la clínica (issue 183).
  const who = `Soy ${persona}, asistente virtual de ${clinic}`
  // Con «Informar» apagado no se ofrecen precios ni tratamientos: el agente no responde eso.
  const usted = treatment === "usted"
  const topics = informs
    ? "citas, tratamientos, precios o sedes"
    : usted
      ? "sus citas y lo que tenga pendiente con nosotros"
      : "tus citas y lo que tengas pendiente con nosotros"
  return usted
    ? `${who}. Solo puedo ayudarle con temas de la clínica: ${topics}. ¿En qué le ayudo?`
    : `${who}. Solo puedo ayudarte con temas de la clínica: ${topics}. ¿En qué te ayudo?`
}

/**
 * El aviso fijo al pasar un tema. En el chat web no se promete «por aquí»: si
 * cierra la pestaña no le llega; el chat le pide dónde avisarle (R4 del pulido).
 * Ante una urgencia empieza por a dónde llamar (`emergencyAdviceFor`, ADR 0084):
 * también cuando el modelo que escribe no pudo redactar el suyo.
 */
export function handoffFallbackNotice(
  treatment: "tu" | "usted" | null,
  channel: string | null = null,
  /** En el chat web: si el chat le pide dónde avisarle, si ya lo dejó o si se le responde ahí mismo. */
  where: "preguntar" | "ya_dejo" | "aqui" = "preguntar",
  emergency: string | null = null,
): string {
  const notice = teamNotice(treatment, channel, where)
  return emergency ? `${emergency} ${notice}` : notice
}

/**
 * Lo que recibe quien escribe cuando la clínica llegó a su presupuesto del mes
 * (D4 del cobro por tipo, ADR 0085): un texto fijo, sin la IA y sin cobro. En
 * el chat web se usa el aviso de siempre, que pide dónde avisarle.
 */
export function budgetNotice(clinic: string, treatment: "tu" | "usted" | null): string {
  return treatment === "usted"
    ? `Gracias por escribir a ${clinic}. En un momento le atiende alguien del equipo.`
    : `Gracias por escribir a ${clinic}. En un momento te atiende alguien del equipo.`
}

function teamNotice(treatment: "tu" | "usted" | null, channel: string | null, where: "preguntar" | "ya_dejo" | "aqui"): string {
  if (channel === "webchat") {
    const usted = treatment === "usted"
    if (where === "ya_dejo") {
      return usted
        ? "Recibimos su mensaje. Una persona del equipo le va a responder y le avisamos por donde nos dejó."
        : "Recibimos tu mensaje. Una persona del equipo te va a responder y te avisamos por donde nos dejaste."
    }
    if (where === "aqui") {
      return usted
        ? "Recibimos su mensaje. Una persona del equipo le va a responder en este chat."
        : "Recibimos tu mensaje. Una persona del equipo te va a responder en este chat."
    }
    return usted
      ? "Recibimos su mensaje. Una persona del equipo le va a responder: déjenos aquí abajo dónde avisarle."
      : "Recibimos tu mensaje. Una persona del equipo te va a responder: déjanos aquí abajo dónde avisarte."
  }
  return treatment === "usted"
    ? "Recibimos su mensaje. Una persona del equipo le va a responder por aquí."
    : "Recibimos tu mensaje. Una persona del equipo te va a responder por aquí."
}

/** Lo que el turno de verdad tiene, para que la indicación del camino no diga otra cosa. */
export interface RouteFacts {
  /** «Presupuestos» encendida (están sus herramientas). */
  budgets?: boolean
  /** Herramientas del turno; sin indicarlas se dan por todas las del camino. */
  tools?: ReadonlySet<string>
  /** Cómo van los servicios en el bloque de la clínica: con su id y precio, solo su índice o ninguno. */
  services?: "lista" | "indice" | "ninguno"
  /** «Informar» encendida. */
  informs?: boolean
  /**
   * Lo que escribió es urgente (ADR 0084): con una señal de alarma, el aviso
   * empieza por el número de emergencias; si no, por el teléfono para
   * urgencias de la clínica.
   */
  urgency?: "alarma" | "urgente" | null
  /** Lo urgente empieza por el teléfono para urgencias de la clínica y no por la hora (`ProductAgentTexts.urgentFirst`). */
  urgentFirst?: "telefono"
  /**
   * Cómo va la cita en esta atención (ADR 0104): la indicación dice lo que
   * falta, no repite lo que ya se hizo. Lo arma `attentionProgress`.
   */
  progress?: RouteProgress
  /** Vuelve sobre un tema que ya tiene el equipo: ya recibió un aviso y no se le repite (ADR 0104). */
  again?: boolean
  /**
   * Lo que ya se le dijo en esta atención (`attentionProgress`): el número de emergencias y el
   * teléfono para urgencias de la clínica, cada uno por su lado. El aviso no vuelve a empezar por lo
   * ya dicho, pero una alarma sin el número de emergencias dicho lo sigue dando.
   */
  calledOut?: { emergency: boolean; clinic: boolean }
}

/** Cómo va la cita en esta atención, con el texto con que se nombra cada paso. */
export interface RouteProgress {
  /** Ya buscó y ofreció horarios en esta atención. */
  offered?: boolean
  /** Lo que espera su sí. */
  pending?: string | null
  /** Lo que ya quedó hecho con su cita en esta atención. */
  done?: string | null
}

/**
 * El paso que falta para la cita, según cómo va (ADR 0104): nunca «ofrécele
 * horarios» cuando ya se los ofreció, ni «reserva» cuando ya quedó reservada.
 * `propose` nombra la herramienta con que se propone.
 */
function appointmentStep(progress: RouteProgress | undefined, propose: string): string {
  if (progress?.done) {
    return `En esta atención ya quedó hecho: ${progress.done}. No se la vuelvas a ofrecer ni a confirmar; si pide otra cita, es una nueva.`
  }
  if (progress?.pending) {
    return `Ya hay una cita propuesta que espera su sí (${progress.pending}): si su último mensaje es un sí, confírmala con confirmar_propuesta; si pidió otro día, hora, sede o profesional, busca y propón eso.`
  }
  if (progress?.offered) {
    return `Ya le ofreciste horarios en esta atención (están en las consultas de mensajes anteriores): si eligió uno, propónselo con ${propose} usando ese hueco exacto; si pide otro día, sede o profesional, busca de nuevo. No le repitas los mismos horarios.`
  }
  return `Si aún no eligió un día y una hora concretos, busca con buscar_huecos y ofrécele dos o tres horarios en tu respuesta, sin reservar nada; ${propose} va solo cuando ya eligió uno.`
}

/**
 * Lo que se le dice al modelo que escribe sobre el camino del turno. Va con lo
 * propio del turno, después de lo estable. Es una indicación: si el dato no
 * está, el modelo aún puede consultar, pedir el resto de herramientas
 * (ROUTE_TOOLS) o pasar el caso. Se arma con lo que el turno recibe de verdad
 * (`RouteFacts`): nunca dice «arriba tienes» algo que no está ni nombra una
 * herramienta que no tiene.
 */
export function routeInstruction(path: RoutePath, prefetched?: string | null, facts: RouteFacts = {}): string | null {
  const head = "Camino para este mensaje, elegido por lo que escribió el interlocutor:"
  const has = (name: string) => (facts.tools ? facts.tools.has(name) : true)
  const informs = facts.informs !== false
  const services = facts.services ?? "lista"
  if (path === "informacion") {
    // Con «Presupuestos» apagada no se nombran herramientas que no tiene: deja la tarea a recepción.
    const budgets =
      facts.budgets === false
        ? has("create_task")
          ? " Si pide su propio presupuesto o responde a uno, deja una tarea a recepción con create_task (por ejemplo «Lucía pidió su presupuesto: enviarlo») y dile que el equipo se encargará."
          : ""
        : " Si pide su propio presupuesto o responde a uno (qué acepta, qué deja para después), usa ver_presupuesto y después reenviar_presupuesto o anotar_respuesta_presupuesto."
    if (!informs) {
      return `${head} pide información. «Informar» está apagada: no respondes precios, servicios, promociones ni horarios de atención. Pasa el caso a una persona con request_human_handoff y avísale en message.${budgets}`
    }
    const above = [
      "las sedes",
      services === "lista" ? "los servicios con cómo decir su precio" : null,
      "los medios de pago que acepta la clínica",
      "las respuestas oficiales (o su índice)",
    ].filter((item): item is string => item !== null)
    const listed = `${above.slice(0, -1).join(", ")} y ${above[above.length - 1]}`
    const search =
      services === "indice" && has("buscar_en_la_clinica")
        ? " De los servicios, arriba va solo el índice, sin precios: si pregunta por uno, búscalo antes con buscar_en_la_clinica y responde con lo que encuentres; nunca digas que la clínica no lo ofrece sin haberlo buscado."
        : services === "ninguno"
          ? " La clínica no tiene servicios cargados: no des precios de tratamientos."
          : ""
    const knowledge = has("consultar_conocimiento")
      ? " Si un tema está solo en el índice o su respuesta aparece recortada, pide su texto con consultar_conocimiento antes de citarla. Si un dato no está arriba ni en lo que buscaste, usa consultar_conocimiento una vez; si tampoco está, pásalo al equipo con request_human_handoff y dile en message que se lo confirman por aquí."
      : " Si un dato no está arriba, pásalo al equipo con request_human_handoff y dile en message que se lo confirman por aquí."
    return `${head} pide información. Arriba ya tienes ${listed}.${search} Si con eso basta, responde ahora con send_reply, en este mismo paso.${knowledge}${budgets}`
  }
  if (path === "saludo") {
    return `${head} un saludo, un agradecimiento o un cierre. Responde en este mismo paso, breve, sin consultar nada: si agradece o se despide y no queda nada pendiente, despídete con despedirse_y_cerrar; si no, con send_reply.`
  }
  if (path === "derivar") {
    // A dónde llamar ante una urgencia (ADR 0084): el número de emergencias solo
    // con una señal de alarma; si no, el teléfono para urgencias de la clínica.
    // Ya dicho en esta atención, no se repite en cada respuesta (auditoría del ADR 0104).
    const urgent =
      facts.urgency === "alarma"
        ? facts.calledOut?.emergency
          ? " Su vida puede estar en peligro, y ya le dijiste en esta atención a dónde llamar o ir: no le repitas ese aviso. Responde a lo nuevo que dijo; si pregunta si debe ir a la emergencia, dile que sí, que vaya ahora a la más cercana."
          : " Su vida puede estar en peligro: el aviso empieza diciéndole, tal cual figura en lo que sabes de la clínica, a qué número de emergencias llamar ahora o que vaya a la emergencia más cercana, y el teléfono para urgencias de la clínica si figura."
        : facts.urgency === "urgente"
          ? `${facts.calledOut?.clinic ? " Es urgente, y ya le diste en esta atención el teléfono para urgencias de la clínica: no se lo repitas salvo que te lo pida." : " Es urgente: si figura en lo que sabes de la clínica, el aviso empieza dándole el teléfono para urgencias de la clínica."} No le digas que llame al número de emergencias del país salvo que lo que contó ponga en peligro su vida (dolor de pecho, falta de aire, un sangrado que no para, un desmayo, una hinchazón que no le deja respirar o tragar); si podría llegar a eso, puedes decirle que, si pasa, vaya a la emergencia más cercana.`
          : ""
    return `${head} el caso ya pasó a una persona del equipo y el equipo ya recibió el aviso. En este mismo paso llama a request_human_handoff solo para dejar en message el aviso al interlocutor (no se crea otra derivación; en reason y summary basta «Aviso al interlocutor»). En asks deja una frase con lo que la persona pide, solo con lo que ella dijo, y en pending lo que aún falta preguntarle o hacer para atenderla: es lo que leerá quien tome el caso.${urgent} El aviso dice, con sus palabras y según lo que contó, que una persona del equipo continuará la atención y qué va a pasar ahora, y le da algo concreto cuando lo hay: si es sobre una cita suya, revísala antes con ver_resumen_paciente y dile lo que ves; si pide hablar con alguien ya, el teléfono de la sede (ver_sedes_y_servicios) si figura;${
      has("elegir_mensajes") ? " si pide que no le escriban más o dejar de recibir un tipo de mensaje, anótalo antes con elegir_mensajes y díselo en el aviso;" : ""
    }${
      // Solo cuando vuelve sobre un tema que ya tiene el equipo (ADR 0104): ya recibió un aviso.
      // «Y que se lo hiciste llegar al equipo» salía en cada insistencia: «ya anoté…», «ya hice
      // llegar al equipo…» una y otra vez (auditoría del ADR 0104). Lo que vuelve a escribir ya
      // le llega al equipo con el tema.
      facts.again
        ? " ya le avisaste en esta atención que lo tiene el equipo, y lo que vuelve a escribir le llega con el tema: no le repitas que lo tiene el equipo, que lo anotaste ni que se lo hiciste llegar; responde en una línea a lo nuevo que dijo o preguntó y, si no hay nada nuevo, dale algo concreto que aún no le diste (el teléfono de la sede, el horario de atención);"
        : ""
    } si además pregunta algo que está en lo que sabes de la clínica (un precio, cuánto dura, una sede), respóndelo en el mismo aviso; si para resolverlo el equipo necesitará un dato que puede darte ahora (su nombre completo, la fecha de su atención) y aún no lo tienes, pídeselo en el mismo aviso; no le pidas que repita lo que ya escribió; no des consejo clínico ni diagnóstico; no prometas una hora ni un plazo que no figure en este contexto (si aquí están el horario de atención o el teléfono de la sede y vienen al caso, puedes decirlos tal cual); el vencimiento de una tarea es un plazo interno del equipo, no una hora de respuesta para la persona.`
  }
  // Con qué se propone la cita: a quien aún no es paciente, su enlace con la hora elegida (ADR 0109).
  const propose = has("reservar_paciente_nuevo") ? "proponer_cita (o reservar_paciente_nuevo, si aún no es paciente)" : "proponer_cita"
  const progress = facts.progress
  if (path === "clinico") {
    // Jev marca «clínico» también a quien solo cuenta un problema («tengo un problema en el
    // diente»): pasarlo sin preguntar lo dejaba sin atención (ADR 0097). Solo el consejo va al equipo.
    // Si ya se le ofreció la cita, volver a contarlo no es empezar de cero (ADR 0104).
    const started = Boolean(progress?.offered || progress?.pending || progress?.done)
    const problem = started && has("buscar_huecos")
      ? ` Si solo vuelve sobre lo que le pasa, sin pedir consejo, ya le ofreciste la cita en esta atención: no le preguntes otra vez qué le pasa y sigue con la cita. ${appointmentStep(progress, propose)}`
      : // «Pregúntale qué le pasa» se lo preguntaba también a quien ya lo había contado (auditoría del ADR 0104).
        ` Si solo cuenta un problema o un síntoma sin pedir consejo, no lo pases: ofrécele una cita${has("buscar_huecos") ? " con los horarios más próximos (buscar_huecos)" : ""} y, solo si aún no dijo qué le pasa, pregúntaselo en una línea.`
    return `${head} puede ser una consulta clínica. No des consejo clínico ni diagnóstico. Si pide un consejo (qué tomar, si es grave, qué hacer), pasa el caso a una persona con request_human_handoff y avísale en message${has("buscar_huecos") ? "; si además quiere cita, búscale horarios antes y ofréceselos en ese aviso" : ""}.${problem}`
  }
  if (path === "cita" && !has("buscar_huecos")) {
    // Con «Agendar» apagado no hay huecos ni propuestas: la cita la elige la persona en su enlace.
    return has("enviar_enlace_cita")
      ? `${head} reservar una cita. Por aquí no reservas: envíale su enlace con enviar_enlace_cita para que elija el día y la hora, y díselo con send_reply.`
      : `${head} reservar una cita. Por aquí no reservas ni tienes su enlace: pasa el caso a una persona con request_human_handoff y avísale en message.`
  }
  if (path === "cambio_cita" && !has("reprogramar_cita") && !has("cancelar_cita")) {
    return `${head} cambiar o cancelar una cita. Por aquí no mueves ni cancelas citas: pasa el caso a una persona con request_human_handoff y avísale en message.`
  }
  if (path === "cita") {
    const ids =
      services === "lista"
        ? "Las sedes y los servicios, con sus ids, están arriba: no llames a ver_sedes_y_servicios para eso."
        : services === "indice" && has("buscar_en_la_clinica")
          ? "Las sedes, con su id, están arriba; de los servicios va solo el índice: si ya sabe qué servicio quiere, búscalo con buscar_en_la_clinica para tener su id y pásalo a buscar_huecos, así el hueco dura lo que dura ese servicio."
          : "Las sedes, con su id, están arriba. Sin el id del servicio, buscar_huecos usa la duración de una cita regular."
    const consulted = prefetched
      ? ` Esto se consultó ahora mismo y no hace falta volver a pedirlo (ni con ver_contexto_paciente ni con ver_resumen_paciente):\n${prefetched}\n`
      : " "
    return `${head} reservar una cita.${consulted}${ids} ${appointmentStep(progress, propose)}${
      // Un síntoma que no espera pide la hora más próxima, no el equipo (ADR 0095).
      facts.urgency === "urgente" && !progress?.done
        ? facts.calledOut?.clinic
          ? " Lo que cuenta no puede esperar: ofrécele el horario más próximo, hoy si hay; ya le diste en esta atención el teléfono para urgencias de la clínica, no se lo repitas. No pases el caso al equipo por eso."
          : facts.urgentFirst === "telefono"
          ? " Lo que cuenta no puede esperar: dale primero el teléfono para urgencias de la clínica, si figura en lo que sabes de la clínica, para que la evalúen hoy, y después el horario más próximo, hoy si hay; no pases el caso al equipo por eso."
          : " Lo que cuenta no puede esperar: ofrécele primero el horario más próximo, hoy si hay, y dale el teléfono para urgencias de la clínica si figura en lo que sabes de la clínica; no pases el caso al equipo por eso."
        : ""
    }`
  }
  if (path === "cambio_cita" && prefetched) {
    return `${head} cambiar o cancelar una cita. Esto se consultó ahora mismo y no hace falta volver a pedirlo:\n${prefetched}\nUsa los ids y las versiones exactos de ahí.`
  }
  return null
}
