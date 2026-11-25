import type { Db } from "@odentia/db"
import { withOrgContext } from "@odentia/db"
import type { Storage } from "@odentia/services"
import {
  accountSupportAttachmentUrl,
  clinicTwoFactorGate,
  attachToAccountSupportCase,
  createAccessSupportCase,
  getAccountSupportCase,
  grantSupportAccess,
  isOrgOwnerOrAdmin,
  listAccountSupportCases,
  markAccountSupportCaseSeen,
  reopenAccountSupportCase,
  replyToAccountSupportCase,
  revokeSupportAccess,
  ServiceError,
  SUPPORT_ATTACHMENT_MAX_BYTES,
  sniffFileContent,
} from "@odentia/services"
import { type Context, Hono, type Next } from "hono"
import { z } from "zod"
import type { ApiDeps } from "../lib/context.js"
import { requireSession } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { runService, serviceErrorResponse, validationError } from "./helpers.js"

export interface AccountSupportDeps {
  /** Conexión propietaria: filtra por autor; nunca expone datos de otra cuenta. */
  ownerDb: Db
  auth: ApiDeps["auth"]
  storage: Storage
  appVersion?: string | null
  /**
   * En el dominio de una app que es otro sistema (gestorIA, ADR 0216): solo los casos de la
   * cuenta, sin los que se abrieron en una clínica ni el acceso diagnóstico a ella.
   */
  accountCasesOnly?: boolean
  /** Desde dónde se pidió ayuda (`/panel`, `/gestoria`): el aviso de la respuesta lleva ahí. */
  screen?: string
}

const accessInput = z.object({
  question: z
    .string()
    .trim()
    .min(3, "Cuenta qué pasa con al menos 3 caracteres.")
    .max(500, "Escribe como mucho 500 caracteres."),
  detail: z.string().max(500, "Escribe como mucho 500 caracteres.").optional(),
})
const messageInput = z.object({
  body: z.string().trim().min(1, "Escribe tu respuesta.").max(4000, "Escribe como mucho 4000 caracteres."),
})
const grantInput = z.object({
  organizationId: z.string(),
  minutes: z.number().int("El acceso se autoriza entre 5 y 60 minutos.").min(5, "El acceso se autoriza entre 5 y 60 minutos.").max(60, "El acceso se autoriza entre 5 y 60 minutos.").optional(),
  reason: z.string().max(500, "Escríbelo en 500 caracteres o menos.").nullish(),
})
const revokeInput = z.object({ grantId: z.uuid() })

/**
 * Soporte de la cuenta (`/api/account/support`, solo sesión sin
 * organización): problemas de acceso y seguimiento de los casos propios. El
 * consentimiento de acceso delegado lo verifica contra la membresía real
 * (owner/admin), nunca contra lo que dice el cliente.
 */
