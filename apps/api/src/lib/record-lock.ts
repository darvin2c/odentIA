import { type Db, withOrgContext } from "@odentia/db"
import { type RecordLockState, personRecordLock, recordLockState } from "@odentia/services"
import type { Context, MiddlewareHandler } from "hono"
import { canAccess, orgContextOf } from "./context.js"
import { errorBody } from "./error.js"

const UUID = /^[0-9a-f-]{36}$/i

const writes = (c: Context) => !["GET", "HEAD", "OPTIONS"].includes(c.req.method)

/**
 * La misma guarda para cualquier ruta cuyo `:id` es la persona (contacto):
 * `/contacts/:id`, la página de la persona y lo que cuelga de ella. Null cuando
 * la petición sigue; si no, la respuesta de la historia bloqueada (ADR 0080).
 */
export async function personLockRefusal(c: Context, db: Db, personId: string): Promise<Response | null> {
  const { orgId, userId } = orgContextOf(c)
  const state = await withOrgContext(db, orgId, (tx) => personRecordLock(tx, orgId, userId, personId))
  return recordLockResponse(c, state, writes(c))
}

/** La misma guarda desde la ficha (`patientId`): null cuando la petición sigue. */
export async function patientLockRefusal(c: Context, db: Db, patientId: string): Promise<Response | null> {
  if (!UUID.test(patientId)) return null
  const { orgId, userId } = orgContextOf(c)
  const state = await withOrgContext(db, orgId, (tx) => recordLockState(tx, orgId, userId, patientId))
  return recordLockResponse(c, state, writes(c))
}

/** Los nombres con que una petición señala a una ficha o a una persona fuera de su dirección. */
const PATIENT_KEYS = ["patientId"] as const
const PERSON_KEYS = ["contactId", "personId", "toContactId"] as const

/**
 * La guarda de la historia bloqueada (ADR 0080) para toda ruta que nombra a la
 * ficha o a la persona en la consulta (`?patientId=`) o en el cuerpo JSON, y no
 * en su dirección: órdenes, consentimientos, formularios, citas, tareas, «pasar
 * la cuenta»… Así una ruta nueva no puede olvidarla. Las que la nombran en la
 * dirección (`/patients/:id`, `/people/:id`, `/contacts/:id`) llevan la suya.
 * Hono guarda el cuerpo leído: el manejador lo vuelve a leer igual.
 */
export function lockedRecordGuard(db: Db): MiddlewareHandler {
  return async (c, next) => {
    const named = await namedRecords(c)
    for (const patientId of named.patients) {
      const refusal = await patientLockRefusal(c, db, patientId)
      if (refusal) return refusal
    }
    for (const personId of named.people) {
      const refusal = await personLockRefusal(c, db, personId)
      if (refusal) return refusal
    }
    await next()
  }
}

async function namedRecords(c: Context): Promise<{ patients: Set<string>; people: Set<string> }> {
  const patients = new Set<string>()
  const people = new Set<string>()
  const take = (source: Record<string, unknown>) => {
    for (const key of PATIENT_KEYS) {
      const value = source[key]
      if (typeof value === "string" && UUID.test(value)) patients.add(value)
    }
    for (const key of PERSON_KEYS) {
      const value = source[key]
      if (typeof value === "string" && UUID.test(value)) people.add(value)
    }
  }
  take(c.req.query())
  if (writes(c) && c.req.header("content-type")?.includes("application/json")) {
    const body = await c.req.json().catch(() => null)
    if (body && typeof body === "object" && !Array.isArray(body)) take(body as Record<string, unknown>)
  }
  return { patients, people }
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
