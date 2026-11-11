import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import type { AdminActor, Storage } from "@odentia/services"
import {
  addSupportInternalNote,
  assertStaffAttachmentTarget,
  assignSupportCase,
  decideActionReview,
  getReviewOfCase,
  getSupportCaseForStaff,
  readReviewConversation,
  listSupportAccessAudit,
  listSupportAssignees,
  listGuideGaps,
  listSupportCasesForStaff,
  markGuideGap,
  readSupportDiagnostic,
  requestSupportAccess,
  replyToSupportCase,
  replyToSupportCasesMany,
  revokeSupportGrantAsStaff,
  ServiceError,
  SUPPORT_ATTACHMENT_MAX_BYTES,
  type SupportStatus,
  setSupportCaseStatus,
  sniffFileContent,
  staffAttachToSupportCase,
  staffSupportAttachmentUrl,
  supportKnowledgeGroups,
  helpVideoTagList,
  keepHelpVideoLink,
  listHelpVideos,
  supportHelpStats,
  supportMetrics,
  unmarkGuideGap,
} from "@odentia/services"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import { adminContextOf } from "../lib/admin-context.js"
import { errorBody } from "../lib/error.js"
import { runService, serviceErrorResponse, validationError } from "./helpers.js"

export interface AdminSupportDeps {
  /** Conexión propietaria (bypass RLS): el equipo lee entre organizaciones; cada acción audita al actor. */
  ownerDb: Db
  storage: Storage
}

