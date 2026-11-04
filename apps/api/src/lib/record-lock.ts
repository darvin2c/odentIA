import { type Db, withOrgContext } from "@odentia/db"
import { type RecordLockState, personRecordLock } from "@odentia/services"
import type { Context } from "hono"
import { canAccess, orgContextOf } from "./context.js"
import { errorBody } from "./error.js"

/**
 * La misma guarda para cualquier ruta cuyo `:id` es la persona (contacto):
 * `/contacts/:id`, la página de la persona y lo que cuelga de ella. Null cuando
 * la petición sigue; si no, la respuesta de la historia bloqueada (ADR 0080).
 */
export async function personLockRefusal(c: Context, db: Db, personId: string): Promise<Response | null> {
  const { orgId, userId } = orgContextOf(c)
  const state = await withOrgContext(db, orgId, (tx) => personRecordLock(tx, orgId, userId, personId))
  return recordLockResponse(c, state, !["GET", "HEAD", "OPTIONS"].includes(c.req.method))
}

/**
 * La guarda de una historia bloqueada (ADR 0080) para las rutas de la ficha y
 * de la persona. Quien no puede abrirla recibe 404: ni siquiera sabe que
 * existe. Administración recibe 423 para mostrar la pantalla de la historia
 * bloqueada, salvo que la haya abierto con motivo y solo esté leyendo.
 * Devuelve null cuando la petición sigue.
 */
export function recordLockResponse(c: Context, state: RecordLockState | null, write: boolean): Response | null {
  if (!state?.locked) return null
  const { memberRole } = orgContextOf(c)
  if (!canAccess(memberRole, "patients.erase")) return c.json(errorBody(c, "NOT_FOUND", "No encontrado"), 404)
  if (state.openUntil && !write) return null
  return c.json(
    errorBody(
      c,
      "RECORD_LOCKED",
      state.openUntil ? "La historia está abierta solo para leer" : "Esta historia está bloqueada",
    ),
    423,
  )
}
