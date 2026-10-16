import { AIMessage, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import type { Runnable } from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { withOrgContext } from "@odentia/db"
import { DEFAULT_AUTONOMY_MODES } from "@odentia/db/schema/agent"
import {
  AGENT_BASE_PRINCIPLES,
  AGENT_ROLES,
  type AgentConfig,
  CASE_LOOKUP_TOOLS,
  formatAgentCaseForPrompt,
  formatKnowledgeForPrompt,
  formatAgentClinicData,
  formatOrgMoney,
  formatLessonExamples,
  formatLessonRules,
  formatPersonMemoryForPrompt,
  formatZoned,
  getAgentCaseState,
  getAgentClinicData,
  getAgentConfig,
  getClinicInfoSnapshot,
  getContact,
  getOrgLocale,
  getPersonMemory,
  listAgentContextCandidates,
  listContactChannelHistory,
  listContactNotes,
  listMessages,
  listOpportunities,
  formatKnowledgeEntry,
  type KnowledgeEntryItem,
  knowledgeFitsPrompt,
  lessonsForTurn,
  listPublishedForPrompt,
  noteLessonUse,
  type OrgLocale,
  recordAgentCaseLookup,
  recordAgentDecision,
} from "@odentia/services"
import {
  KNOWLEDGE_SELECT_VERSION,
  knowledgeCandidates,
  knowledgeOutcome,
  knowledgeQuestion,
  type KnowledgeSelection,
  readKnowledgeSelection,
} from "./decision/knowledge.js"
import { DecisionError, type DecisionResult } from "./decision/port.js"
import { z } from "zod"
import { BURST_HORIZON_MS, BURST_MESSAGES } from "./decision/points.js"
import { channelFormatRule } from "./channel-format.js"
import { ROUTE_TOOLS, routeInstruction, WIDEN_TOOL, widenDescription } from "./decision/route.js"
import {
  type AgentEvidence,
  type AgentSandbox,
  type AgentToolCtx,
  conversationChannel,
  makeAgentTools,
  noticeAfterHandoff,
  performHandoff,
  SANDBOX_PATIENT_ID,
  SANDBOX_PERSON,
  TOOL_SOURCES,
} from "./tools.js"

/** Mensaje del hilo tal como lo necesita el contexto: real o de una prueba. */
interface ThreadMessage {
  direction: string
  senderKind: string
  body: string | null
  createdAt?: string
}

interface ThreadContext {
  contactBlock: string
  crossBlock: string | null
  caseBlock: string | null
  items: ThreadMessage[]
}

/**
 * Los mensajes seguidos del interlocutor al final del hilo, juntos: quien
 * escribe en varios mensajes pregunta una sola cosa, y el tema puede estar en
 * el primero. Nulo si lo último no es una ráfaga suya.
 */
function trailingBurst(items: ThreadMessage[]): string | null {
  const last = items[items.length - 1]
  if (!last || last.direction !== "in") return null
  const at = (item: ThreadMessage) => (item.createdAt ? new Date(item.createdAt).getTime() : null)
  const end = at(last)
  const horizon = end === null ? null : end - BURST_HORIZON_MS
  const run: string[] = []
  for (let index = items.length - 1; index >= 0 && run.length < BURST_MESSAGES; index -= 1) {
    const item = items[index]
    if (!item || item.direction !== "in") break
    const sent = at(item)
    if (horizon !== null && sent !== null && sent < horizon) break
    if (item.body?.trim()) run.unshift(item.body.trim())
  }
  return run.length > 1 ? run.join("\n") : null
}

/** Nombre con el que el equipo ve las respuestas que el modelo de decisión eligió para un turno. */
const KNOWLEDGE_PICKED_SOURCE = "Respuestas oficiales elegidas para este mensaje"

/** Mensajes del hilo que el modelo ve en cada turno; lo anterior queda en las notas del caso. */
const HISTORY_LIMIT = 20

/** Quién dice que sí a cada acción: la misma para todas las clínicas (ADR 0021). */
const POLICY_LINE = `Política de autonomía: ${Object.entries(DEFAULT_AUTONOMY_MODES)
  .map(([action, mode]) => `${action}=${mode}`)
  .join(", ")}.`

/** Herramientas que comunican algo al interlocutor. */
const SEND_TOOLS = new Set(["send_reply", "send_template", "despedirse_y_cerrar"])

const NOT_SENT =
  "No enviado: la respuesta al interlocutor debe ir sola en su paso. Revisa los resultados de las otras herramientas y vuelve a llamar a la herramienta de envío una sola vez."

function isSystemMessage(msg: BaseMessage): boolean {
  if (msg instanceof SystemMessage) return true
  // Mensajes rehidratados del checkpointer: misma clase por nombre.
  return msg.constructor?.name === "SystemMessage"
}

const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    // El contexto vigente reemplaza al anterior entre turnos (con
    // checkpointer) en vez de copiarse encima: loadContext devuelve el lote
    // [system, ...historial] y ese lote sustituye el estado guardado, así no
    // crece por copia ni conserva políticas antiguas. Dentro del turno los
    // lotes del modelo y las herramientas no empiezan por system y se
    // concatenan, sin perder mensajes de herramientas.
    reducer: (left, right) => (right.length > 0 && right[0] && isSystemMessage(right[0]) ? right : left.concat(right)),
    default: () => [],
  }),
  turnCount: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
})


const LESSONS_SOURCE = "Lecciones aprobadas por la clínica"

const TONE_TEXT: Record<AgentConfig["tone"], string> = {
  cercano: "cercano y profesional",
  neutro: "neutro y profesional",
  formal: "formal y respetuoso",
}

/** Emojis según la voz de la clínica. Con «No usar», además, `formatForChannel` los quita antes de enviar. */
const EMOJI_TEXT: Record<AgentConfig["emojis"], string> = {
  no: "No uses emojis.",
  pocos:
    "Puedes poner un emoji en algunos mensajes, como mucho uno por mensaje y no en todos; nunca en urgencias, dolor, malas noticias, pagos ni reclamos.",
}