const listQuery = z.object({
  /** Por omisión, los que no están resueltos. */
  status: z.enum(["sin_resolver", "abierto", "en_atencion", "esperando_clinica", "resuelto"]).optional(),
  kind: z.enum(["pregunta", "problema", "acceso", "cobro"]).optional(),
  /** «me»: los míos; «none»: sin responsable; o el id de alguien del equipo. */
  assignee: z.string().min(1).max(200).optional(),
  organizationId: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const messageInput = z.object({ body: z.string().trim().min(1).max(4000) })
const manyInput = z.object({
  caseIds: z.array(z.uuid()).min(1).max(50),
  body: z.string().trim().min(1).max(4000),
  confirmOrganizationIds: z.array(z.string().nullable()),
})
const assignInput = z.object({ staffUserId: z.string().nullable() })
const statusInput = z.object({
  status: z.enum(["abierto", "en_atencion", "esperando_clinica", "resuelto"]),
})
const grantInput = z.object({ grantId: z.uuid() })

/**
 * Actor staff verificado por el guard de admin: no confía en la UI, comprueba
 * el rol en servidor en cada acción.
 */
function staffOf(c: Context): AdminActor {
  const actor = adminContextOf(c)
  if (actor.role !== "admin" && actor.role !== "support") {
    throw new ServiceError("FORBIDDEN", 403, "Solo el equipo de la administración")
  }
  return actor
}

/**
 * Amplio alcance (responder a N clínicas a la vez): solo rol admin. La
 * atención caso por caso queda para admin y support.
 */
function adminOf(c: Context): AdminActor {
  const actor = staffOf(c)
  if (actor.role !== "admin") {
    throw new ServiceError("FORBIDDEN", 403, "Solo alguien con el rol Administración")
  }
  return actor
}

/**
 * Atención de soporte (`/api/admin/support`, tras el guard de admin). Cada
 * lectura y escritura audita al actor real.
 */
export function createAdminSupportRoute(deps: AdminSupportDeps) {
  const app = new Hono()

  app.get("/cases", async (c) => {
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const query = parsed.data
    return runService(c, 200, () =>
      listSupportCasesForStaff(deps.ownerDb, staffOf(c), {
        status: query.status,
        kind: query.kind,
        assignee: query.assignee,
        organizationId: query.organizationId,
        limit: query.limit,
        offset: query.offset,
      }),
    )
  })

  app.get("/cases/:id", (c) =>
    runService(c, 200, () =>
      deps.ownerDb.transaction(async (tx) => {
        const detail = await getSupportCaseForStaff(tx, staffOf(c), c.req.param("id"))
        // «Revisión de cobro» (ADR 0054): el caso trae la fila que la clínica pidió revisar.
        return detail.kind === "cobro" ? { ...detail, review: await getReviewOfCase(tx as Db, detail.id) } : detail
      }),
    ),
  )

  /** Devolver o mantener un cobro revisado: decide quien ve la facturación (rol admin), siempre con lo que se le dice a la clínica. */
  app.post("/cases/:id/review/decide", async (c) => {
    const parsed = z
      .object({
        accept: z.boolean(),
        answer: z
          .string()
          .trim()
          .min(1, "Escribe qué le dices a la clínica")
          .max(1000, "Escribe como mucho 1000 caracteres"),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      deps.ownerDb.transaction(async (tx) => {
        await decideActionReview(tx as Db, adminOf(c), { caseId: c.req.param("id"), ...parsed.data })
        return { ok: true }
      }),
    )
  })

  /** La conversación de la revisión, solo con el permiso de la clínica y mientras dure; queda auditado. */
  app.get("/cases/:id/review/conversation", (c) =>
    runService(c, 200, () =>
      deps.ownerDb.transaction((tx) => readReviewConversation(tx as Db, staffOf(c), c.req.param("id"))),
    ),
  )

  /** Respuesta pública al cliente: mensaje, caso y auditoría en una transacción. */
  app.post("/cases/:id/messages", async (c) => {
    const parsed = messageInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      deps.ownerDb.transaction((tx) =>
        replyToSupportCase(tx as Db, staffOf(c), c.req.param("id"), parsed.data.body),
      ),
    )
  })
  app.post("/cases/:id/notes", async (c) => {
    const parsed = messageInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      deps.ownerDb.transaction((tx) =>
        addSupportInternalNote(tx as Db, staffOf(c), c.req.param("id"), parsed.data.body),
      ),
    )
  })

  /**
   * Una respuesta a varios casos: exige confirmar las organizaciones
   * destinatarias y mantiene un hilo privado por caso. Solo admin, en una
   * transacción para no dejar respuestas a medias.
   */
  app.post("/messages/many", async (c) => {
    const parsed = manyInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const input = parsed.data
    return runService(c, 201, () =>
      deps.ownerDb.transaction((tx) =>
        replyToSupportCasesMany(tx as Db, adminOf(c), {
          caseIds: input.caseIds,
          body: input.body,
          confirmOrganizationIds: input.confirmOrganizationIds,
        }),
      ),
    )
  })

  app.post("/cases/:id/assign", async (c) => {
    const parsed = assignInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      deps.ownerDb.transaction(async (tx) => {
        await assignSupportCase(tx as Db, staffOf(c), c.req.param("id"), parsed.data.staffUserId)
        return { ok: true }
      }),
    )
  })

  app.post("/cases/:id/status", async (c) => {
    const parsed = statusInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const status: SupportStatus = parsed.data.status
    return runService(c, 200, () =>
      deps.ownerDb.transaction(async (tx) => {
        await setSupportCaseStatus(tx as Db, staffOf(c), c.req.param("id"), status)
        return { ok: true }
      }),
    )
  })

  /**
   * «Pedir acceso de diagnóstico…»: deja el mensaje fijo, pasa el caso a
   * «Esperando a la clínica» y desde ahí lo leen la propietaria y los
   * administradores (ADR 0180). Pedirlo dos veces deja un solo pedido.
   */
  app.post("/cases/:id/request-access", (c) =>
    runService(c, 200, () =>
      deps.ownerDb.transaction((tx) => requestSupportAccess(tx as Db, staffOf(c), c.req.param("id"))),
    ),
  )

  /** «Falta en la guía»: la marca del equipo en el caso (encender y apagar). */
  app.put("/cases/:id/guide-gap", (c) =>
    runService(c, 200, () =>
      deps.ownerDb.transaction(async (tx) => {
        await markGuideGap(tx as Db, staffOf(c), c.req.param("id"))
        return { ok: true }
      }),
    ),
  )
  app.delete("/cases/:id/guide-gap", (c) =>
    runService(c, 200, () =>
      deps.ownerDb.transaction(async (tx) => {
        await unmarkGuideGap(tx as Db, staffOf(c), c.req.param("id"))
        return { ok: true }
      }),
    ),
  )

  app.post("/cases/:id/attachments", async (c) => {
    const caseId = c.req.param("id")
    const declaredSize = Number(c.req.header("content-length") ?? 0)
    if (Number.isFinite(declaredSize) && declaredSize > SUPPORT_ATTACHMENT_MAX_BYTES + 65_536) {
      return c.json(errorBody(c, "VALIDATION", "El archivo no puede superar 10 MB"), 413)
    }
    let actor: AdminActor
    try {
      actor = staffOf(c)
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
    const rawMessageId = form?.get("messageId")
    const messageId =
      typeof rawMessageId === "string" && rawMessageId.length > 0 ? rawMessageId : undefined
    try {
      await assertStaffAttachmentTarget(deps.ownerDb, actor, caseId, messageId)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    let sniffed: { mimeType: string; ext: string }
    try {
      sniffed = sniffFileContent(bytes, file.type)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
    // Fuera de la transacción: subida externa primero, registro después.
    let ref: { objectKey: string }
    try {
      ref = await deps.storage.putAttachment({
        orgId: "support",
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
          return await staffAttachToSupportCase(tx as Db, actor, caseId, {
            messageId,
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
    try {
      const url = await deps.ownerDb.transaction((tx) =>
        staffSupportAttachmentUrl(
          tx as Db,
          staffOf(c),
          c.req.param("id"),
          c.req.param("attachmentId"),
          deps.storage,
        ),
      )
      return c.redirect(url, 302)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  /**
   * Vista diagnóstica: solo con permiso vigente de la clínica; sin él deniega
   * en servidor y audita el intento. Nunca suplanta al owner.
   */
  app.get("/cases/:id/diagnostic", async (c) => {
    try {
      const diagnostic = await readSupportDiagnostic(deps.ownerDb, staffOf(c), c.req.param("id"))
      return c.json({ data: diagnostic }, 200)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.get("/cases/:id/audit", async (c) => {
    return runService(c, 200, () =>
      listSupportAccessAudit(deps.ownerDb, staffOf(c), c.req.param("id")),
    )
  })

  app.post("/grants/revoke", async (c) => {
    const parsed = grantInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      deps.ownerDb.transaction(async (tx) => {
        await revokeSupportGrantAsStaff(tx as Db, staffOf(c), parsed.data.grantId)
        return { ok: true }
      }),
    )
  })

  /** Agrupación para conocimiento: agregado sin datos de organizaciones. */
  app.get("/knowledge", async (c) => {
    return runService(c, 200, () => supportKnowledgeGroups(deps.ownerDb, staffOf(c)))
  })

  /** «Para llevar a la guía»: los casos marcados, con su tema y la fecha, sin clínica ni conversación. */
  app.get("/knowledge/guide-gaps", async (c) => {
    return runService(c, 200, () => listGuideGaps(deps.ownerDb, staffOf(c)))
  })

  /** Métricas: conteos y tiempos; nunca texto de preguntas sin enviar. */
  app.get("/metrics", async (c) => {
    return runService(c, 200, () => supportMetrics(deps.ownerDb, staffOf(c)))
  })
  /** Lo que Ariadna no supo: conteos por pantalla y tema, nunca lo que se preguntó. */
  app.get("/help-stats", async (c) => {
    return runService(c, 200, () => supportHelpStats(deps.ownerDb, staffOf(c)))
  })

  /** Los videos de la Ayuda leídos de YouTube y a qué respuesta está unido cada uno (ADR 0178). */
  app.get("/help-videos", async (c) => {
    return runService(c, 200, async () => ({ data: await listHelpVideos(deps.ownerDb, staffOf(c)) }))
  })

  /** Las etiquetas que se pueden poner en la descripción de un video de un producto, para copiarlas. */
  app.get("/help-videos/tags", async (c) => {
    const product = z.enum(CLINICAL_PRODUCTS).safeParse(c.req.query("product"))
    if (!product.success) return validationError(c, product.error.issues)
    return runService(c, 200, async () => {
      staffOf(c)
      return { data: helpVideoTagList(product.data) }
    })
  })

  /** «Sigue valiendo»: la respuesta cambió y el video sirve igual. */
  app.post("/help-videos/:id/keep", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"))
    const body = z.object({ target: z.string().min(1).max(200) }).safeParse(await c.req.json().catch(() => null))
    if (!id.success) return validationError(c, id.error.issues)
    if (!body.success) return validationError(c, body.error.issues)
    return runService(c, 200, async () => {
      await keepHelpVideoLink(deps.ownerDb, staffOf(c), id.data, body.data.target)
      return { ok: true }
    })
  })

  /** Equipo asignable: id y nombre del staff activo, sin datos sensibles. */
  app.get("/assignees", async (c) => {
    return runService(c, 200, () => {
      staffOf(c)
      return listSupportAssignees(deps.ownerDb)
    })
  })

  return app
}
