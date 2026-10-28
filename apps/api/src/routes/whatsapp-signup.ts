import type { MetaPlatformApp } from "@odentia/channels"
import { withOrgContext } from "@odentia/db"
import {
  assertSingleWhatsApp,
  closeWhatsAppSignup,
  openWhatsAppSignup,
  pendingSignupWork,
  redeemWhatsAppSignup,
  runSignupSteps,
  ServiceError,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

/** La app de odentIA en Meta con lo que el botón necesita para abrir su ventana. */
export interface MetaSignupConfig extends MetaPlatformApp {
  /** Configuración de «Facebook Login for Business» que define la versión 4 del flujo. */
  configId: string
  /** Con ella Meta verifica la dirección de avisos de la app. */
  webhookVerifyToken: string
}

/**
 * «Conectar con Facebook» es opcional: existe solo si están las cuatro
 * variables. Con alguna de menos no hay botón y nada más cambia; se dice cuáles
 * faltan para que una instalación a medias no pase por «apagado a propósito».
 */
export function metaSignupFromEnv(env: {
  META_APP_ID: string
  META_APP_SECRET: string
  META_LOGIN_CONFIG_ID: string
  META_WEBHOOK_VERIFY_TOKEN: string
  META_GRAPH_VERSION: string
}): MetaSignupConfig | undefined {
  const required = {
    META_APP_ID: env.META_APP_ID,
    META_APP_SECRET: env.META_APP_SECRET,
    META_LOGIN_CONFIG_ID: env.META_LOGIN_CONFIG_ID,
    META_WEBHOOK_VERIFY_TOKEN: env.META_WEBHOOK_VERIFY_TOKEN,
  }
  const missing = Object.entries(required)
    .filter(([, value]) => !value.trim())
    .map(([name]) => name)
  if (missing.length > 0) {
    if (missing.length < Object.keys(required).length) {
      console.warn(
        `«Conectar con Facebook» de WhatsApp queda apagado: faltan ${missing.join(", ")}. La conexión a mano sigue igual.`,
      )
    }
    return undefined
  }
  return {
    appId: env.META_APP_ID.trim(),
    appSecret: env.META_APP_SECRET.trim(),
    configId: env.META_LOGIN_CONFIG_ID.trim(),
    webhookVerifyToken: env.META_WEBHOOK_VERIFY_TOKEN.trim(),
    graphVersion: env.META_GRAPH_VERSION,
  }
}

export interface WhatsAppSignupDeps extends CrmDeps {
  meta?: MetaSignupConfig | undefined
  /** Solo las pruebas lo cambian: el de la plataforma por defecto. */
  fetch?: typeof fetch
}

// Los identificadores de Meta son numéricos; el código es una cadena opaca.
const signupInput = z
  .object({
    code: z.string().min(1).max(4096),
    wabaId: z.string().regex(/^\d{1,40}$/),
    /** Puede faltar solo con `businessApp`: Meta solo promete la cuenta y el número se busca en ella. */
    phoneNumberId: z.string().regex(/^\d{1,40}$/).optional(),
    /** El número sigue en la app WhatsApp Business del celular: no se registra. */
    businessApp: z.boolean().optional(),
    /** Volver a conectar: la conexión que ya existe, hecha con el botón. */
    reconnectConnectionId: z.string().uuid().optional(),
  })
  .refine((input) => input.phoneNumberId || input.businessApp, {
    path: ["phoneNumberId"],
    message: "Falta el número que eligió la clínica",
  })

/**
 * «Conectar con Facebook» de WhatsApp (Embedded Signup de Meta, versión 4).
 * La pantalla abre la ventana de Meta y trae aquí el código; el resto ocurre en
 * el servidor. La clave secreta de la app nunca sale de aquí.
 *
 * Las llamadas a Meta van fuera de las transacciones: se abre la base dos veces,
 * una para guardar la conexión y otra para anotar cómo quedó cada paso.
 */
export function createWhatsAppSignupRoute(deps: WhatsAppSignupDeps) {
  const app = new Hono()
  const meta = deps.meta
  // Sin proveedor (pruebas, desarrollo) no se llama a Meta: el botón tampoco existe.
  const enabled = meta !== undefined && deps.validateExternal !== false
  const fetchImpl = deps.fetch ?? fetch
  const providerDeps = {
    fetch: fetchImpl,
    validateExternal: deps.validateExternal,
    webhookBaseUrl: deps.webhookBaseUrl,
  }

  const forbidden = (c: Context, permission: "settings.read" | "settings.write") => {
    const { memberRole } = orgContextOf(c)
    if (canAccess(memberRole, permission)) return null
    return c.json(
      errorBody(
        c,
        "FORBIDDEN",
        permission === "settings.read"
          ? "Sin permiso de lectura de configuración"
          : "Sin permiso de configuración",
      ),
      403,
    )
  }

  const unavailable = () =>
    new ServiceError(
      "SIGNUP_UNAVAILABLE",
      409,
      "«Conectar con Facebook» no está disponible en esta instalación. Conecta WhatsApp con los datos de la app de Meta de la clínica.",
    )

  /** Lo que la pantalla necesita para abrir la ventana de Meta. Nunca la clave secreta. */
  app.get("/", (c) => {
    const denied = forbidden(c, "settings.read")
    if (denied) return denied
    return c.json({
      data:
        enabled && meta
          ? { enabled: true, appId: meta.appId, configId: meta.configId, graphVersion: meta.graphVersion }
          : { enabled: false, appId: null, configId: null, graphVersion: null },
    })
  })

  /**
   * Termina de conectar con lo que devolvió la ventana de Meta. Responde como
   * `POST /api/channels/connections` (cuenta encontrada, mensajes pedidos,
   * salud) más `signup`, que dice si quedó algún paso pendiente. 201 si la
   * conexión es nueva, 200 si se volvió a conectar una que ya existía.
   */
  app.post("/", async (c) => {
    const denied = forbidden(c, "settings.write")
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    const parsed = signupInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { reconnectConnectionId, ...input } = parsed.data
    return runService(c, reconnectConnectionId ? 200 : 201, async () => {
      if (!enabled || !meta) throw unavailable()
      // Un solo WhatsApp por clínica: se dice antes de gastar el código de Meta.
      if (!reconnectConnectionId) {
        await withOrgContext(deps.db, orgId, (tx) => assertSingleWhatsApp(tx, orgId, null, input.phoneNumberId ?? null))
      }
      // 1. Sin base: el código vive 30 segundos y se canjea enseguida.
      const grant = await redeemWhatsAppSignup(meta, input, providerDeps)
      // 2. Con base, sin red: la conexión queda guardada con sus pasos pendientes.
      const work = await withOrgContext(deps.db, orgId, (tx) =>
        openWhatsAppSignup(tx, orgId, deps.secretsKey, grant, { reconnectConnectionId }, providerDeps),
      )
      // 3. Sin base: suscribir la app y registrar el número.
      const results = await runSignupSteps(meta, work, providerDeps)
      // 4. Con base: cómo quedó cada paso, la salud del número y sus mensajes.
      return withOrgContext(deps.db, orgId, (tx) =>
        closeWhatsAppSignup(tx, orgId, deps.secretsKey, work, results, providerDeps),
      )
    })
  })

  /**
   * Reintenta lo que quedó pendiente de una conexión hecha con el botón, con el
   * permiso que ya tiene: no hace falta abrir otra vez la ventana de Meta.
   */
  app.post("/:connectionId/retry", async (c) => {
    const denied = forbidden(c, "settings.write")
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    const connectionId = c.req.param("connectionId")
    if (!z.string().uuid().safeParse(connectionId).success) {
      return c.json(errorBody(c, "NOT_FOUND", "Conexión no encontrada"), 404)
    }
    return runService(c, 200, async () => {
      if (!enabled || !meta) throw unavailable()
      const work = await withOrgContext(deps.db, orgId, (tx) =>
        pendingSignupWork(tx, orgId, deps.secretsKey, connectionId),
      )
      const results = await runSignupSteps(meta, work, providerDeps)
      return withOrgContext(deps.db, orgId, (tx) =>
        closeWhatsAppSignup(tx, orgId, deps.secretsKey, work, results, providerDeps),
      )
    })
  })

  return app
}
