import { ADMINISTRATION_ROUTES } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import {
  cancelPrescription,
  createPrescription,
  getPrescriptionDetail,
  getPrescriptionPrint,
  listPrescriptions,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const field = z.string().trim().min(1).max(200)
const QUANTITY = "La cantidad es un número entero de 1 a 9999."
const WEIGHT = "Escribe el peso en kilos, de 0,5 a 400."
const item = z
  .object({
    genericName: field,
    brandName: z.string().trim().max(200).nullish(),
    strength: z.string().trim().min(1).max(60),
    dosageForm: z.string().trim().min(1).max(60),
    dose: field,
    route: z.enum(ADMINISTRATION_ROUTES),
    frequency: field,
    duration: field,
    quantity: z.number(QUANTITY).int(QUANTITY).positive(QUANTITY).max(9999, QUANTITY).nullish(),
    instructions: z.string().max(2000, "Las instrucciones tienen como mucho 2000 caracteres.").nullish(),
  })
  .strict()
const createInput = z
  .object({
    encounterId: z.uuid().nullish(),
    planItemId: z.uuid().nullish(),
    notes: z.string().max(2000, "Las notas tienen como mucho 2000 caracteres.").nullish(),
    diagnosisCode: z.string().max(10).nullish(),
    diagnosisSystem: z.string().max(20).nullish(),
    validUntil: z.iso.date("Elige la fecha en el calendario.").nullish(),
    acknowledgeAllergies: z.boolean().optional(),
    allergyOverrideReason: z.string().max(500, "El motivo para recetar igual tiene como mucho 500 caracteres.").nullish(),
    /** El peso (kg) con que se receta; latidIA lo pide a un menor de 12 años (issue 229). */
    patientWeightKg: z.number(WEIGHT).min(0.5, WEIGHT).max(400, WEIGHT).nullish(),
    items: z.array(item).min(1, "Añade al menos un medicamento.").max(20, "La receta lleva hasta 20 medicamentos."),
  })
  .strict()
const reasonInput = z
  .object({ reason: z.string().trim().min(1, "Escribe el motivo de la anulación.").max(2000) })
  .strict()

export function createPatientPrescriptionsRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  app.get("/:id/prescriptions", async (c) => {
    const { orgId } = orgContextOf(c)
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listPrescriptions(tx, orgId, params.data.id)),
    )
  })
  app.post("/:id/prescriptions", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createPrescription(tx, orgId, userId, params.data.id, parsed.data),
      ),
    )
  })
  app.get("/:id/prescriptions/:prescriptionId", async (c) => {
    const { orgId } = orgContextOf(c)
    const params = z.object({ id: z.uuid(), prescriptionId: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getPrescriptionDetail(tx, orgId, params.data.id, params.data.prescriptionId),
      ),
    )
  })
  // Datos de la hoja impresa: la plataforma la compone y el navegador la imprime.
  app.get("/:id/prescriptions/:prescriptionId/print", async (c) => {
    const { orgId } = orgContextOf(c)
    const params = z.object({ id: z.uuid(), prescriptionId: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getPrescriptionPrint(tx, orgId, params.data.id, params.data.prescriptionId),
      ),
    )
  })
  app.post("/:id/prescriptions/:prescriptionId/cancel", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({ id: z.uuid(), prescriptionId: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        cancelPrescription(
          tx,
          orgId,
          userId,
          params.data.id,
          params.data.prescriptionId,
          parsed.data,
        ),
      ),
    )
  })
  return app
}
