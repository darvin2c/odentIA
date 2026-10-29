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
import { Hono } from "hono"
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
}

const accessInput = z.object({
  question: z.string().trim().min(3).max(500),
  detail: z.string().max(500).optional(),
})
const messageInput = z.object({ body: z.string().trim().min(1).max(4000) })
const grantInput = z.object({
  organizationId: z.string(),
  minutes: z.number().int().min(5).max(60).optional(),
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

  app.get("/cases", async (c) => {
    const userId = c.get("userId") as string
    return runService(c, 200, () => listAccountSupportCases(deps.ownerDb, userId))
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
      return c.json(errorBody(c, "VALIDATION", "El archivo no puede superar 10 MB"), 413)
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
      return c.json(errorBody(c, "VALIDATION", "Adjunta un archivo"), 400)
    }
    if (file.size > SUPPORT_ATTACHMENT_MAX_BYTES) {
      return c.json(errorBody(c, "VALIDATION", "El archivo no puede superar 10 MB"), 400)
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    let sniffed: { mimeType: string; ext: string }
    try {
      sniffed = sniffFileContent(bytes, file.type)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
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
        grantSupportAccess(tx, orgId, userId, canGrant, kase.id, input.minutes ?? 30),
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
