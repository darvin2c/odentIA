import type { Db } from "@gestoria/db"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { cors } from "hono/cors"
import { requestId } from "hono/request-id"
import type { JWTVerifyGetKey } from "jose"
import { ZodError, type z } from "zod"
import {
  type AccountConfig,
  AccountError,
  accountKeys,
  type Person,
  readAccountToken,
  receiveAccountEvent,
  syncAccountCopy,
} from "./cuenta.js"
import {
  acceptInvitation,
  changeRole,
  createStore,
  invitationInput,
  inviteToStore,
  myStores,
  newStoreInput,
  removeMember,
  revokeInvitation,
  roleInput,
  StoreError,
  storeSummary,
  storeTeam,
} from "./tiendas.js"

export interface AppDeps {
  /** El rol de la aplicación: todo pedido de una persona, dentro de las reglas de su tienda. */
  appDb: Db
  /** El dueño de la base: la copia de las cuentas y los avisos. */
  ownerDb: Db
  account: AccountConfig
  /** La dirección de la app (`https://app.gestoria24.com`): el único origen que la llama y la base de los enlaces. */
  webURL: string
}

type Env = { Variables: { person: Person } }

/** Lo más que pesa un aviso de la cuenta o un pedido de la app. */
const MAX_BODY_BYTES = 64 * 1024

function errorBody(c: Context, code: string, message: string, fields?: Record<string, string>) {
  return {
    error: { code, message, ...(fields ? { fields } : {}) },
    requestId: c.get("requestId") as string | undefined,
  }
}

async function bodyOf<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new StoreError(400, "VALIDATION_ERROR", "El pedido no se pudo leer")
  }
  return schema.parse(raw)
}

/**
 * El servidor de gestorIA (ADR 0203): su API, aparte de la de las clínicas. Reconoce a la
 * persona por el token de la cuenta (`Authorization: Bearer`), nunca por una cookie: su
 * pantalla está en otro origen y no hay sesión propia que robar.
 */
export function createApp(deps: AppDeps) {
  const keys: JWTVerifyGetKey = accountKeys(deps.account)
  const webOrigin = new URL(deps.webURL).origin
  const app = new Hono<Env>()

  app.use("*", requestId())
  app.use(
    "/api/*",
    cors({
      origin: (origin) => (origin === webOrigin ? origin : ""),
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE"],
      maxAge: 7200,
    }),
  )

  app.onError((error, c) => {
    if (error instanceof AccountError)
      return c.json(
        errorBody(c, error.code, error.message),
        error.code === "UNAUTHORIZED" ? 401 : 403,
      )
    if (error instanceof StoreError)
      return c.json(errorBody(c, error.code, error.message, error.fields), error.status)
    if (error instanceof ZodError) {
      const fields: Record<string, string> = {}
      for (const issue of error.issues) {
        const key = issue.path.join(".")
        if (key && !fields[key]) fields[key] = issue.message
      }
      return c.json(
        errorBody(c, "VALIDATION_ERROR", error.issues[0]?.message ?? "Revisa los datos", fields),
        400,
      )
    }
    // Dos pedidos iguales a la vez (invitar dos veces, aceptar dos veces): uno gana.
    const cause = (error as { cause?: { code?: string } }).cause
    if ((error as { code?: string }).code === "23505" || cause?.code === "23505")
      return c.json(
        errorBody(c, "CONFLICT", "Eso ya se hizo hace un momento. Recarga para verlo."),
        409,
      )
    console.error("gestoria-api:", error)
    return c.json(errorBody(c, "INTERNAL", "Algo falló de nuestro lado. Inténtalo de nuevo."), 500)
  })

  // Tope de tamaño leído mientras llega (también sin `content-length`).
  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(errorBody(c, "PAYLOAD_TOO_LARGE", "Pedido demasiado grande"), 413),
    }),
  )

  app.get("/health", (c) => c.json({ ok: true }))

  // Los avisos firmados de la cuenta (Standard Webhooks): de servidor a servidor, sin CORS.
  app.post("/avisos/cuenta", async (c) => {
    if (Number(c.req.header("content-length") ?? "0") > MAX_BODY_BYTES)
      return c.json(errorBody(c, "PAYLOAD_TOO_LARGE", "Aviso demasiado grande"), 413)
    const body = await c.req.text()
    if (body.length > MAX_BODY_BYTES)
      return c.json(errorBody(c, "PAYLOAD_TOO_LARGE", "Aviso demasiado grande"), 413)
    const result = await receiveAccountEvent(deps.ownerDb, deps.account, {
      headers: c.req.raw.headers,
      body,
    })
    return c.json({ message: result.message }, result.status)
  })

  // Todo lo de /api pide el token de la cuenta y una copia activa.
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next()
    const header = c.req.header("authorization") ?? ""
    const token = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header)?.[1]
    if (!token) return c.json(errorBody(c, "UNAUTHORIZED", "Entra con tu cuenta para seguir."), 401)
    const claims = await readAccountToken(token, deps.account, keys)
    c.set("person", await syncAccountCopy(deps.ownerDb, claims))
    return next()
  })

  app.get("/api/yo", async (c) => {
    const person = c.get("person")
    return c.json({ person, ...(await myStores(deps.appDb, person)) })
  })

  app.post("/api/tiendas", async (c) => {
    const input = await bodyOf(c, newStoreInput)
    return c.json({ store: await createStore(deps.appDb, c.get("person"), input) }, 201)
  })

  app.get("/api/tiendas/:id", async (c) =>
    c.json({ store: await storeSummary(deps.appDb, c.get("person"), c.req.param("id")) }),
  )

  app.get("/api/tiendas/:id/equipo", async (c) =>
    c.json(await storeTeam(deps.appDb, c.get("person"), c.req.param("id"))),
  )

  app.post("/api/tiendas/:id/invitaciones", async (c) => {
    const input = await bodyOf(c, invitationInput)
    const invitation = await inviteToStore(deps.appDb, c.get("person"), c.req.param("id"), input)
    return c.json(
      { invitation: { ...invitation, link: `${webOrigin}/invitacion/${invitation.id}` } },
      201,
    )
  })

  app.delete("/api/tiendas/:id/invitaciones/:invitationId", async (c) => {
    await revokeInvitation(
      deps.appDb,
      c.get("person"),
      c.req.param("id"),
      c.req.param("invitationId"),
    )
    return c.body(null, 204)
  })

  app.patch("/api/tiendas/:id/equipo/:userId", async (c) => {
    const { role } = await bodyOf(c, roleInput)
    await changeRole(deps.appDb, c.get("person"), c.req.param("id"), c.req.param("userId"), role)
    return c.body(null, 204)
  })

  app.delete("/api/tiendas/:id/equipo/:userId", async (c) => {
    await removeMember(deps.appDb, c.get("person"), c.req.param("id"), c.req.param("userId"))
    return c.body(null, 204)
  })

  app.post("/api/invitaciones/:id/aceptar", async (c) =>
    c.json(await acceptInvitation(deps.appDb, c.get("person"), c.req.param("id"))),
  )

  app.notFound((c) => c.json(errorBody(c, "NOT_FOUND", "Recurso no encontrado"), 404))
  return app
}
