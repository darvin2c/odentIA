import type { Db } from "@odentia/db"
import { type AutonomyAction, type AutonomyMode, agentPolicy } from "@odentia/db/schema/agent"
import * as schema from "@odentia/db/schema/index"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

export function openFixtureDb(url: string): { db: Db; close(): Promise<void> } {
  const client = postgres(url, { max: 1 })
  return { db: drizzle(client, { schema }), close: () => client.end() }
}

/**
 * Quién confirma cada acción es fijo en la aplicación (ADR 0021): ninguna
 * ruta lo cambia. Una prueba que necesita que el equipo apruebe un mensaje lo
 * fija aquí, en la base, como hacen las pruebas de servicios.
 */
export async function setAgentPolicy(
  db: Db,
  orgId: string,
  modes: Partial<Record<AutonomyAction, AutonomyMode>>,
): Promise<void> {
  await db
    .insert(agentPolicy)
    .values({ organizationId: orgId, modes })
    .onConflictDoUpdate({ target: agentPolicy.organizationId, set: { modes, updatedAt: new Date() } })
}