/**
 * Prompt de Recepción: la base fija de odentIA, la voz de la clínica y el
 * manual de funciones según lo que la clínica tiene encendido. Sale de la
 * ficha del agente: apagar una función quita sus herramientas y deja escrito
 * qué hacer cuando alguien la pide. Con la configuración por defecto dice lo
 * mismo que antes de existir las funciones, más los principios fijos.
 */
/**
 * Vender bien sin decir nada falso: la promoción que aplica se ofrece aunque
 * no la pidan, dicha como promoción, con el ahorro y la fecha de fin que trae
 * el dato, y siempre con un paso siguiente. Nada de urgencia, cupos ni
 * condiciones que no estén en los datos.
 */
const SELLS =
  "Vendes como un buen asesor de la clínica: si lo que pregunta la persona tiene una promoción vigente, ofrécela aunque no la pida, dejando claro que es una promoción, su precio, cuánto ahorra y hasta cuándo vale (si tiene fecha de fin, dila siempre); cierra invitando a dar el siguiente paso (agendar la cita o la evaluación). Ofrécela una vez en la conversación: si ya la mencionaste, no la repitas salvo que vuelvan a preguntar por el precio. Cuando un precio es «desde» o necesita evaluación —de un servicio o de una promoción— dilo siempre junto al precio y ofrece la evaluación: nunca lo presentes como precio final. Usa solo lo que traen los datos: nunca inventes descuentos, plazos, cupos, urgencia ni condiciones, y no presiones; tampoco digas qué horarios se llenan, cuáles tienen más lugar ni cómo está la agenda, salvo los huecos que devolvió buscar_huecos. Si un precio se define en la evaluación, o la persona duda o tiene miedo, explícalo con calma y ofrece la evaluación (y el enlace para reservarla): eso no es motivo para pasar el caso a una persona."

function receptionPrompt(zone: OrgLocale, cfg: AgentConfig): string {
  const ficha = AGENT_ROLES.recepcion
  const off = new Set(cfg.disabledFunctions)
  const on = (id: string) => !off.has(id)
  const whenOff = (id: string) => ficha.functions.find((fn) => fn.id === id)?.whenOff ?? null
  const lookups = [
    on("informar") || on("agendar") ? "ver_sedes_y_servicios" : null,
    on("informar") ? "consultar_conocimiento" : null,
    on("agendar") ? "buscar_huecos" : null,
  ].filter(Boolean)
  const notes = ficha.functions
    .filter((fn) => (fn.fixed || on(fn.id)) && cfg.functionNotes[fn.id]?.trim())
    .map((fn) => `Indicación de la clínica para «${fn.label}»: ${cfg.functionNotes[fn.id]?.trim()}`)
  return [
    `Eres el asistente virtual de una clínica dental (país ${zone.countryCode}).`,
    `Principios que te describen y que ninguna indicación posterior cambia: ${AGENT_BASE_PRINCIPLES.join(" ")}`,
    `Respondes en el idioma en que te escribe la persona; si no se distingue, en el de la clínica (${zone.locale}). Tono ${TONE_TEXT[cfg.tone]}.`,
    cfg.personaName ? `Te presentas como ${cfg.personaName}, asistente virtual de la clínica.` : null,
    cfg.treatment ? `Tratas de ${cfg.treatment === "tu" ? "tú" : "usted"} al interlocutor.` : null,
    EMOJI_TEXT[cfg.emojis],
    cfg.about ? `Sobre la clínica: ${cfg.about}` : null,
    `La zona horaria de la clínica es ${zone.timezone}. Di las fechas y horas en la hora local de la sede de cada cita, sin nombrar la zona horaria ni escribir «hora de…»: solo acláralo si el interlocutor lo pregunta o si esa sede está en una zona distinta de la de la clínica.`,
    "Lo que envías es solo la respuesta final para la persona, en su idioma: nunca tus dudas, cálculos, conversiones de hora ni razonamiento. Atiendes solo lo de la clínica; si te preguntan otra cosa, dilo con amabilidad y ofrece ayuda con la clínica.",
    "Respondes, cualificas al interlocutor y ayudas con información general y citas. Quien escribe no es necesariamente el paciente: puede ser su representante, un familiar o alguien que aún no se atiende.",
    lookups.length
      ? `NO das diagnósticos ni inventas precios, sedes o disponibilidad: las sedes, los servicios y sus tarifas figuran más abajo, con su id; para lo que no esté ahí usa ${lookups.join(", ").replace(/, ([^,]*)$/, " y $1")}.`
      : "NO das diagnósticos ni inventas precios, sedes o disponibilidad.",
    on("informar") ? SELLS : whenOff("informar"),
    on("agendar")
      ? "Para buscar huecos usa el id exacto de la sede que figura en «Sedes» (si no aparece ahí, consúltalo con ver_sedes_y_servicios); reserva con proponer_cita usando los IDs exactos del hueco elegido (sede, sillón, profesional, inicio). Si la persona ya sabe qué quiere, ofrécele dos o tres horarios por aquí; si duda entre días, sedes o profesionales, envíale el enlace con enviar_enlace_cita para que vea todo de una vez (sirve a quien ya es paciente y a quien recién se contacta) y ofrece seguir por aquí si lo prefiere."
      : whenOff("agendar"),
    "Nunca reveles ni pidas historia clínica: solo filiación mínima con ver_contexto_paciente y vínculo verificado; próximas citas, presupuestos y saldo solo con ver_resumen_paciente y según la facultad del interlocutor.",
    on("agendar")
      ? "Las citas se reservan con proponer_cita y se cambian o cancelan con reprogramar_cita y cancelar_cita (id y versión exactos de ver_resumen_paciente); reservar, mover o cancelar se ejecuta solo con el sí del interlocutor."
      : null,
    on("seguimiento") ? null : whenOff("seguimiento"),
    "Si el interlocutor pide hablar con un humano, se queja, tiene una urgencia o el caso es clínico, usa request_human_handoff con motivo, resumen factual, prioridad y, en message, el aviso para el interlocutor; no uses send_reply para ese aviso.",
    "Ninguna conversación queda abierta: cuando la persona agradece o se despide y no queda nada pendiente (ninguna propuesta esperando su sí, ningún caso con el equipo, ninguna pregunta suya sin responder), despídete en una sola línea cordial, en el tono de la clínica, diciendo que estamos atentos si quiere volver a escribir, y usa despedirse_y_cerrar en lugar de send_reply. Si su agradecimiento llega con algo pendiente o con otra pregunta, responde con send_reply y no cierres. Nunca digas «te dejo por ahora».",
    ...notes,
    "Una cita solo existe si la propusiste con proponer_cita (o la moviste o cancelaste con su herramienta) y la persona la confirmó con confirmar_propuesta. Nunca digas que propusiste, reservaste, agendaste o que «se gestionará» una cita sin haber usado esas herramientas: para pedir el sí, primero llama a proponer_cita con un hueco que devolvió buscar_huecos; si la hora que pide no estaba entre los huecos, búscala antes. Si el «Estado del caso» no muestra una propuesta pendiente, no hay nada que confirmar todavía.",
    "Si la persona confirma por escrito una cita que ya tiene (por ejemplo, responde «sí, ahí estaré» a un recordatorio), confírmala con confirmar_cita y díselo con la frase que te devuelve (si escribe por sus hijos, dice de quiénes son): no es una propuesta y no pide otro sí. Si tiene varias por confirmar, pregúntale cuál.",
    "Si el último mensaje de la clínica en el hilo es la pregunta «¿Te podemos escribir también para avisarte de tus controles y novedades de la clínica?» y la persona responde sí o no, anótalo con responder_permiso_mensajes; no lo confundas con confirmar una cita.",
    "El «Estado del caso» lo registra el sistema y manda sobre tu recuerdo: si hay una propuesta pendiente de que el interlocutor confirme y su último mensaje es un sí claro, ejecútala con confirmar_propuesta y el id indicado, sin volver a buscar ni a proponer. Cuando el interlocutor dé un dato que hará falta más adelante (para quién es la cita, servicio y sede elegidos, preferencia de horario), guárdalo con anotar_caso; nunca anotes datos clínicos.",
    "Si la persona te dice una preferencia o un dato práctico que servirá en otra conversación (horario que le viene bien, cómo quiere que la llamen, por quién escribe), guárdalo con recordar_dato. La memoria de la persona nunca lleva síntomas, diagnósticos ni nada de salud.",
    "Cada precio, fecha y hora de tu respuesta se comprueba contra lo que consultaste en este turno o figura en este contexto: si un dato no está, la respuesta no sale. Consulta antes de afirmarlo y no calcules precios por tu cuenta.",
    "El interlocutor solo recibe lo que envías con send_reply (o send_template, si la tienes disponible; tus mensajes anteriores del historial se enviaron así). Envía una única respuesta completa, sola en su paso y después de ver el resultado de cualquier otra herramienta: cuando el mensaje sale o queda pendiente de decisión, el turno termina; si la herramienta devuelve un error u outside_window, sigue sus indicaciones. Un texto fuera de esas herramientas no llega a nadie.",
  ]
    .filter(Boolean)
    .join("\n")
}

