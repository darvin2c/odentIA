import { type Db, withOrgContext } from "@odentia/db"
import { message } from "@odentia/db/schema/crm"
import { recordAgentDecision } from "@odentia/services"
import { and, desc, eq, lt } from "drizzle-orm"
import { TRIAGE_QUESTIONS, TRIAGE_VERSION, triageOutcome, triageState } from "./points.js"
import { DecisionError, type DecisionModel, type DecisionResult } from "./port.js"

/**
 * Modo sombra: tras la corrida, el modelo de decisión responde el triaje del
 * mensaje disparador y el resultado solo se registra. Ningún fallo aquí
 * afecta al turno; un error del proveedor queda como fila con `error`.
 */
export async function runShadowTriage(
  db: Db,
  orgId: string,
  decision: DecisionModel,
  input: { conversationId: string; triggerMessageId: string },
): Promise<void> {
  const { state } = await withOrgContext(db, orgId, async (tx) => {
    const [trigger] = await tx
      .select({ body: message.body, createdAt: message.createdAt })
      .from(message)
      .where(and(eq(message.id, input.triggerMessageId), eq(message.organizationId, orgId)))
      .limit(1)
    if (!trigger) return { state: null }
    // Solo mensajes anteriores del propio contacto: lo que escribió la
    // clínica puede llevar nombre o datos de la cita y no sale al proveedor.
    const previous = await tx
      .select({ body: message.body })
      .from(message)
      .where(
        and(
          eq(message.conversationId, input.conversationId),
          eq(message.direction, "in"),
          lt(message.createdAt, trigger.createdAt),
        ),
      )
      .orderBy(desc(message.createdAt), desc(message.id))
      .limit(2)
    return {
      state: triageState(
        previous.reverse().map((m) => ({ direction: "in" as const, body: m.body })),
        trigger.body ?? "[attachment]",
      ),
    }
  })
  if (state === null) return
  const base = { conversationId: input.conversationId, triggerMessageId: input.triggerMessageId, point: TRIAGE_VERSION, provider: decision.provider, state }
  let result: DecisionResult
  try {
    result = await decision.decide(state, TRIAGE_QUESTIONS)
  } catch (error) {
    const detail = error instanceof DecisionError ? `${error.code}: ${error.message}` : "fallo inesperado del modelo de decisión"
    await withOrgContext(db, orgId, (tx) => recordAgentDecision(tx, orgId, { ...base, answers: [], error: detail }))
    return
  }
  await withOrgContext(db, orgId, (tx) =>
    recordAgentDecision(tx, orgId, {
      ...base,
      model: result.model,
      answers: result.answers,
      outcome: triageOutcome(result),
      latencyMs: result.latencyMs,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
    }),
  )
}

/** Registra que el modelo de decisión no pudo construirse (sin credenciales de plataforma). */
export async function recordShadowUnavailable(
  db: Db,
  orgId: string,
  provider: string,
  input: { conversationId: string; triggerMessageId: string },
  error: unknown,
): Promise<void> {
  const detail = error instanceof DecisionError ? `${error.code}: ${error.message}` : "no se pudo preparar el modelo de decisión"
  await withOrgContext(db, orgId, (tx) =>
    recordAgentDecision(tx, orgId, { ...input, point: TRIAGE_VERSION, provider, state: "", answers: [], error: detail }),
  )
}
