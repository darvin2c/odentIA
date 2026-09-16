import type { Db } from "@odentia/db"
import { agentConfig } from "@odentia/db/schema/crm"
import { eq } from "drizzle-orm"
import { validation } from "./errors.js"

export interface AgentConfig {
  organizationId: string
  enabled: boolean
  model: string | null
  systemPrompt: string
  handoffKeywords: string[]
  maxTurns: number
}

const DEFAULTS = {
  enabled: false,
  model: null as string | null,
  systemPrompt: "",
  handoffKeywords: [] as string[],
  maxTurns: 10,
}

function toConfig(row: typeof agentConfig.$inferSelect): AgentConfig {
  return {
    organizationId: row.organizationId,
    enabled: row.enabled,
    model: row.model,
    systemPrompt: row.systemPrompt,
    handoffKeywords: row.handoffKeywords,
    maxTurns: row.maxTurns,
  }
}

export async function getAgentConfig(tx: Db, orgId: string): Promise<AgentConfig> {
  const [row] = await tx
    .select()
    .from(agentConfig)
    .where(eq(agentConfig.organizationId, orgId))
    .limit(1)
  if (!row) return { organizationId: orgId, ...DEFAULTS, handoffKeywords: [] }
  return toConfig(row)
}

export async function upsertAgentConfig(
  tx: Db,
  orgId: string,
  input: {
    enabled?: boolean
    model?: string | null
    systemPrompt?: string
    handoffKeywords?: string[]
    maxTurns?: number
  },
): Promise<AgentConfig> {
  if (
    input.maxTurns !== undefined &&
    (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 50)
  ) {
    throw validation("maxTurns debe ser entero entre 1 y 50")
  }
  if (
    input.handoffKeywords !== undefined &&
    input.handoffKeywords.some((k) => typeof k !== "string")
  ) {
    throw validation("handoffKeywords debe ser lista de texto")
  }
  const [row] = await tx
    .insert(agentConfig)
    .values({ organizationId: orgId, ...DEFAULTS, ...input })
    .onConflictDoUpdate({
      target: agentConfig.organizationId,
      set: { ...input, updatedAt: new Date() },
    })
    .returning()
  if (!row) throw new Error("No se pudo guardar la configuración del agente")
  return toConfig(row)
}
