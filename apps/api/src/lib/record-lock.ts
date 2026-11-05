import { type Db, withOrgContext } from "@odentia/db"
import { type RecordLockState, personRecordLock, recordLockState } from "@odentia/services"
import type { Context, MiddlewareHandler } from "hono"
import { canAccess, orgContextOf } from "./context.js"
import { errorBody } from "./error.js"

const writes = (c: Context) => !["GET", "HEAD", "OPTIONS"].includes(c.req.method)

/**
 * El uuid como lo lee PostgreSQL, en su forma de siempre: también acepta las
 * mayúsculas, las llaves y los 32 dígitos sin guiones, así que la guarda los
 * reconoce igual (si no, un id escrito de otra forma la saltaría). Null si no
 * es un uuid: entonces la ruta lo rechaza o no encuentra nada.
 */
export function canonicalUuid(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null
  const hex = value.trim().replace(/^\{|\}$/g, "").replaceAll("-", "").toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return null
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * La misma guarda para cualquier ruta cuyo `:id` es la persona (contacto):
 * `/contacts/:id`, la página de la persona y lo que cuelga de ella. Null cuando
 * la petición sigue; si no, la respuesta de la historia bloqueada (ADR 0080).
 * `missing` es lo que la ruta diría si no existiera, para que el 404 sea el mismo.
 */
export async function personLockRefusal(
  c: Context,
  db: Db,
  personId: string | undefined,
  missing = "Contacto no encontrado",
): Promise<Response | null> {
  const id = canonicalUuid(personId)
  if (!id) return null
  const { orgId, userId } = orgContextOf(c)
  const state = await withOrgContext(db, orgId, (tx) => personRecordLock(tx, orgId, userId, id))
  return recordLockResponse(c, state, writes(c), missing)
}

/** La misma guarda desde la ficha (`patientId`): null cuando la petición sigue. */
export async function patientLockRefusal(
  c: Context,
  db: Db,
  patientId: string | undefined,
  missing = "Paciente no encontrado",
): Promise<Response | null> {
  const id = canonicalUuid(patientId)
  if (!id) return null
  const { orgId, userId } = orgContextOf(c)
  const state = await withOrgContext(db, orgId, (tx) => recordLockState(tx, orgId, userId, id))
  return recordLockResponse(c, state, writes(c), missing)
}

/** Los nombres con que una petición señala a una ficha o a una persona fuera de su dirección. */
const PATIENT_KEYS = ["patientId"] as const
const PERSON_KEYS = ["contactId", "personId", "toContactId"] as const

/**
 * Los cuerpos que pueden traer JSON: sin tipo, JSON o texto. Un formulario o un
 * archivo (imagen, PDF, DICOM) no se toca: leerlo como texto lo dañaría para
 * el manejador.
 */
const MAYBE_JSON = /^$|json|^text\/plain/i

/**
 * La guarda de la historia bloqueada (ADR 0080) para toda ruta que nombra a la
 * ficha o a la persona en la consulta (`?patientId=`) o en el cuerpo, y no en
 * su dirección: órdenes, consentimientos, formularios, citas, tareas, «pasar la
 * cuenta»… Así una ruta nueva no puede olvidarla. Las que la nombran en la
 * dirección (`/patients/:id`, `/people/:id`, `/contacts/:id`) llevan la suya.
 *
 * El cuerpo se lee como JSON aunque no diga su tipo: los manejadores lo leen
 * con `c.req.json()` sin mirarlo, así que la guarda no puede fiarse de él.
 * Hono guarda el texto leído y el manejador lo vuelve a leer igual.
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
      const id = canonicalUuid(source[key] as string)
      if (id) patients.add(id)
    }
    for (const key of PERSON_KEYS) {
      const id = canonicalUuid(source[key] as string)
      if (id) people.add(id)
    }
  }
  take(c.req.query())
  if (writes(c) && MAYBE_JSON.test((c.req.header("content-type") ?? "").trim())) {
    const body = await c.req.json().catch(() => null)
    if (body && typeof body === "object" && !Array.isArray(body)) take(body as Record<string, unknown>)
  }
  return { patients, people }
}

/**
 * La guarda de una historia bloqueada (ADR 0080) para las rutas de la ficha y
 * de la persona. Quien no puede abrirla recibe 404, con lo mismo que diría la
 * ruta si no existiera (`missing`): ni siquiera sabe que existe. Administración
 * recibe 423 para mostrar la pantalla de la historia bloqueada, salvo que la
 * haya abierto con motivo y solo esté leyendo. Devuelve null cuando la
 * petición sigue.
 */
export function recordLockResponse(
  c: Context,
  state: RecordLockState | null,
  write: boolean,
  missing = "No encontrado",
): Response | null {
  if (!state?.locked) return null
  const { memberRole } = orgContextOf(c)
  if (!canAccess(memberRole, "patients.erase")) return c.json(errorBody(c, "NOT_FOUND", missing), 404)
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
