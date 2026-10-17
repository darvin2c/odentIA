import { withOrgContext } from "@odentia/db"
import { Hono } from "hono"
import { z } from "zod"
import {
  getDocumentSendOptions,
  getFinancialDocumentPdf,
  getHealthDocumentSendOptions,
  getRefundReceiptPdf,
  saveRecipientEmail,
  sendFinancialDocument,
  sendHealthDocument,
} from "@odentia/services"
import { traceClinicalRead } from "../lib/clinical-trace.js"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"
import type { Context } from "hono"

function forbid(c: Context) {
  return c.json(errorBody(c, "FORBIDDEN", "No tienes acceso a documentos económicos"), 403)
}

function canReadBudget(role: string): boolean {
  // Estricto budgets.read: caja lo tiene y ve importes del presupuesto, pero
  // el PDF no incluye líneas clínicas extra (solo snapshot económico).
  return canAccess(role, "budgets.read")
}

function canSendBudget(role: string): boolean {
  // `budgets.send` (decisión 4): recepción y quien presupuesta lo envían; caja
  // no (aunque tenga finance.write). Lo propio del odontólogo se valida en servicio.
  return canAccess(role, "budgets.send")
}

/**
 * Documentos económicos para envío (propiedad Documentos, Fase 7).
 * - GET /:id/financial-document-options?documentType=ticket|budget&documentId=&recipientContactId?
 *   → destinatarios autorizados, canales utilizables y canal propuesto.
 * - GET /:id/financial-document-pdf?documentType=&documentId=[&paper=A4|Letter] → PDF inline
 *   (misma fuente que impresión y envío; sin paper usa el papel del perfil).
 * - POST /:id/financial-documents/send { documentType, documentId, recipientContactId?,
 *   connectionId, message?, savePreferredChannel?, paper? } → 201 { conversationId, messageId,
 *   status: "queued" } (encolado, nunca entregado).
 * Permisos canónicos: ticket exige finance.read/write; budget exige
 * budgets.read/send. La titularidad (paciente de la org, destinatario
 * autorizado, lo propio del odontólogo) se valida en el servicio.
 */
const documentType = z.enum(["ticket", "budget"])

const optionsQuery = z.object({
  documentType,
  documentId: z.uuid(),
  recipientContactId: z.uuid().optional(),
})

const paperQuery = z.object({
  documentType,
  documentId: z.uuid(),
  /** Hoja explícita (impresión); ausente = papel del perfil. */
  paper: z.enum(["A4", "Letter"]).optional(),
})

const sendInput = z
  .object({
    documentType,
    documentId: z.uuid(),
    recipientContactId: z.uuid().nullish(),
    connectionId: z.uuid(),
    message: z.string().max(500).nullish(),
    savePreferredChannel: z.boolean().optional(),
    paper: z.enum(["A4", "Letter"]).nullish(),
    // Clave del intento: reenviar con la misma no manda el documento dos veces.
    requestId: z.uuid().nullish(),
    // Otro correo escrito en el momento: exige confirmación explícita de quien envía.
    otherEmail: z.string().trim().max(200).nullish(),
    confirmOtherEmail: z.boolean().optional(),
  })
  .strict()

const recipientEmailInput = z
  .object({
    documentType,
    recipientContactId: z.uuid(),
    email: z.string().trim().min(3).max(200),
  })
  .strict()

const healthDocumentType = z.enum(["prescription", "order", "consent"])

const healthOptionsQuery = z.object({
  documentType: healthDocumentType,
  documentId: z.uuid(),
  recipientContactId: z.uuid().optional(),
})

const healthSendInput = z
  .object({
    documentType: healthDocumentType,
    documentId: z.uuid(),
    recipientContactId: z.uuid().nullish(),
    connectionId: z.uuid(),
    message: z.string().max(500).nullish(),
    requestId: z.uuid().nullish(),
  })
  .strict()

const HEALTH_RESOURCE = {
  prescription: "recetas",
  order: "ordenes",
  consent: "consentimientos",
} as const

function forbidClinical(c: Context) {
  return c.json(errorBody(c, "FORBIDDEN", "Sin acceso clínico"), 403)
}

const refundPdfQuery = z.object({
  receiptId: z.uuid(),
  paper: z.enum(["A4", "Letter"]).optional(),
})

