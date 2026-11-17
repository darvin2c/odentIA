import type { Db } from "@odentia/db"
import {
  type AdminActor,
  attendEmailThread,
  CLIENT_PHASES,
  getEmailThread,
  INBOX_CHANNELS,
  INBOX_LIMIT_MAX,
  INBOX_STATES,
  inboxCounts,
  issueFields,
  listInbox,
  ServiceError,
  settleConversation,
  unsettleConversation,
} from "@odentia/services"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import { adminContextOf } from "../lib/admin-context.js"
import { runService } from "./helpers.js"

/**
 * La Bandeja de la administración (`/api/admin/inbox`, tras el guard de admin; ADR 0196): lo que
 * nos escriben por correo, WhatsApp, Instagram y Messenger, una conversación por persona y canal,
 * con su estado. Solo Administración: Soporte trabaja en su cola y aquí recibe 403.
 *
 * Responder no está aquí: un correo se responde con la operación de siempre
 * (`POST /api/admin/clients/inbound/:emailId/reply`) y un chat, en su conversación
 * (`POST /api/admin/chats/:id/reply`); la respuesta que dejó lista Kairós se envía o se cambia con
 * su ítem (`POST /api/admin/kairos/items/:id/decide`).
 */
export interface AdminInboxDeps {
  /** Las tablas del ARM viven en `admin`, sin GRANT a la app: solo la conexión propietaria. */
  ownerDb: Db
  /** Solo las pruebas lo cambian. */
  now?: () => Date
}

const listQuery = z.object({
  estado: z
    .enum(
      [...INBOX_STATES, "todas"] as const,
      "Elige te toca, Kairós respondió, respondida o todas",
    )
    .optional(),
  cliente: z
    .union([z.literal("sin"), z.uuid("El cliente no es válido")], "El cliente no es válido")
    .optional(),
  fase: z.enum(CLIENT_PHASES, "Esa fase no existe").optional(),
  canal: z.enum(INBOX_CHANNELS, "Elige correo, WhatsApp, Instagram o Messenger").optional(),
  limit: z.coerce
    .number("El tope es un número")
    .int("El tope es entero")
    .min(1, `El tope va de 1 a ${INBOX_LIMIT_MAX}`)
    .max(INBOX_LIMIT_MAX, `El tope va de 1 a ${INBOX_LIMIT_MAX}`)
    .optional(),
})

const attendBody = z.strictObject({
  on: z.boolean("Di si lo atiendes tú o lo sueltas"),
})

const markBody = z.strictObject({
  kind: z.enum(["chat", "correo"], "Elige un chat o un correo"),
  /** El chat, o cualquier correo del hilo. */
  id: z.uuid("Esa conversación no existe"),
})

function adminOf(c: Context): AdminActor {
  const actor = adminContextOf(c)
  if (actor.role !== "admin")
    throw new ServiceError("FORBIDDEN", 403, "Solo el rol Administración puede hacer esto")
  return actor
}

/** Valida lanzando: así el rol se revisa antes que el cuerpo. */
function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success)
    throw new ServiceError(
      "VALIDATION",
      400,
      parsed.error.issues[0]?.message ?? "Revisa los datos marcados.",
      issueFields(parsed.error.issues),
    )
  return parsed.data
}

const bodyOf = (c: Context) => c.req.json().catch(() => null)

export function createAdminInboxRoute(deps: AdminInboxDeps) {
  const app = new Hono()
  const clock = deps.now ?? (() => new Date())
  const owner = <T>(fn: (tx: Db) => Promise<T>): Promise<T> =>
    deps.ownerDb.transaction((tx) => fn(tx as Db))
  const adminRun = <T>(c: Context, status: 200 | 201, fn: (actor: AdminActor) => Promise<T>) =>
    runService(c, status, () => fn(adminOf(c)))

  /** Las conversaciones del filtro y, de todas, cuántas te tocan. */
  app.get("/", (c) =>
    adminRun(c, 200, (actor) => {
      const query = parse(listQuery, c.req.query())
      return owner((tx) => listInbox(tx, actor, query, clock()))
    }),
  )

  /** El número del menú: solo lo que te toca. */
  app.get("/count", (c) =>
    adminRun(c, 200, (actor) => owner((tx) => inboxCounts(tx, actor, clock()))),
  )

  /** El hilo entero de un correo, a partir de cualquiera de sus correos. */
  app.get("/correo/:emailId", (c) =>
    adminRun(c, 200, (actor) =>
      owner((tx) => getEmailThread(tx, actor, c.req.param("emailId"), clock())),
    ),
  )

  /** «Lo atiendo yo» en un correo (`on: true`), o soltarlo. */
  app.post("/correo/:emailId/attend", async (c) => {
    const raw = await bodyOf(c)
    return adminRun(c, 200, (actor) => {
      const body = parse(attendBody, raw)
      return owner((tx) => attendEmailThread(tx, actor, c.req.param("emailId"), body.on, clock()))
    })
  })

  /** «No necesita respuesta» y deshacerlo, en un chat o en el hilo de un correo. */
  app.post("/settle", async (c) => {
    const raw = await bodyOf(c)
    return adminRun(c, 200, (actor) => {
      const body = parse(markBody, raw)
      return owner((tx) => settleConversation(tx, actor, body, clock()))
    })
  })
  app.post("/unsettle", async (c) => {
    const raw = await bodyOf(c)
    return adminRun(c, 200, (actor) => {
      const body = parse(markBody, raw)
      return owner((tx) => unsettleConversation(tx, actor, body, clock()))
    })
  })

  return app
}
