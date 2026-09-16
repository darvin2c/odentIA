import { sql } from "drizzle-orm"
import type { Db } from "./client.js"

/**
 * Tablas de LangGraph con thread_id (formato `${orgId}:${conversationId}`).
 * checkpoint_migrations queda SIN RLS a propósito: es un ledger de versión
 * sin columna thread_id ni datos de tenant (igual que inbound_event).
 */
const THREAD_TABLES = ["checkpoints", "checkpoint_blobs", "checkpoint_writes"] as const

/**
 * Aplica RLS por prefijo de thread_id a la memoria del agente. Idempotente
 * (re-ejecutable en cada boot). Falla ruidosamente si las tablas no existen:
 * nunca desactivar RLS para que pase.
 *
 * Policies:
 * - `agent_memory_org` (rol app): solo hilos cuyo prefijo es la org del GUC.
 * - `agent_memory_owner` (resto de roles): bypass por `current_user`, sin
 *   nombrar el rol owner (varía por entorno; el rol app es estable).
 */
export async function setupAgentMemory(ownerDb: Db): Promise<void> {
  for (const table of THREAD_TABLES) {
    // Nombres fijos: interpolación vía sql.raw (DO $$ no admite parámetros).
    const t = sql.raw(`"${table}"`)
    const lit = sql.raw(`'${table}'`)
    await ownerDb.execute(sql`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`)
    await ownerDb.execute(sql`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`)
    await ownerDb.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'public' AND tablename = ${lit} AND policyname = 'agent_memory_org'
        ) THEN
          CREATE POLICY agent_memory_org ON ${t} TO dentalagent_app
            USING (split_part(thread_id, ':', 1) = nullif(current_setting('app.org_id', true), ''));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'public' AND tablename = ${lit} AND policyname = 'agent_memory_owner'
        ) THEN
          CREATE POLICY agent_memory_owner ON ${t} TO PUBLIC
            USING (current_user <> 'dentalagent_app');
        END IF;
      END $$;
    `)
  }
}