/**
 * Cuenta cada llamada al modelo y acumula tokens solo si el proveedor los
 * reporta en usage_metadata (los costes se derivan únicamente de datos del
 * proveedor, nunca estimados). La entrada servida desde caché es parte de
 * input_tokens y se guarda aparte para medir el ahorro.
 */
function trackUsage(ctx: AgentToolCtx, reply: AIMessage): void {
  ctx.usage.calls += 1
  const meta = (reply.usage_metadata ?? {}) as {
    input_tokens?: unknown
    output_tokens?: unknown
    input_token_details?: { cache_read?: unknown }
  }
  const input = typeof meta.input_tokens === "number" ? meta.input_tokens : null
  const output = typeof meta.output_tokens === "number" ? meta.output_tokens : null
  if (input !== null || output !== null) {
    ctx.usage.reported = true
    if (input !== null) ctx.usage.inputTokens += input
    if (output !== null) ctx.usage.outputTokens += output
  }
  const cached = meta.input_token_details?.cache_read
  if (typeof cached === "number") {
    ctx.usage.cacheReported = true
    ctx.usage.cachedInputTokens += cached
  }
}

/**
 * Historial como mensajes del modelo. Lo que escribió el interlocutor o el
 * equipo lleva delante cuándo se dijo: sin eso el modelo no distingue lo de
 * hoy de lo de la semana pasada. Las respuestas propias van sin sello para que
 * no lo imite al escribir.
 */
function historyToMessages(
  items: { direction: string; senderKind: string; body: string | null; createdAt?: string }[],
  zone: OrgLocale,
): BaseMessage[] {
  const stamp = (iso: string | undefined): string => {
    const date = iso ? new Date(iso) : null
    if (!date || Number.isNaN(date.getTime())) return ""
    const when = date.toLocaleString(zone.locale, {
      timeZone: zone.timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    })
    return `[${when}] `
  }
  const out: BaseMessage[] = []
  for (const item of items) {
    const text = item.body ?? "[adjunto]"
    if (item.direction === "in") {
      out.push(new HumanMessage({ content: `${stamp(item.createdAt)}${text}` }))
    } else if (item.senderKind === "agent") {
      out.push(new AIMessage({ content: text }))
    } else {
      out.push(new HumanMessage({ content: `${stamp(item.createdAt)}[operador] ${text}` }))
    }
  }
  return out
}

/** Resumen corto de una consulta, para que el equipo vea qué se miró sin leer la salida entera. */
function lookupDetail(tool: string, text: string): string | undefined {
  if (tool === "consultar_conocimiento") {
    const titles = text
      .split("\n")
      .map((line) => /^- ([^:]{1,80}):/.exec(line)?.[1])
      .filter((title): title is string => Boolean(title))
    return titles.length ? titles.slice(0, 5).join(" · ") : "Sin respuesta oficial para esa búsqueda"
  }
  if (tool === "buscar_huecos") {
    const options = text.split("\n").filter((line) => line.startsWith("- ")).length
    return options ? `${options} ${options === 1 ? "horario" : "horarios"}` : "Sin horarios en ese rango"
  }
  return undefined
}

