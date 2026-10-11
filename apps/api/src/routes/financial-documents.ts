import { withOrgContext } from "@odentia/db"
import { Hono } from "hono"
import { z } from "zod"
import {
  getDocumentSendOptions,
  getFinancialDocumentPdf,
  sendFinancialDocument,
} from "@odentia/services"
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
  // Estricto budgets.write: quien puede presupuestar envía; caja no (aunque
  // tenga finance.write). El plan propio del odontólogo se valida en servicio.
  return canAccess(role, "budgets.write")
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
 * budgets.read/write. La titularidad (paciente de la org, destinatario
 * autorizado, plan propio del odontólogo) se valida en el servicio.
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
  })
  .strict()

export function createFinancialDocumentsRoute(deps: Pick<CrmDeps, "db" | "storage">) {
  const app = new Hono()

  app.get("/:id/financial-document-options", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const parsed = optionsQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    if (parsed.data.documentType === "ticket") {
      if (!canAccess(memberRole, "finance.read")) return forbid(c)
    } else if (!canReadBudget(memberRole)) {
      return forbid(c)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getDocumentSendOptions(tx, orgId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.get("/:id/financial-document-pdf", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const parsed = paperQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    if (parsed.data.documentType === "ticket") {
      if (!canAccess(memberRole, "finance.read")) return forbid(c)
    } else if (!canReadBudget(memberRole)) {
      return forbid(c)
    }
    try {
      const pdf = await withOrgContext(deps.db, orgId, (tx) =>
        getFinancialDocumentPdf(tx, orgId, c.req.param("id"), parsed.data),
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
            patientId,
          },
          { storage: deps.storage },
        ),
      ),
    )
  })

  return app
}
