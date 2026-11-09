import { withOrgContext } from "@odentia/db"
import {
  currentLensPrescriptions,
  renderLensPrescriptionPdf,
  issueLensPrescription,
  listLensPrescriptions,
  transcribeLensPrescription,
  verifyLensPrescription,
  voidLensPrescription,
} from "@odentia/services/optical"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../../lib/context.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "../helpers.js"

/**
 * Las recetas de lentes de vistIA (entrega 3 del plan). Lo valida el servicio
 * (`@odentia/optical`): aquí solo la forma del pedido. Solo responde en una
 * óptica: en otro producto no hay recetas de lentes.
 */
const lenses = z.record(z.string(), z.unknown())
const issueInput = z
  .object({
    encounterId: z.uuid(),
    kind: z.enum(["anteojos", "contacto"]),
    lenses: lenses.nullish(),
    notes: z.string().max(2000).nullish(),
    validUntil: z.iso.date("Elige la fecha en el calendario.").nullish(),
  })
  .strict()
const transcribeInput = z
  .object({
    kind: z.enum(["anteojos", "contacto"]),
    lenses,
    issuedOn: z.iso.date("Elige la fecha de la receta en el calendario."),
    validUntil: z.iso.date("Elige la fecha en el calendario.").nullish(),
    prescriberName: z.string().trim().min(1, "Escribe quién la firmó.").max(200),
    prescriberRegistration: z.string().max(60).nullish(),
    notes: z.string().max(2000).nullish(),
    pupillaryDistance: z.record(z.string(), z.unknown()).nullish(),
    photoDocumentId: z.uuid().nullish(),
  })
  .strict()
const reasonInput = z.object({ reason: z.string().trim().min(1, "Escribe el motivo de la anulación.").max(2000) }).strict()
const patientParams = z.object({ id: z.uuid() })
const itemParams = z.object({ id: z.uuid(), prescriptionId: z.uuid() })

export function createPatientLensPrescriptionsRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  app.get("/:id/lens-prescriptions", async (c) => {
    const { orgId } = orgContextOf(c)
    const params = patientParams.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => ({
        items: await listLensPrescriptions(tx, orgId, params.data.id),
        current: await currentLensPrescriptions(tx, orgId, params.data.id),
      })),
    )
  })
  app.post("/:id/lens-prescriptions", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = patientParams.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = issueInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => issueLensPrescription(tx, orgId, userId, params.data.id, parsed.data)),
    )
  })
  app.post("/:id/lens-prescriptions/external", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = patientParams.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = transcribeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => transcribeLensPrescription(tx, orgId, userId, params.data.id, parsed.data)),
    )
  })
  app.post("/:id/lens-prescriptions/:prescriptionId/verify", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = itemParams.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => verifyLensPrescription(tx, orgId, userId, params.data.id, params.data.prescriptionId)),
    )
  })
  app.post("/:id/lens-prescriptions/:prescriptionId/void", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = itemParams.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        voidLensPrescription(tx, orgId, userId, params.data.id, params.data.prescriptionId, parsed.data),
      ),
    )
  })
  // La receta impresa, para entregarla: se abre en el navegador y se imprime o se guarda.
  app.get("/:id/lens-prescriptions/:prescriptionId/pdf", async (c) => {
    const { orgId } = orgContextOf(c)
    const params = itemParams.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    try {
      const pdf = await withOrgContext(deps.db, orgId, (tx) =>
        renderLensPrescriptionPdf(tx, orgId, params.data.id, params.data.prescriptionId),
      )
      return new Response(Buffer.from(pdf.bytes), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${pdf.filename}"`,
          "Cache-Control": "no-store",
        },
      })
    } catch (error) {
      const response = serviceErrorResponse(c, error)
      if (response) return response
      throw error
    }
  })
  return app
}
