import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import type { Runnable } from "@langchain/core/runnables"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { type Db, withOrgContext } from "@odentia/db"
import { pipelineStage } from "@odentia/db/schema/crm"
import { getAgentConfig, getContact, listMessages, requireContact } from "@odentia/services"
import { and, eq } from "drizzle-orm"
import { initChatModel } from "langchain/chat_models/universal"
import { FakeChatModel } from "./fake-model.js"
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
  "Respondes, cualificas al paciente y ayudas con información general.",
  "NO das diagnósticos ni inventas precios o disponibilidad: si te preguntan, ofrece derivar a un humano.",
  "Si el paciente pide hablar con un humano, se queja o el caso es clínico, usa request_human_handoff.",
].join("\n")

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

/** Crea el runnable del modelo (fake determinista o proveedor vía env). */
export function createChatModel(modelName: string): Runnable<BaseMessage[], AIMessage> {
  if (modelName === "fake")
    return new FakeChatModel({}) as unknown as Runnable<BaseMessage[], AIMessage>
  return initChatModel(modelName) as unknown as Runnable<BaseMessage[], AIMessage>
}

/**
 * Compila el grafo del agente para una corrida. El checkpointer usa conexión
 * de owner (el pool es compartido entre orgs y el GUC RLS no se puede fijar
 * por operación): el aislamiento lo da el thread_id exacto
 * `${orgId}:${conversationId}` más las policies RLS para el rol app.
 */
export function compileAgentGraph(
  model: Runnable<BaseMessage[], AIMessage>,
  toolCtx: AgentToolCtx,
  checkpointer: PostgresSaver,
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
    const stageName = await withOrgContext(toolCtx.db, toolCtx.orgId, async (tx) => {
      const full = await requireContact(tx, toolCtx.orgId, toolCtx.contactId)
      if (!full.stageId) return "sin etapa"
      const [stage] = await tx
        .select({ name: pipelineStage.name })
        .from(pipelineStage)
        .where(
          and(eq(pipelineStage.id, full.stageId), eq(pipelineStage.organizationId, toolCtx.orgId)),
        )
        .limit(1)
      return stage?.name ?? "sin etapa"
    })
    const { items } = await withOrgContext(toolCtx.db, toolCtx.orgId, (tx) =>
      listMessages(tx, toolCtx.orgId, toolCtx.conversationId, { limit: 20 }),
    )
    const orgPrompt = await withOrgContext(toolCtx.db, toolCtx.orgId, async (tx) => {
      const cfg = await getAgentConfig(tx, toolCtx.orgId)
      return cfg.systemPrompt
    })
    const system = [
      BASE_SYSTEM_PROMPT,
      orgPrompt,
      `Paciente: ${contact.displayName}. Etapa: ${stageName}.`,
    ]
      .filter(Boolean)
      .join("\n\n")
    return { messages: [new SystemMessage({ content: system }), ...historyToMessages(items)] }
  }

  async function llm(state: typeof AgentState.State) {
    const reply = await modelWithTools.invoke(state.messages)
    return { messages: [reply] }
  }

  function routeAfterLlm(state: typeof AgentState.State): string {
    const last = state.messages[state.messages.length - 1]
    if (last instanceof AIMessage && last.tool_calls && last.tool_calls.length > 0) return "tools"
    return END
  }

  async function runTools(state: typeof AgentState.State) {
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
    .compile({ checkpointer })

  return graph
}
