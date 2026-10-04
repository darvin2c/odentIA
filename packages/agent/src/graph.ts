import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import type { Runnable } from "@langchain/core/runnables"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { withOrgContext } from "@odentia/db"
import {
  formatKnowledgeForPrompt,
  formatZoned,
  getAgentConfig,
  getAutonomyPolicy,
  getClinicInfoSnapshot,
  getContact,
  getOrgLocale,
  listContactChannelHistory,
  listContactNotes,
  listMessages,
  listOpportunities,
  listPublishedForPrompt,
  type OrgLocale,
} from "@odentia/services"
import { type AgentToolCtx, makeAgentTools, performHandoff } from "./tools.js"

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


function baseSystemPrompt(zone: OrgLocale): string {
  return [
    `Eres el asistente virtual de una clínica dental (país ${zone.countryCode}).`,
    `Te comunicas en el idioma configurado por la organización (${zone.locale}), tono cercano y profesional.`,
    `La zona horaria de la clínica es ${zone.timezone}; comunica fechas y horas en la zona de la sede de cada cita.`,
    "Respondes, cualificas al paciente y ayudas con información general y citas.",
    "NO das diagnósticos ni inventas precios, sedes o disponibilidad: usa ver_sedes_y_servicios, consultar_conocimiento y buscar_huecos.",
    "Antes de buscar huecos confirma la sede real con ver_sedes_y_servicios y usa su ID exacto; reserva con proponer_cita usando los IDs exactos del hueco elegido (sede, sillón, profesional, inicio).",
    "Nunca reveles ni pidas historia clínica: solo filiación mínima con ver_contexto_paciente y vínculo verificado; próximas citas, presupuestos y saldo solo con ver_resumen_paciente y según la facultad del interlocutor.",
    "Las citas se reservan con proponer_cita y se cambian o cancelan con reprogramar_cita y cancelar_cita (id y versión exactos de ver_resumen_paciente); todo se ejecuta solo con confirmación o aprobación según la política.",
    "Si el paciente pide hablar con un humano, se queja o el caso es clínico, usa request_human_handoff con motivo, resumen factual y prioridad.",
  ].join("\n")
}

/**
 * Acumula tokens solo si el proveedor los reporta en usage_metadata (los
 * costes se derivan únicamente de datos del proveedor, nunca estimados).
 */
function trackUsage(ctx: AgentToolCtx, reply: AIMessage): void {
  const meta = (reply.usage_metadata ?? {}) as {
    input_tokens?: unknown
    output_tokens?: unknown
  }
  const input = typeof meta.input_tokens === "number" ? meta.input_tokens : null
  const output = typeof meta.output_tokens === "number" ? meta.output_tokens : null
  if (input !== null || output !== null) {
    ctx.usage.reported = true
    if (input !== null) ctx.usage.inputTokens += input
    if (output !== null) ctx.usage.outputTokens += output
  }
}

