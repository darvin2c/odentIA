import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { withOrgContext, type AgentRunJob, type Db, type QueueMessage } from "@odentia/db";
import { auditEvent } from "@odentia/db/schema/org";
import { conversation, message } from "@odentia/db/schema/crm";
import { getAgentConfig } from "@odentia/services";
import { and, desc, eq, sql } from "drizzle-orm";
import { compileAgentGraph, createChatModel } from "./graph.js";
import { performHandoff, type AgentToolCtx } from "./tools.js";
export interface AgentRuntime {
  checkpointer: PostgresSaver;
  modelName: string;
  secretsKey: Buffer;
  callbacks?: Callbacks;
}

function matchesHandoff(text: string | null, keywords: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some((k) => k.trim() !== "" && lower.includes(k.trim().toLowerCase()));
}

/**
 * Ejecuta una corrida del agente. Devuelve "done" (ack) o "retry".
 * Excepción → no ack (1 reintento vía vt); con read_ct>=2 audita
 * `agent.error`, deriva a humano y hace ack.
 */
export async function processAgentRun(
  db: Db,
  runtime: AgentRuntime,
  msg: QueueMessage<AgentRunJob>,
): Promise<"done" | "retry"> {
  const { orgId, conversationId, triggerMessageId } = msg.message;
  try {
    const skip = await withOrgContext(db, orgId, async (tx) => {
      const [conv] = await tx
        .select()
        .from(conversation)
        .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
        .limit(1);
      if (!conv) return "missing-conversation";
      if (conv.agentStatus !== "on") return "agent-off";
      const cfg = await getAgentConfig(tx, orgId);
      if (!cfg.enabled) return "agent-disabled";
      const [trigger] = await tx
        .select()
        .from(message)
        .where(and(eq(message.id, triggerMessageId), eq(message.organizationId, orgId)))
        .limit(1);
      if (!trigger) return "missing-trigger";
      if (matchesHandoff(trigger.body, cfg.handoffKeywords)) {
        const toolCtx: AgentToolCtx = {
          db,
          orgId,
          conversationId,
          contactId: conv.contactId,
          secretsKey: runtime.secretsKey,
          handedOff: false,
        };
        await performHandoff(toolCtx, `palabra clave en: ${(trigger.body ?? "").slice(0, 120)}`);
        return "handoff";
      }
      // Ráfaga superseded: el trigger ya no está entre los últimos 5 inbound.
      const recent = await tx
        .select({ id: message.id })
        .from(message)
        .where(and(eq(message.conversationId, conversationId), eq(message.direction, "in")))
        .orderBy(desc(message.createdAt), desc(message.id))
        .limit(5);
      if (!recent.some((r) => r.id === triggerMessageId)) return "superseded";
      return null;
    });
    if (skip) return "done";

    const toolCtx: AgentToolCtx = await withOrgContext(db, orgId, async (tx) => {
      const [conv] = await tx
        .select()
        .from(conversation)
        .where(eq(conversation.id, conversationId))
        .limit(1);
      if (!conv) throw new Error("Conversación no encontrada");
      return {
        db,
        orgId,
        conversationId,
        contactId: conv.contactId,
        secretsKey: runtime.secretsKey,
        handedOff: false,
      };
    });
    const model = createChatModel(runtime.modelName);
    const graph = compileAgentGraph(model, toolCtx, runtime.checkpointer);
    await graph.invoke(
      { messages: [], turnCount: 0 },
      {
        configurable: { thread_id: `${orgId}:${conversationId}` },
        ...(runtime.callbacks ? { callbacks: runtime.callbacks } : {}),
      },
    );
    return "done";
  } catch (error) {
    if (msg.read_ct >= 2) {
      const detail = error instanceof Error ? error.message : String(error);
      await withOrgContext(db, orgId, async (tx) => {
        await tx.insert(auditEvent).values({
          organizationId: orgId,
          action: "agent.error",
          entity: "conversation",
          entityId: conversationId,
          metadata: { error: detail.slice(0, 500) },
        });
      }).catch(() => {});
      const toolCtx: AgentToolCtx = {
        db,
        orgId,
        conversationId,
        contactId: "",
        secretsKey: runtime.secretsKey,
        handedOff: false,
      };
      await performHandoff(toolCtx, "error del agente").catch(() => {});
      return "done";
    }
    return "retry";
  }
}

/** Ciclo completo: corre el agente y recién entonces hace ack. */
export async function consumeAgentRun(
  db: Db,
  runtime: AgentRuntime,
  msg: QueueMessage<AgentRunJob>,
): Promise<void> {
  const verdict = await processAgentRun(db, runtime, msg);
  if (verdict === "done") {
    await db.execute(sql`select pgmq.delete('agent_runs', ${Number(msg.msg_id)}::bigint)`);
  }
}