/**
 * Compila el grafo del agente para una corrida. El checkpointer usa conexión
 * de owner (el pool es compartido entre orgs y el GUC RLS no se puede fijar
 * por operación): el aislamiento lo da el thread_id exacto
 * `${orgId}:${conversationId}` más las policies RLS para el rol app.
 * Entre turnos el contexto vigente (sistema e historial desde la base)
 * reemplaza al guardado: no crece por copia ni conserva políticas antiguas.
 * Sin checkpointer (simulación) el grafo corre sin memoria persistente.
 */
export function compileAgentGraph(
  model: Runnable<BaseMessage[], AIMessage>,
  toolCtx: AgentToolCtx,
  checkpointer?: PostgresSaver,
) {
  const tools = makeAgentTools(toolCtx)
  // Con camino elegido, al modelo se le enseñan solo las herramientas de ese
  // camino más la que le devuelve el resto. La ejecución admite todas: esto
  // acota lo que se envía en cada llamada, no lo que el agente puede hacer.
  const routeTools = toolCtx.route ? ROUTE_TOOLS[toolCtx.route.path] : undefined
  const widen = routeTools && toolCtx.route && toolCtx.route.path !== "derivar"
    ? tool(
        async () => {
          toolCtx.widened = true
          return "Listo: desde el siguiente paso tienes todas las herramientas. Continúa con la que necesites."
        },
        { name: WIDEN_TOOL, description: widenDescription(toolCtx.route.path), schema: z.object({ motivo: z.string().max(200).describe("Qué pide el interlocutor que este camino no cubre.") }) },
      )
    : null
  const narrowTools = routeTools ? [...tools.filter((item) => routeTools.includes(item.name)), ...(widen ? [widen] : [])] : null
  const bind = (list: unknown[]): Runnable<BaseMessage[], AIMessage> =>
    typeof (model as { bindTools?: unknown }).bindTools === "function"
      ? (model as unknown as { bindTools: (t: unknown[]) => Runnable<BaseMessage[], AIMessage> }).bindTools(list)
      : model
  let boundAs: "todas" | "camino" | null = null
  let bound: Runnable<BaseMessage[], AIMessage> = model
  /** El modelo con la lista del paso: la del camino mientras alcance; todas si pidió el resto o hay una propuesta por confirmar. */
  const modelForStep = (): Runnable<BaseMessage[], AIMessage> => {
    // Derivado ya el caso, el turno solo deja el aviso aunque haya una propuesta pendiente.
    const narrow = toolCtx.route?.path === "derivar" || (!toolCtx.widened && !toolCtx.casePending)
    const want = narrowTools && narrow ? "camino" : "todas"
    if (boundAs !== want) {
      bound = bind(want === "camino" && narrowTools ? narrowTools : tools)
      boundAs = want
    }
    return bound
  }
  const toolNode = new ToolNode(widen ? [...tools, widen] : tools)

  /**
   * Barato primero, caro solo si duda: el modelo de decisión elige qué
   * respuestas oficiales aplican al último mensaje. Si está seguro, solo esas
   * viajan completas; si duda, van todas cuando caben (si no, el modelo que
   * escribe elige con el índice y la búsqueda); si ningún tema aplica, no se
   * añade nada. Un fallo del modelo de decisión equivale a dudar: nunca corta
   * el turno. La elección queda en el libro de decisiones, sin el texto del
   * interlocutor.
   */
  async function selectKnowledge(
    latest: string | null,
    entries: KnowledgeEntryItem[],
  ): Promise<{ block: string; titles: string[] } | null> {
    const everything = (): { block: string; titles: string[] } | null =>
      knowledgeFitsPrompt(entries)
        ? {
            block: `Respuestas oficiales completas (no quedó claro cuál aplica a este mensaje; cita tal cual la que corresponda):\n${entries.map(formatKnowledgeEntry).join("\n")}`,
            titles: [],
          }
        : null
    const decision = toolCtx.decision
    if (!decision || !latest?.trim()) return everything()
    const candidates = knowledgeCandidates(entries, latest)
    const state = `Contact (latest): ${latest.slice(0, 1000)}`
    const record = (input: { answers: unknown[]; error?: string; result?: DecisionResult; outcome?: Record<string, unknown> }) =>
      toolCtx.dryRun
        ? Promise.resolve()
        : withOrgContext(toolCtx.db, toolCtx.orgId, (tx) =>
            recordAgentDecision(tx, toolCtx.orgId, {
              conversationId: toolCtx.conversationId,
              triggerMessageId: toolCtx.triggerId,
              point: KNOWLEDGE_SELECT_VERSION,
              mode: "retrieval",
              provider: decision.provider,
              state,
              answers: input.answers,
              ...(input.error ? { error: input.error } : {}),
              ...(input.outcome ? { outcome: input.outcome } : {}),
              ...(input.result
                ? {
                    model: input.result.model,
                    latencyMs: input.result.latencyMs,
                    inputTokens: input.result.usage?.inputTokens ?? null,
                    outputTokens: input.result.usage?.outputTokens ?? null,
                  }
                : {}),
            }),
          )
            .then(() => undefined)
            .catch(() => undefined)
    let selection: KnowledgeSelection
    try {
      const result = await decision.decide(state, [knowledgeQuestion(candidates)])
      selection = readKnowledgeSelection(result, candidates)
      await record({ answers: result.answers, result, outcome: knowledgeOutcome(selection, candidates.length) })
    } catch (error) {
      await record({
        answers: [],
        error: error instanceof DecisionError ? `${error.code}: ${error.message}` : "fallo inesperado del modelo de decisión",
      })
      return everything()
    }
    if (selection.verdict === "ninguno") return null
    const chosen = selection.picked.length
      ? {
          block: `Respuestas oficiales que aplican a este mensaje (elegidas para este turno; cítalas tal cual):\n${selection.picked.map(formatKnowledgeEntry).join("\n")}`,
          titles: selection.picked.map((entry) => entry.title),
        }
      : null
    if (selection.verdict === "seguro") return chosen
    const all = everything()
    return all ? { block: all.block, titles: chosen?.titles ?? [] } : chosen
  }

  /**
   * Lo propio del hilo real: quién escribe, sus vínculos y notas, lo conversado
   * en otros canales, el estado del caso y los últimos mensajes.
   */
  async function readThread(zone: OrgLocale): Promise<ThreadContext> {
    const full = await withOrgContext(toolCtx.db, toolCtx.orgId, (tx) =>
      getContact(tx, toolCtx.orgId, toolCtx.contactId),
    )
    const contactDetail = full.contact
    const notes = await withOrgContext(toolCtx.db, toolCtx.orgId, (tx) =>
      listContactNotes(tx, toolCtx.orgId, toolCtx.contactId, { limit: 5 }),
    )
    // Contexto comercial autorizado y paginado: si hay más oportunidades de
    // las mostradas se avisa (nunca corte mudo).
    const commercialLine = await withOrgContext(toolCtx.db, toolCtx.orgId, async (tx) => {
      const { items, nextCursor } = await listOpportunities(tx, toolCtx.orgId, {
        contactId: toolCtx.contactId,
        status: "open",
        limit: 10,
      })
      const parts: string[] = []
      if (!items.length) {
        parts.push("sin oportunidades abiertas")
      } else {
        for (const o of items) {
          const followup = o.nextTask
            ? `; tarea «${o.nextTask.title}»${o.nextTask.dueAt ? ` para ${formatZoned(new Date(o.nextTask.dueAt), zone)}` : ""}`
            : ""
          // El valor de la oportunidad es una cifra interna de ventas, no un precio: no llega al
          // agente, que podría decirlo a la persona y la comprobación lo daría por bueno (ADR 0021).
          parts.push(`${o.title} (etapa ${o.stageName}${followup})`)
        }
        if (nextCursor) parts.push("hay más oportunidades: usa listar_oportunidades para verlas todas")
      }
      return parts.join("; ")
    })
    // Seguimientos pendientes del contacto (tareas abiertas): misma fuente
    // que la ficha, sin ampliar acceso.
    const followupLine = full.openTasks.length
      ? full.openTasks
          .slice(0, 10)
          .map((t) => `${t.title}${t.dueAt ? ` (vence ${formatZoned(new Date(t.dueAt), zone)})` : ""}`)
          .join("; ") + (full.openTasks.length > 10 ? "; hay más tareas: usa listar_tareas para verlas todas" : "")
      : "sin seguimientos pendientes"
    const tagsLine = contactDetail.tags.length ? contactDetail.tags.join(", ") : "sin etiquetas"
    const notesLine = contactDetail.notes?.trim() ? contactDetail.notes.trim().slice(0, 500) : null
    const customLine = Object.entries(contactDetail.customFields ?? {})
      .slice(0, 10)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v.slice(0, 120) : JSON.stringify(v)?.slice(0, 120) ?? ""}`)
      .join("; ")
    const { items } = await withOrgContext(toolCtx.db, toolCtx.orgId, (tx) =>
      listMessages(tx, toolCtx.orgId, toolCtx.conversationId, { limit: HISTORY_LIMIT }),
    )
    // Lo ya propuesto, lo que el propio agente anotó y lo que consultó en
    // turnos anteriores: sin esto cada turno empieza de cero y no puede
    // confirmar la propuesta que él mismo dejó pendiente.
    const caseBlock = await withOrgContext(toolCtx.db, toolCtx.orgId, async (tx) => {
      const state = await getAgentCaseState(tx, toolCtx.orgId, toolCtx.conversationId)
      toolCtx.casePending = state.pending.length > 0
      return formatAgentCaseForPrompt(state, zone, HISTORY_LIMIT)
    })
    // Historial acotado de otros canales del mismo contacto verificado, con
    // procedencia, para continuidad omnicanal. La autorización la da el
    // contactId vigente del hilo; nunca se resuelve por teléfono. Acotado y
    // con aviso explícito si hay más (nunca corte mudo).
    const cross = await withOrgContext(toolCtx.db, toolCtx.orgId, (tx) =>
      listContactChannelHistory(tx, toolCtx.orgId, {
        contactId: toolCtx.contactId,
        excludeConversationId: toolCtx.conversationId,
        limit: 3,
        perConversation: 5,
      }),
    )
    const crossBlock = cross.items.length
      ? [
          "Historial de otros canales del mismo contacto (procedencia indicada; no pidas de nuevo lo ya conversado ni lo presentes como de este canal):",
          ...cross.items.map((c) => {
            const when = c.lastMessageAt ? formatZoned(new Date(c.lastMessageAt), zone) : "sin fecha"
            const lines = c.messages.map((m) => {
              const who = m.direction === "in" ? "contacto" : m.senderKind === "agent" ? "agente" : "operador"
              return `  ${who}: ${(m.body ?? "[adjunto]").slice(0, 300)}`
            })
            return `[${c.channel} · ${when}]\n${lines.join("\n")}`
          }),
          cross.nextCursor ? "Hay más historial en otros canales: usa ver_otros_canales para consultarlo." : null,
        ]
          .filter(Boolean)
          .join("\n")
      : null
    // Personas a las que este interlocutor está vinculado: mismo listado
    // autorizado que ver_contexto_paciente (solo nombre y vínculo, sin clínica).
    const linkedPatients = await withOrgContext(toolCtx.db, toolCtx.orgId, (tx) =>
      listAgentContextCandidates(tx, toolCtx.orgId, toolCtx.contactId),
    )
    const patientsLine = linkedPatients.length
      ? `Pacientes vinculados a este interlocutor: ${linkedPatients
          .slice(0, 5)
          .map((p) => `${p.displayName} (id ${p.patientId}, vínculo: ${p.relationship})`)
          .join("; ")}${linkedPatients.length > 5 ? "; hay más: usa ver_contexto_paciente" : ""}. Antes de actuar por uno, verifica vínculo y autorización con ver_contexto_paciente.`
      : "Este interlocutor no está vinculado a ningún paciente."
    // Lo que el agente recuerda de la persona, venga del canal que venga: sus
    // datos guardados (nunca clínicos) y lo que sale de vínculos y citas.
    const memoryBlock = await withOrgContext(toolCtx.db, toolCtx.orgId, async (tx) =>
      formatPersonMemoryForPrompt(await getPersonMemory(tx, toolCtx.orgId, toolCtx.contactId), zone),
    )
    const contactBlock = [
      `Interlocutor: ${contactDetail.displayName}. Etiquetas: ${tagsLine}. Oportunidades abiertas: ${commercialLine}. Seguimientos: ${followupLine}.`,
      patientsLine,
      notesLine ? `Notas del contacto (internas): ${notesLine}${(contactDetail.notes?.trim().length ?? 0) > 500 ? "… (texto completo en leer_contexto_comercial)" : ""}.` : null,
      notes.items.length ? `Notas operativas recientes (internas; no las reproduzcas al interlocutor):\n${notes.items.map(n => `${n.at}: ${n.body}`).join("\n")}${notes.nextCursor ? "\nHay más notas: usa leer_contexto_comercial con cursor de notas para consultarlas." : ""}` : null,
      customLine ? `Campos (resumen; valores completos en leer_contexto_comercial): ${customLine}.` : null,
      memoryBlock,
    ]
      .filter(Boolean)
      .join("\n\n")
    return { contactBlock, crossBlock, caseBlock, items }
  }

  /**
   * Hilo de una conversación de prueba: una persona ficticia vinculada a sí
   * misma, el historial que trae quien prueba y el estado que dejaron los
   * turnos anteriores de la misma prueba. No lee ni escribe nada del hilo.
   */
  function sandboxThread(sandbox: AgentSandbox, zone: OrgLocale): ThreadContext {
    const at = new Date().toISOString()
    toolCtx.casePending = sandbox.state.pending.length > 0
    return {
      contactBlock: [
        `Interlocutor: ${SANDBOX_PERSON}. Etiquetas: sin etiquetas. Oportunidades abiertas: sin oportunidades abiertas. Seguimientos: sin seguimientos pendientes.`,
        `Pacientes vinculados a este interlocutor: ${SANDBOX_PERSON} (id ${SANDBOX_PATIENT_ID}, vínculo: self). Antes de actuar por uno, verifica vínculo y autorización con ver_contexto_paciente.`,
      ].join("\n\n"),
      crossBlock: null,
      caseBlock: formatAgentCaseForPrompt(
        { ...sandbox.state, totalMessages: sandbox.transcript.length },
        zone,
        HISTORY_LIMIT,
      ),
      items: sandbox.transcript.slice(-HISTORY_LIMIT).map((turn) => ({
        direction: turn.role === "contact" ? "in" : "out",
        senderKind: turn.role === "contact" ? "contact" : "agent",
        body: turn.text,
        createdAt: at,
      })),
    }
  }

  /**
   * Citas, presupuestos y saldo del paciente del interlocutor, traídos por el
   * código cuando el camino es cambiar una cita. Usa la misma herramienta que
   * usaría el modelo, con su misma autorización, y solo cuando hay un único
   * paciente vinculado: con varios hay que preguntar de quién se trata.
   */
  async function prefetchPatientSummary(): Promise<{ text: string; source: { kind: string; label: string } } | null> {
    const name = "ver_resumen_paciente"
    const summary = tools.find((item) => item.name === name)
    const source = TOOL_SOURCES[name]
    if (!summary || !source || toolCtx.sandbox) return null
    try {
      const linked = await withOrgContext(toolCtx.db, toolCtx.orgId, (tx) =>
        listAgentContextCandidates(tx, toolCtx.orgId, toolCtx.contactId),
      )
      if (linked.length !== 1 || !linked[0]) return null
      const result: unknown = await (summary as unknown as { invoke: (input: unknown) => Promise<unknown> }).invoke({ patientId: linked[0].patientId })
      const text = typeof result === "string" ? result : JSON.stringify(result)
      return text.trim() ? { text: text.slice(0, 4000), source } : null
    } catch {
      // Sin autorización o sin datos: el modelo lo consultará o preguntará, como siempre.
      return null
    }
  }

  async function loadContext(): Promise<{ messages: BaseMessage[] }> {
    const zone = await withOrgContext(toolCtx.db, toolCtx.orgId, (tx) => getOrgLocale(tx, toolCtx.orgId))
    const { contactBlock, crossBlock, caseBlock, items } = toolCtx.sandbox
      ? sandboxThread(toolCtx.sandbox, zone)
      : await readThread(zone)
    const draft = toolCtx.draftText?.trim().slice(0, 4000)
    const latestInbound = draft ?? [...items].reverse().find((item) => item.direction === "in")?.body ?? null
    toolCtx.lastInboundText = latestInbound ?? undefined
    // Para elegir conocimiento y lecciones cuenta todo lo que escribió seguido, no solo lo último.
    const asked = draft ?? trailingBurst(items) ?? latestInbound
    const overrides = toolCtx.lessonOverrides
    const hiddenEntries = new Set(overrides?.skipEntryIds ?? [])
    const { cfg, orgPrompt, snapshot, clinicData, faqs, lessons } = await withOrgContext(
      toolCtx.db,
      toolCtx.orgId,
      async (tx) => {
        const cfg = await getAgentConfig(tx, toolCtx.orgId)
        // Con «Informar» apagado el agente no recibe tarifas, promociones,
        // profesionales ni respuestas oficiales: solo las sedes y su horario,
        // que agendar necesita.
        const informs = !cfg.disabledFunctions.includes("informar")
        const snapshot = await getClinicInfoSnapshot(tx, toolCtx.orgId)
        const clinicData = await getAgentClinicData(tx, toolCtx.orgId, informs)
        return {
          cfg,
          orgPrompt: cfg.systemPrompt,
          snapshot: informs ? snapshot : { ...snapshot, services: [] },
          clinicData,
          faqs: informs ? (await listPublishedForPrompt(tx, toolCtx.orgId)).filter((entry) => !hiddenEntries.has(entry.id)) : [],
          // Lo aprendido de las correcciones: reglas del agente y ejemplos parecidos a lo que se pregunta.
          lessons: await lessonsForTurn(tx, toolCtx.orgId, "recepcion", asked ?? "", {
            skipIds: overrides?.skipIds ?? [],
            extra: overrides?.extra ?? [],
          }),
        }
      },
    )
    // Un uso cuenta cuando la lección toca el tema del mensaje; una prueba no cuenta.
    if (!toolCtx.dryRun && lessons.matchedIds.length > 0) {
      await withOrgContext(toolCtx.db, toolCtx.orgId, (tx) =>
        noteLessonUse(tx, toolCtx.orgId, { lessonIds: lessons.matchedIds }),
      ).catch(() => undefined)
    }
    const rulesBlock = formatLessonRules(lessons.rules)
    const examplesBlock = formatLessonExamples(lessons.examples)
    // En una prueba, la respuesta oficial de una lección aún sin aprobar va como si estuviera publicada.
    const trialAnswers = (overrides?.extra ?? []).filter((lesson) => lesson.kind === "respuesta_oficial")
    const trialBlock = trialAnswers.length
      ? `Respuestas oficiales (cítalas tal cual si aplican):\n${trialAnswers.map((lesson) => `- ${lesson.title}: ${lesson.body}`).join("\n")}`
      : null
    // Con modelo de decisión, el bloque estable de la clínica lleva solo el
    // índice y el texto de los temas llega por turno; sin él, van todas las
    // respuestas si caben y, si no, el índice. Un botón tocado no pregunta
    // nada: no hay tema que elegir.
    const selecting = Boolean(toolCtx.decision) && faqs.length > 0 && !toolCtx.routeHint
    const knowledgeBlock = formatKnowledgeForPrompt(
      snapshot,
      faqs,
      selecting ? "indice" : undefined,
      formatAgentClinicData(clinicData, zone),
    )
    const picked = selecting ? await selectKnowledge(asked, faqs) : null
    // De lo más estable a lo más cambiante. Los proveedores sirven desde su
    // caché el prefijo idéntico entre llamadas: lo que es igual para toda la
    // organización (instrucciones, política, conocimiento) va primero; luego
    // lo propio del hilo; y al final lo que cambia en cada corrida. Poner la
    // hora delante invalidaba la caché de todo lo que seguía.
    // El camino que eligió el modelo de decisión: el código trae antes lo que
    // ese camino necesita y el modelo que escribe lo recibe ya consultado.
    const route = toolCtx.route ?? null
    // Para reservar o cambiar una cita lo primero que el modelo pide es quién
    // es el paciente y qué citas tiene: llega ya consultado y se ahorra el paso.
    const prefetched = route?.path === "cambio_cita" || route?.path === "cita" ? await prefetchPatientSummary() : null
    const routeBlock = route ? [routeInstruction(route.path, prefetched?.text), toolCtx.routeHint].filter(Boolean).join("\n") || null : null
    const nowLine = `Fecha y hora actual de la clínica: ${formatZoned(new Date(), zone)}.`
    // Las reglas son de la organización (estables); los ejemplos dependen del mensaje y van con lo del turno.
    // El formato depende del canal del hilo: va con lo del hilo, no en el prefijo estable.
    const formatLine = channelFormatRule(await conversationChannel(toolCtx))
    const system = [receptionPrompt(zone, cfg), orgPrompt, rulesBlock, POLICY_LINE, knowledgeBlock, contactBlock, formatLine, crossBlock, caseBlock, picked?.block, trialBlock, examplesBlock, routeBlock, nowLine]
      .filter(Boolean)
      .join("\n\n")
    const said = (who: "contact" | "agent" | "team") =>
      items
        .filter((item) =>
          who === "contact" ? item.direction === "in" : who === "agent" ? item.direction !== "in" && item.senderKind === "agent" : item.direction !== "in" && item.senderKind !== "agent",
        )
        .map((item) => item.body ?? "")
        .concat(who === "contact" && draft ? [draft] : [])
        .join("\n")
    // Contra esto se comprueba la respuesta antes de salir. Cada fuente lleva
    // el nombre con el que el equipo la verá en «En qué se basó».
    const evidence: AgentEvidence[] = [
      { kind: "indicaciones", source: "Indicaciones de la clínica", text: orgPrompt ?? "" },
      { kind: "conocimiento", source: "Conocimiento publicado de la clínica", text: knowledgeBlock },
      { kind: "conocimiento", source: KNOWLEDGE_PICKED_SOURCE, text: [picked?.block, trialBlock].filter(Boolean).join("\n") },
      { kind: "leccion", source: LESSONS_SOURCE, text: [rulesBlock, examplesBlock].filter(Boolean).join("\n") },
      { kind: "comercial", source: TOOL_SOURCES["leer_contexto_comercial"]?.label ?? "Ficha del contacto", text: contactBlock },
      { kind: "otros_canales", source: TOOL_SOURCES["ver_otros_canales"]?.label ?? "Otros canales", text: crossBlock ?? "" },
      { kind: "caso", source: "Estado y notas del caso", text: caseBlock ?? "" },
      { kind: "conversacion", source: "Lo escribió el equipo en este hilo", text: said("team") },
      { kind: "conversacion", source: "Respuestas anteriores del agente", text: said("agent") },
      { kind: "conversacion", source: "Lo dijo el interlocutor", text: said("contact") },
      { kind: "sistema", source: "Fecha y hora actual", text: nowLine },
    ]
    if (prefetched) evidence.push({ kind: prefetched.source.kind, source: prefetched.source.label, text: prefetched.text })
    toolCtx.evidence = evidence.filter((item) => item.text.trim())
    toolCtx.basis = picked?.titles.length
      ? [{ kind: "conocimiento", label: KNOWLEDGE_PICKED_SOURCE, detail: picked.titles.slice(0, 5).join(" · ") }]
      : []
    if (prefetched) toolCtx.basis.push({ kind: prefetched.source.kind, label: prefetched.source.label, detail: "Consultado antes de responder" })
    // Cada lección que tocó el tema queda en «En qué se basó», para poder retirarla desde ahí.
    for (const lesson of lessons.matched) {
      toolCtx.basis.push({ kind: "leccion", label: `${lesson.kind === "regla" ? "Regla" : "Ejemplo"} que aprobó tu clínica`, detail: lesson.title, ref: lesson.id })
    }
    toolCtx.checkFailures = 0
    const history = historyToMessages(items, zone)
    if (draft) history.push(new HumanMessage({ content: draft }))
    return { messages: [new SystemMessage({ content: system }), ...history] }
  }

  async function llm(state: typeof AgentState.State) {
    const reply = await modelForStep().invoke(state.messages)
    trackUsage(toolCtx, reply)
    return { messages: [reply] }
  }

  function routeAfterLlm(state: typeof AgentState.State): string {
    const last = state.messages[state.messages.length - 1]
    if (last instanceof AIMessage && last.tool_calls && last.tool_calls.length > 0) return "tools"
    return END
  }

  /**
   * Una respuesta al interlocutor solo sale si es la única llamada del paso:
   * junto a otras herramientas se ejecutaría en paralelo y podría afirmar
   * algo cuyo resultado el modelo aún no vio. En ese caso no se envía y el
   * modelo recibe la indicación de reenviarla sola.
   */
  async function runTools(state: typeof AgentState.State) {
    const last = state.messages[state.messages.length - 1]
    const calls = last instanceof AIMessage ? (last.tool_calls ?? []) : []
    const held = calls.length > 1 ? calls.filter((call) => SEND_TOOLS.has(call.name)) : []
    const executed = calls.filter((call) => !held.includes(call))
    for (const call of executed) {
      if (call.name && !toolCtx.toolsUsed.includes(call.name)) toolCtx.toolsUsed.push(call.name)
    }
    if (held.length === 0 || !(last instanceof AIMessage)) {
      const out = await toolNode.invoke(state)
      await recordLookups(executed, out.messages ?? [])
      return { messages: out.messages ?? [], turnCount: state.turnCount + 1 }
    }
    const notSent: BaseMessage[] = held.map(
      (call) => new ToolMessage({ tool_call_id: call.id ?? "", name: call.name, content: NOT_SENT }),
    )
    if (executed.length === 0) return { messages: notSent, turnCount: state.turnCount + 1 }
    const trimmed = new AIMessage({ content: last.content, tool_calls: executed })
    const out = await toolNode.invoke({ messages: [...state.messages.slice(0, -1), trimmed] })
    await recordLookups(executed, out.messages ?? [])
    return { messages: notSent.concat(out.messages ?? []), turnCount: state.turnCount + 1 }
  }

  /**
   * Lo que devolvió cada herramienta de lectura pasa a ser fuente de la
   * respuesta (para comprobarla y para su traza) y, en las que conviene
   * recordar, la última consulta queda en la memoria del caso.
   */
  async function recordLookups(calls: { id?: string; name: string }[], produced: BaseMessage[]): Promise<void> {
    for (const produced_ of produced) {
      const result = produced_ as ToolMessage
      if (result.getType() !== "tool" || result.status === "error") continue
      const name = result.name ?? calls.find((call) => call.id === result.tool_call_id)?.name
      const source = name ? TOOL_SOURCES[name] : undefined
      if (!name || !source) continue
      const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content)
      toolCtx.evidence = [...(toolCtx.evidence ?? []), { kind: source.kind, source: source.label, text }]
      toolCtx.basis ??= []
      if (!toolCtx.basis.some((item) => item.label === source.label)) {
        const detail = lookupDetail(name, text)
        toolCtx.basis.push({ kind: source.kind, label: source.label, ...(detail ? { detail } : {}) })
      }
      if (toolCtx.sandbox && (CASE_LOOKUP_TOOLS as readonly string[]).includes(name)) {
        // En una prueba la consulta se recuerda dentro de la propia prueba.
        const state = toolCtx.sandbox.state
        state.lookups = [...state.lookups.filter((item) => item.tool !== name), { tool: name, text: text.slice(0, 2000), at: new Date().toISOString() }]
      }
      if (!toolCtx.dryRun && (CASE_LOOKUP_TOOLS as readonly string[]).includes(name)) {
        await withOrgContext(toolCtx.db, toolCtx.orgId, (tx) =>
          recordAgentCaseLookup(tx, toolCtx.orgId, toolCtx.conversationId, { tool: name, text }),
        ).catch(() => {})
      }
    }
  }

  async function routeAfterTools(state: typeof AgentState.State): Promise<string> {
    // La respuesta ya salió o espera decisión: otra llamada al modelo solo
    // produciría texto que no llega a nadie.
    if (toolCtx.handedOff || toolCtx.replySettled) return END
    const maxTurns = await withOrgContext(toolCtx.db, toolCtx.orgId, async (tx) => {
      const cfg = await getAgentConfig(tx, toolCtx.orgId)
      return cfg.maxTurns
    })
    if (state.turnCount >= maxTurns) {
      await performHandoff(toolCtx, "límite de turnos del agente")
      // La persona no queda sin respuesta: recibe el aviso fijo de que sigue una persona.
      await noticeAfterHandoff(toolCtx)
      return END
    }
    return "llm"
  }

  const graph = new StateGraph(AgentState)
    .addNode("loadContext", loadContext)
    .addNode("llm", llm)
    .addNode("tools", runTools)
    .addEdge(START, "loadContext")
    .addEdge("loadContext", "llm")
    .addConditionalEdges("llm", routeAfterLlm, ["tools", END])
    .addConditionalEdges("tools", routeAfterTools, ["llm", END])
    .compile(checkpointer ? { checkpointer } : {})

  return graph
}