function historyToMessages(
  items: { direction: string; senderKind: string; body: string | null }[],
): BaseMessage[] {
  const out: BaseMessage[] = []
  for (const item of items) {
    const text = item.body ?? "[adjunto]"
    if (item.direction === "in") {
      out.push(new HumanMessage({ content: text }))
    } else if (item.senderKind === "agent") {
      out.push(new AIMessage({ content: text }))
    } else {
      out.push(new HumanMessage({ content: `[operador] ${text}` }))
    }
  }
  return out
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
  const modelWithTools =
    typeof (model as { bindTools?: unknown }).bindTools === "function"
      ? (
          model as unknown as { bindTools: (t: unknown[]) => Runnable<BaseMessage[], AIMessage> }
        ).bindTools(tools)
      : model
  const toolNode = new ToolNode(tools)

  async function loadContext(): Promise<{ messages: BaseMessage[] }> {
    const zone = await withOrgContext(toolCtx.db, toolCtx.orgId, (tx) => getOrgLocale(tx, toolCtx.orgId))
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
          const followup = o.nextActionAt
            ? `; próxima acción ${formatZoned(new Date(o.nextActionAt), zone)}`
            : ""
          const amount =
            o.amountCents !== null ? `; valor ${(o.amountCents / 100).toFixed(2)} ${o.currency}` : ""
          parts.push(`${o.title} (etapa ${o.stageName}${followup}${amount})`)
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
      listMessages(tx, toolCtx.orgId, toolCtx.conversationId, { limit: 20 }),
    )
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
    const { orgPrompt, policyLine, knowledgeBlock } = await withOrgContext(
      toolCtx.db,
      toolCtx.orgId,
      async (tx) => {
        const cfg = await getAgentConfig(tx, toolCtx.orgId)
        const policy = await getAutonomyPolicy(tx, toolCtx.orgId)
        const snapshot = await getClinicInfoSnapshot(tx, toolCtx.orgId)
        const faqs = await listPublishedForPrompt(tx, toolCtx.orgId)
        const modes = (Object.entries(policy) as Array<[string, string]>)
          .map(([action, mode]) => `${action}=${mode}`)
          .join(", ")
        return {
          orgPrompt: cfg.systemPrompt,
          policyLine: `Política de autonomía: ${modes}.`,
          knowledgeBlock: formatKnowledgeForPrompt(snapshot, faqs),
        }
      },
    )
    const system = [
      baseSystemPrompt(zone),
      `Fecha y hora actual de la clínica: ${formatZoned(new Date(), zone)}.`,
      orgPrompt,
      toolCtx.runInstruction ? `Instrucción operativa de esta corrida:\n${toolCtx.runInstruction}` : null,
      `Interlocutor: ${contactDetail.displayName}. Etiquetas: ${tagsLine}. Oportunidades abiertas: ${commercialLine}. Seguimientos: ${followupLine}.`,
      notesLine ? `Notas del contacto (internas): ${notesLine}${(contactDetail.notes?.trim().length ?? 0) > 500 ? "… (texto completo en leer_contexto_comercial)" : ""}.` : null,
      notes.items.length ? `Notas operativas recientes (internas; no las reproduzcas al interlocutor):\n${notes.items.map(n => `${n.at}: ${n.body}`).join("\n")}${notes.nextCursor ? "\nHay más notas: usa leer_contexto_comercial con cursor de notas para consultarlas." : ""}` : null,
      customLine ? `Campos (resumen; valores completos en leer_contexto_comercial): ${customLine}.` : null,
      crossBlock,
      policyLine,
      knowledgeBlock,
    ]
      .filter(Boolean)
      .join("\n\n")
    const history = historyToMessages(items)
    if (toolCtx.draftText?.trim()) history.push(new HumanMessage({ content: toolCtx.draftText.trim().slice(0, 4000) }))
    return { messages: [new SystemMessage({ content: system }), ...history] }
  }

  async function llm(state: typeof AgentState.State) {
    const reply = await modelWithTools.invoke(state.messages)
    trackUsage(toolCtx, reply)
    return { messages: [reply] }
  }

  function routeAfterLlm(state: typeof AgentState.State): string {
    const last = state.messages[state.messages.length - 1]
    if (last instanceof AIMessage && last.tool_calls && last.tool_calls.length > 0) return "tools"
    return END
  }

  async function runTools(state: typeof AgentState.State) {
    const last = state.messages[state.messages.length - 1]
    if (last instanceof AIMessage && last.tool_calls) {
      for (const call of last.tool_calls) {
        if (call.name && !toolCtx.toolsUsed.includes(call.name)) toolCtx.toolsUsed.push(call.name)
      }
    }
    const out = await toolNode.invoke(state)
    return { messages: out.messages ?? [], turnCount: state.turnCount + 1 }
  }

  async function routeAfterTools(state: typeof AgentState.State): Promise<string> {
    if (toolCtx.decisionRecorded || toolCtx.handedOff) return END
    const maxTurns = await withOrgContext(toolCtx.db, toolCtx.orgId, async (tx) => {
      const cfg = await getAgentConfig(tx, toolCtx.orgId)
      return cfg.maxTurns
    })
    if (state.turnCount >= maxTurns) {
      await performHandoff(toolCtx, "límite de turnos del agente")
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
