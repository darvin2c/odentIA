import { createHash } from "node:crypto"
import type { Db } from "@odentia/db"
import { agentDecisionLog } from "@odentia/db/schema/agent"
import { and, desc, eq, sql } from "drizzle-orm"
import { validation } from "./errors.js"

/* ---------- Libro de decisiones del modelo de decisión (sombra) ---------- */

export interface RecordDecisionInput {
  conversationId?: string | null
  triggerMessageId?: string | null
  point: string
  /** `shadow` (por defecto): solo se compara. `retrieval`: eligió conocimiento. `route`: eligió el camino del turno. */
  mode?: "shadow" | "retrieval" | "route"
  provider: string
  model?: string | null
  /** Texto enviado al proveedor: solo se guarda su huella y longitud. */
  state: string
  answers: unknown[]
  outcome?: Record<string, unknown> | null
  latencyMs?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  error?: string | null
}

export async function recordAgentDecision(tx: Db, orgId: string, input: RecordDecisionInput): Promise<string> {
  if (!input.point.trim()) throw validation("point es obligatorio")
  const clean = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null
  const [row] = await tx
    .insert(agentDecisionLog)
    .values({
      organizationId: orgId,
      conversationId: input.conversationId ?? null,
      triggerMessageId: input.triggerMessageId ?? null,
      point: input.point,
      mode: input.mode ?? "shadow",
      provider: input.provider,
      model: input.model ?? null,
      stateHash: createHash("sha256").update(input.state).digest("hex"),
      stateChars: input.state.length,
      answers: input.answers,
      outcome: input.outcome ?? null,
      latencyMs: clean(input.latencyMs),
      inputTokens: clean(input.inputTokens),
      outputTokens: clean(input.outputTokens),
      error: input.error?.slice(0, 300) ?? null,
    })
    .returning({ id: agentDecisionLog.id })
  if (!row) throw new Error("No se pudo registrar la decisión")
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind: "agent.decision.recorded", at: new Date().toISOString() })})`)
  return row.id
}

export interface AgentDecisionItem {
  id: string
  conversationId: string | null
  triggerMessageId: string | null
  point: string
  mode: string
  provider: string
  model: string | null
  answers: unknown[]
  outcome: Record<string, unknown> | null
  latencyMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  error: string | null
  createdAt: string
}

export async function listAgentDecisions(
  tx: Db,
  orgId: string,
  input: { conversationId?: string; limit?: number } = {},
): Promise<AgentDecisionItem[]> {
  const conditions = [eq(agentDecisionLog.organizationId, orgId)]
  if (input.conversationId) conditions.push(eq(agentDecisionLog.conversationId, input.conversationId))
  const limit = input.limit === undefined || !Number.isFinite(input.limit) ? 50 : Math.min(Math.max(Math.floor(input.limit), 1), 200)
  const rows = await tx
    .select()
    .from(agentDecisionLog)
    .where(and(...conditions))
    .orderBy(desc(agentDecisionLog.createdAt), desc(agentDecisionLog.id))
    .limit(limit)
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    triggerMessageId: r.triggerMessageId,
    point: r.point,
    mode: r.mode,
    provider: r.provider,
    model: r.model,
    answers: r.answers,
    outcome: r.outcome,
    latencyMs: r.latencyMs,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
  }))
}
