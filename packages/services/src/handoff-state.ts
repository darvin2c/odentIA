import { type SQL, sql } from "drizzle-orm"

/**
 * Derivación sin resolver: sin tarea, o con su tarea aún abierta (resuelta =
 * tarea completada o cancelada). Única definición para listar, contar y tomar
 * derivaciones y para filtrar la bandeja. `handoff` es la tabla o el alias de
 * `agent_handoff` en la consulta que lo usa.
 */
export function handoffOpenSql(handoff: SQL): SQL {
  return sql`(${handoff}.task_id is null or exists (
    select 1 from task t_open
    where t_open.id = ${handoff}.task_id
      and t_open.organization_id = ${handoff}.organization_id
      and t_open.status = 'open'))`
}
