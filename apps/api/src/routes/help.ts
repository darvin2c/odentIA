import { canAccess, canAccessAny, ORG_ROLES, type OrgRole, type Permission, platformPathPermission, roleLabel } from "@odentia/auth/permissions"
import type { ClinicalProduct } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import {
  askHelp,
  assertMySupportCaseWritable,
  attachToMySupportCase,
  clientSupportAttachmentUrl,
  describeHelpAttachments,
  describeHelpScreen,
  getMySupportCase,
  grantSupportAccess,
  type HelpAsker,
  listActiveSupportGrants,
  listMySupportCases,
  markSupportCaseSeen,
  orgProduct,
  rateHelp,
  reopenMySupportCase,
  replyToMySupportCase,
  revokeSupportAccess,
  sendHelpRequest,
  sniffFileContent,
  SUPPORT_ATTACHMENT_MAX_BYTES,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

const askInput = z.object({ question: z.string().trim().min(3).max(500), screen: z.string().max(200) })
const feedbackInput = z.object({ helpful: z.boolean() })
const requestInput = z.object({
  question: z.string().trim().min(3).max(500),
  screen: z.string().max(200),
  kind: z.enum(["pregunta", "problema"]).optional(),
  detail: z.string().max(500).optional(),
})
const caseMessageInput = z.object({ body: z.string().trim().min(1).max(4000) })
const grantInput = z.object({ minutes: z.number().int().min(5).max(60).optional() })
const grantRevokeInput = z.object({ grantId: z.uuid() })

/**
 * Quién pregunta, visto con la matriz canónica de permisos: la Ayuda no decide
 * accesos, los lee. Los roles se nombran como en el producto de la clínica.
 */
function askerOf(userId: string, memberRole: string, product: ClinicalProduct): HelpAsker {
  const role = (ORG_ROLES as readonly string[]).includes(memberRole) ? (memberRole as OrgRole) : null
  return {
    userId,
    roleLabel: role ? roleLabel(role, product) : memberRole,
    canOpen: (path) => {
      const needed = platformPathPermission(path)
      return needed === null || canAccessAny(memberRole, needed)
    },
    can: (permission) => canAccess(memberRole, permission as Permission),
    whoCan: (permission) => ORG_ROLES.filter((item) => canAccess(item, permission as Permission)).map((item) => roleLabel(item, product)),
  }
}

/**
 * Ayuda de odentIA: para todo el equipo, sin permiso propio. No cambia nada y
 * no lee datos de pacientes; lo que responde depende del rol de quien pregunta.
 */
export function createHelpRoute(deps: CrmDeps & { appVersion?: string | null }) {
  const app = new Hono()

  /** La pantalla donde está la persona y lo que un envío a odentIA llevaría de ella. */
  app.get("/screen", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const path = (c.req.query("path") ?? "/").slice(0, 200)
    return runService(c, 200, async () => ({
      ...describeHelpScreen(path),
      attached: await withOrgContext(deps.db, orgId, async (tx) =>
        describeHelpAttachments(tx, orgId, askerOf(userId, memberRole, await orgProduct(tx, orgId)), {
          screen: path,
          appVersion: deps.appVersion ?? null,
        }),
      ),
    }))
  })

  app.post("/ask", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = askInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, async (tx) => askHelp(tx, orgId, askerOf(userId, memberRole, await orgProduct(tx, orgId)), parsed.data)))
  })

  app.post("/ask/:id/feedback", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const id = z.uuid().safeParse(c.req.param("id"))
    if (!id.success) return validationError(c, id.error.issues)
    const parsed = feedbackInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) => rateHelp(tx, orgId, userId, id.data, parsed.data.helpful))
      return { ok: true }
    })
  })

  /**
   * La persona decide enviar su pregunta a odentIA: es lo único que sale con
   * su texto. El envío abre su caso privado de soporte (o se junta con el suyo
   * que siga abierto) y deja el aviso por correo a soporte.
   */
  app.post("/requests", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = requestInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const asker = askerOf(userId, memberRole, await orgProduct(tx, orgId))
        const kase = await sendHelpRequest(tx, orgId, asker, { ...parsed.data, appVersion: deps.appVersion ?? null })
        return { ...kase, caseId: kase.id }
      }),
    )
  })

  /* ---------- Casos de soporte: conversación, reapertura, adjuntos y consentimiento ---------- */
  /**
   * Permisos diagnóstico vigentes de la clínica: solo metadatos para el aviso
   * global, sin textos del caso. Cualquier miembro puede verlos.
   */
  // Solo quien puede dar o quitar el acceso lo ve (ADR 0065): soporte no ve
  // pacientes, así que al resto del equipo no le cambia nada.
  app.get("/grants/active", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (memberRole !== "owner" && memberRole !== "admin") return c.json({ data: [] })
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listActiveSupportGrants(tx, orgId)))
  })

  app.get("/cases", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listMySupportCases(tx, orgId, userId)))
  })

  app.get("/cases/:id", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getMySupportCase(tx, orgId, userId, c.req.param("id"))))
  })

  /** Responder en el caso; si estaba resuelto, se reabre. */
  app.post("/cases/:id/messages", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = caseMessageInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => replyToMySupportCase(tx, orgId, userId, c.req.param("id"), parsed.data.body)),
    )
  })

  app.post("/cases/:id/reopen", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) => reopenMySupportCase(tx, orgId, userId, c.req.param("id")))
      return { ok: true }
    })
  })

  /** «Ver»: lo respondido deja de contar como no leído. */
  app.post("/cases/:id/seen", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) => markSupportCaseSeen(tx, orgId, userId, c.req.param("id")))
      return { ok: true }
    })
  })

  /**
   * Adjunto real al bucket privado: auth y contenido verificados ANTES de
   * subir (sin objetos huérfanos), tope de tamaño antes de leer en memoria y
   * firma real de bytes (no basta el MIME declarado).
   */
  app.post("/cases/:id/attachments", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const caseId = c.req.param("id")
    const declaredSize = Number(c.req.header("content-length") ?? 0)
    if (Number.isFinite(declaredSize) && declaredSize > SUPPORT_ATTACHMENT_MAX_BYTES + 65_536) {
      return c.json(errorBody(c, "VALIDATION", "El archivo no puede superar 10 MB"), 413)
    }
    // Auth primero: pertenencia, autoría y caso escribible, sin subir nada aún.
    try {
      await withOrgContext(deps.db, orgId, (tx) => assertMySupportCaseWritable(tx, orgId, userId, caseId))
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
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
        orgId,
        conversationId: `support/${caseId}`,
        bytes,
        contentType: sniffed.mimeType,
        ext: sniffed.ext,
      })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        try {
          return await attachToMySupportCase(tx, orgId, userId, caseId, {
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
    const { orgId, userId } = orgContextOf(c)
    try {
      const url = await withOrgContext(deps.db, orgId, (tx) =>
        clientSupportAttachmentUrl(tx, orgId, userId, c.req.param("id"), c.req.param("attachmentId"), deps.storage),
      )
      return c.redirect(url, 302)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  /**
   * Autorizar acceso diagnóstico a soporte (máx. 1 h, revocable): solo owner o
   * admin de la clínica, verificado en servidor con la membresía.
   */
  app.post("/cases/:id/grants", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = grantInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const canGrant = memberRole === "owner" || memberRole === "admin"
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        grantSupportAccess(tx, orgId, userId, canGrant, c.req.param("id"), parsed.data.minutes ?? 30),
      ),
    )
  })

  app.post("/cases/:id/grants/revoke", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = grantRevokeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const canGrant = memberRole === "owner" || memberRole === "admin"
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) =>
        revokeSupportAccess(tx, orgId, userId, canGrant, parsed.data.grantId),
      )
      return { ok: true }
    })
  })

  return app
}
