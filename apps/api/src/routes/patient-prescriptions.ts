import { withOrgContext } from "@odentia/db"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"
import { listPrescriptions, createPrescription, getPrescriptionDetail, cancelPrescription } from "@odentia/services"

const field = z.string().trim().min(1).max(200)
const createInput = z.object({ encounterId: z.uuid().nullish(), planItemId: z.uuid().nullish(), notes: z.string().max(4000).nullish(), items: z.array(z.object({medicationName:field,dose:field,route:field,frequency:field,duration:field,quantity:z.number().int().positive().max(2147483647).nullish(),instructions:z.string().max(4000).nullish()}).strict()).min(1).max(20) }).strict()
const reasonInput = z.object({ reason: z.string().trim().min(1).max(2000) }).strict()

export function createPatientPrescriptionsRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  app.get("/:id/prescriptions", async c => {
    const { orgId } = orgContextOf(c)
    const params = z.object({id:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      listPrescriptions(tx, orgId, params.data.id)))
  })
  app.post("/:id/prescriptions", async c => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({id:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, tx =>
      createPrescription(tx, orgId, userId, params.data.id, parsed.data)))
  })
  app.get("/:id/prescriptions/:prescriptionId", async c => {
    const { orgId } = orgContextOf(c)
    const params = z.object({id:z.uuid(),prescriptionId:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      getPrescriptionDetail(tx, orgId, params.data.id, params.data.prescriptionId)))
  })
  app.post("/:id/prescriptions/:prescriptionId/cancel", async c => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({id:z.uuid(),prescriptionId:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      cancelPrescription(tx, orgId, userId, params.data.id, params.data.prescriptionId, parsed.data)))
  })
  return app
}
