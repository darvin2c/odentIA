import { type SQL, sql } from "drizzle-orm"

/** Plazo de confirmación por el interlocutor antes de expirar la propuesta. */
export const CONFIRM_TTL_HOURS = 48

/**
 * Propuesta que sigue esperando decisión: `propuesta` y dentro del plazo. La
 * caducidad es perezosa, así que una fila vencida puede seguir `propuesta`
 * hasta la siguiente lectura que la consolide; quien solo consulta filtra por
 * tiempo en vez de escribir. `proposal` es la tabla o el alias de
 * `agent_proposal`.
 */
export function proposalPendingSql(proposal: SQL): SQL {
  return sql`(${proposal}.status = 'propuesta' and ${proposal}.created_at > now() - make_interval(hours => ${CONFIRM_TTL_HOURS}))`
}
