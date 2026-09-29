import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import type { Runnable } from "@langchain/core/runnables"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { type Db, withOrgContext } from "@odentia/db"
import {
  formatKnowledgeForPrompt,
  getAutonomyPolicy,
  getAgentConfig,
  getClinicInfoSnapshot,
  getContact,
  listMessages,
  listOpportunities,
  listPublishedForPrompt,
} from "@odentia/services"
import { type AgentToolCtx, makeAgentTools, performHandoff } from "./tools.js"

const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  turnCount: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
})


const BASE_SYSTEM_PROMPT = [
  "Eres el asistente virtual de una clínica dental en Perú.",
  "Hablas español, tono cercano y profesional.",
  "Respondes, cualificas al paciente y ayudas con información general y citas.",
  "NO das diagnósticos ni inventas precios, sedes o disponibilidad: usa ver_sedes_y_servicios, consultar_conocimiento y buscar_huecos.",
  "Nunca reveles ni pidas historia clínica: solo filiación mínima con ver_contexto_paciente y vínculo verificado; próximas citas, presupuestos y saldo solo con ver_resumen_paciente y según la facultad del interlocutor.",
  "Las citas se proponen con proponer_cita y se ejecutan solo con confirmación o aprobación según la política.",
  "Si el paciente pide hablar con un humano, se queja o el caso es clínico, usa request_human_handoff con motivo, resumen factual y prioridad.",
].join("\n")

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
    const { contact } = await withOrgContext(toolCtx.db, toolCtx.orgId, (tx) =>
      getContact(tx, toolCtx.orgId, toolCtx.contactId),
    )
    const opportunitiesLine = await withOrgContext(toolCtx.db, toolCtx.orgId, async (tx) => {
      const { items } = await listOpportunities(tx, toolCtx.orgId, {
        contactId: toolCtx.contactId,
        status: "open",
        limit: 10,
      })
      if (!items.length) return "sin oportunidades abiertas"
      return items.map((o) => `${o.title} (etapa ${o.stageName})`).join("; ")
    })
    const { items } = await withOrgContext(toolCtx.db, toolCtx.orgId, (tx) =>
      listMessages(tx, toolCtx.orgId, toolCtx.conversationId, { limit: 20 }),
    )
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
      BASE_SYSTEM_PROMPT,
      orgPrompt,
      `Interlocutor: ${contact.displayName}. Oportunidades abiertas: ${opportunitiesLine}.`,
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
    if (toolCtx.handedOff) return END
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