export function createAccountSupportRoute(deps: AccountSupportDeps) {
  const app = new Hono<{ Variables: { userId: string; sessionId: string } }>()
  app.use(requireSession({ auth: deps.auth }))

  // Fuera de las clínicas, un caso abierto en una clínica no existe: ni su conversación ni sus
  // adjuntos. Se mira antes de cada ruta de un caso.
  if (deps.accountCasesOnly) {
    const onlyAccountCase = async (c: Context<{ Variables: { userId: string; sessionId: string } }>, next: Next) => {
      const kase = await getAccountSupportCase(deps.ownerDb, c.get("userId"), c.req.param("id") ?? "").catch(() => null)
      if (!kase || kase.organizationId !== null) return c.json(errorBody(c, "NOT_FOUND", "Caso no encontrado"), 404)
      return next()
    }
    app.use("/cases/:id", onlyAccountCase)
    app.use("/cases/:id/*", onlyAccountCase)
  }

  app.get("/cases", async (c) => {
    const userId = c.get("userId") as string
    return runService(c, 200, async () => {
      const cases = await listAccountSupportCases(deps.ownerDb, userId)
      return deps.accountCasesOnly ? cases.filter((kase) => kase.organizationId === null) : cases
    })
  })

  /** Abrir un caso de acceso: sin clínica, desde el panel. */
  app.post("/cases", async (c) => {
    const userId = c.get("userId") as string
    const parsed = accessInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const input = parsed.data
    return runService(c, 201, () =>
      createAccessSupportCase(deps.ownerDb, userId, {
        question: input.question,
        detail: input.detail,
        appVersion: deps.appVersion ?? null,
        ...(deps.screen ? { screen: deps.screen } : {}),
      }),
    )
  })

  app.get("/cases/:id", async (c) => {
    const userId = c.get("userId") as string
    return runService(c, 200, () => getAccountSupportCase(deps.ownerDb, userId, c.req.param("id")))
  })

  app.post("/cases/:id/messages", async (c) => {
    const userId = c.get("userId") as string
    const parsed = messageInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      deps.ownerDb.transaction((tx) =>
        replyToAccountSupportCase(tx as Db, userId, c.req.param("id"), parsed.data.body),
      ),
    )
  })

  app.post("/cases/:id/reopen", async (c) => {
    const userId = c.get("userId") as string
    return runService(c, 200, async () => {
      await reopenAccountSupportCase(deps.ownerDb, userId, c.req.param("id"))
      return { ok: true }
    })
  })

  /** «Ver»: lo respondido deja de contar como no leído. */
  app.post("/cases/:id/seen", async (c) => {
    const userId = c.get("userId") as string
    return runService(c, 200, async () => {
      await markAccountSupportCaseSeen(deps.ownerDb, userId, c.req.param("id"))
      return { ok: true }
    })
  })

  /**
   * Adjunto al bucket privado con auth y contenido verificados antes de subir.
   * Sin `messageId`: público del caso; lo interno nunca se expone a la cuenta.
   */
  app.post("/cases/:id/attachments", async (c) => {
    const userId = c.get("userId") as string
    const caseId = c.req.param("id")
    const declaredSize = Number(c.req.header("content-length") ?? 0)
    if (Number.isFinite(declaredSize) && declaredSize > SUPPORT_ATTACHMENT_MAX_BYTES + 65_536) {
      return c.json(errorBody(c, "VALIDATION", "El archivo no puede superar 10 MB", { file: "El archivo no puede superar 10 MB" }), 413)
    }
    const kase = await getAccountSupportCase(deps.ownerDb, userId, caseId).catch(() => null)
    if (!kase || kase.status === "resuelto") {
      return c.json(
        errorBody(
          c,
          kase ? "VALIDATION" : "NOT_FOUND",
          kase ? "El caso está resuelto" : "Caso no encontrado",
        ),
        kase ? 400 : 404,
      )
    }
    const form = await c.req.formData().catch(() => null)
    const file = form?.get("file")
    if (!(file instanceof File)) {
      return c.json(errorBody(c, "VALIDATION", "Adjunta un archivo", { file: "Adjunta un archivo" }), 400)
    }
    if (file.size > SUPPORT_ATTACHMENT_MAX_BYTES) {
      return c.json(errorBody(c, "VALIDATION", "El archivo no puede superar 10 MB", { file: "El archivo no puede superar 10 MB" }), 400)
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    let sniffed: { mimeType: string; ext: string }
    try {
      sniffed = sniffFileContent(bytes, file.type)
    } catch (e) {
      // Tipo no admitido o contenido que no coincide: se dice junto a «Adjuntar».
      if (e instanceof ServiceError) return c.json(errorBody(c, e.code, e.message, e.fields ?? { file: e.message }), e.status)
      throw e
    }
    let ref: { objectKey: string }
    try {
      ref = await deps.storage.putAttachment({
        orgId: kase.organizationId ?? "account",
        conversationId: `support/${caseId}`,
        bytes,
        contentType: sniffed.mimeType,
        ext: sniffed.ext,
      })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
    return runService(c, 201, () =>
      deps.ownerDb.transaction(async (tx) => {
        try {
          return await attachToAccountSupportCase(tx as Db, userId, caseId, {
            objectKey: ref.objectKey,
            mimeType: sniffed.mimeType,
            filename: file.name,
            size: file.size,
          })
        } catch (e) {
          await deps.storage.deleteAttachment(ref.objectKey).catch(() => {})
          throw e
        }
      }),
    )
  })

  app.get("/cases/:id/attachments/:attachmentId", async (c) => {
    const userId = c.get("userId") as string
    try {
      const url = await accountSupportAttachmentUrl(
        deps.ownerDb,
        userId,
        c.req.param("id"),
        c.req.param("attachmentId"),
        deps.storage,
      )
      return c.redirect(url, 302)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  if (deps.accountCasesOnly) return app

  /**
   * Autorizar acceso diagnóstico a la clínica del caso: solo si quien pide es
   * owner/admin de esa organización según la membresía.
   */
  app.post("/cases/:id/grants", async (c) => {
    const userId = c.get("userId") as string
    const parsed = grantInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const input = parsed.data
    return runService(c, 201, async () => {
      const kase = await getAccountSupportCase(deps.ownerDb, userId, c.req.param("id"))
      const orgId = kase.organizationId
      if (!orgId || orgId !== input.organizationId)
        throw new ServiceError("NOT_FOUND", 404, "Caso no encontrado")
      const canGrant = await isOrgOwnerOrAdmin(deps.ownerDb, userId, orgId)
      // Dar acceso a la clínica pide el código si la clínica pide la verificación (ADR 0107).
      if (await clinicTwoFactorGate(deps.ownerDb, { orgId, userId, sessionId: c.get("sessionId") })) {
        throw new ServiceError("TWO_FACTOR_REQUIRED", 403, "Esta clínica pide verificación en dos pasos")
      }
      return withOrgContext(deps.ownerDb, orgId, (tx) =>
        // Desde el panel de la cuenta, solo la configuración: mirar la clínica con un rol
        // se da desde la Ayuda de la clínica, donde se ve qué rol se elige y su franja.
        grantSupportAccess(tx, orgId, userId, canGrant, kase.id, input.minutes ?? 30, {
          viewRole: null,
          reason: input.reason ?? null,
        }),
      )
    })
  })

  app.post("/cases/:id/grants/revoke", async (c) => {
    const userId = c.get("userId") as string
    const parsed = revokeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const input = parsed.data
    return runService(c, 200, async () => {
      const kase = await getAccountSupportCase(deps.ownerDb, userId, c.req.param("id"))
      const orgId = kase.organizationId
      if (!orgId) throw new ServiceError("NOT_FOUND", 404, "Caso no encontrado")
      const canGrant = await isOrgOwnerOrAdmin(deps.ownerDb, userId, orgId)
      await withOrgContext(deps.ownerDb, orgId, (tx) =>
        revokeSupportAccess(tx, orgId, userId, canGrant, input.grantId),
      )
      return { ok: true }
    })
  })

  return app
}