export function createFinancialDocumentsRoute(deps: Pick<CrmDeps, "db" | "storage" | "secretsKey">) {
  const app = new Hono()

  app.get("/:id/financial-document-options", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = optionsQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    if (parsed.data.documentType === "ticket") {
      if (!canAccess(memberRole, "finance.read")) return forbid(c)
    } else if (!canReadBudget(memberRole)) {
      return forbid(c)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getDocumentSendOptions(tx, orgId, c.req.param("id"), parsed.data, {
          actorUserId: userId,
          memberRole,
        }),
      ),
    )
  })

  app.get("/:id/financial-document-pdf", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = paperQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    if (parsed.data.documentType === "ticket") {
      if (!canAccess(memberRole, "finance.read")) return forbid(c)
    } else if (!canReadBudget(memberRole)) {
      return forbid(c)
    }
    try {
      const pdf = await withOrgContext(deps.db, orgId, (tx) =>
        getFinancialDocumentPdf(tx, orgId, c.req.param("id"), parsed.data, {
          actorUserId: userId,
          memberRole,
        }),
      )
      return c.body(Buffer.from(pdf.bytes), 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${pdf.filename}"`,
      })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.post("/:id/financial-documents/send", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = sendInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    if (parsed.data.documentType === "ticket") {
      if (!canAccess(memberRole, "finance.write")) return forbid(c)
    } else if (!canSendBudget(memberRole)) {
      return forbid(c)
    }
    const patientId = c.req.param("id")
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        sendFinancialDocument(
          tx,
          orgId,
          userId,
          memberRole,
          {
            documentType: parsed.data.documentType,
            documentId: parsed.data.documentId,
            recipientContactId: parsed.data.recipientContactId ?? undefined,
            connectionId: parsed.data.connectionId,
            message: parsed.data.message ?? undefined,
            savePreferredChannel: parsed.data.savePreferredChannel,
            paper: parsed.data.paper ?? undefined,
            requestId: parsed.data.requestId ?? undefined,
            otherEmail: parsed.data.otherEmail ?? undefined,
            confirmOtherEmail: parsed.data.confirmOtherEmail,
            patientId,
          },
          { storage: deps.storage },
        ),
      ),
    )
  })

  // --- Papeles de salud (receta, orden, consentimiento firmado) ---
  // Solo a la propia persona o a su representante legal; WhatsApp primero,
  // correo si no; sin ninguno, solo imprimir (lo dice `printOnly`).
  app.get("/:id/health-document-options", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) return forbidClinical(c)
    const parsed = healthOptionsQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const patientId = c.req.param("id")
    const response = await runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getHealthDocumentSendOptions(tx, orgId, patientId, parsed.data),
      ),
    )
    if (response.status === 200)
      await traceClinicalRead(deps.db, {
        orgId,
        userId,
        patientId,
        resource: HEALTH_RESOURCE[parsed.data.documentType],
      })
    return response
  })

  app.post("/:id/health-documents/send", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) return forbidClinical(c)
    const parsed = healthSendInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const patientId = c.req.param("id")
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        sendHealthDocument(
          tx,
          orgId,
          userId,
          {
            patientId,
            documentType: parsed.data.documentType,
            documentId: parsed.data.documentId,
            recipientContactId: parsed.data.recipientContactId ?? undefined,
            connectionId: parsed.data.connectionId,
            message: parsed.data.message ?? undefined,
            requestId: parsed.data.requestId ?? undefined,
          },
          { storage: deps.storage, secretsKey: deps.secretsKey },
        ),
      ),
    )
  })

  // «Agregar correo»: lo guarda en los datos de quien recibe. Mismo permiso que enviar.
  app.post("/:id/financial-documents/recipient-email", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = recipientEmailInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    if (parsed.data.documentType === "ticket") {
      if (!canAccess(memberRole, "finance.write")) return forbid(c)
    } else if (!canSendBudget(memberRole)) {
      return forbid(c)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        saveRecipientEmail(tx, orgId, userId, c.req.param("id"), {
          recipientContactId: parsed.data.recipientContactId,
          email: parsed.data.email,
        }),
      ),
    )
  })

  // Constancia de devolución en PDF, desde lo congelado al devolver.
  app.get("/:id/refund-receipt-pdf", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.read")) return forbid(c)
    const parsed = refundPdfQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const pdf = await withOrgContext(deps.db, orgId, (tx) =>
        getRefundReceiptPdf(tx, orgId, c.req.param("id"), parsed.data.receiptId, parsed.data.paper ?? null),
      )
      return c.body(Buffer.from(pdf.bytes), 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${pdf.filename}"`,
      })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  return app
}
