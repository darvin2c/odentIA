import { withOrgContext } from "@odentia/db"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"
import { listFollowUps, createFollowUp, scheduleFollowUp, completeFollowUp, cancelFollowUp } from "@odentia/services"

const createInput = z.object({ kind: z.enum(["tratamiento","mantenimiento"]), title: z.string().trim().min(1).max(200), dueAt: z.iso.datetime({offset:true}), instructions: z.string().max(4000).nullish(), planItemId: z.uuid().nullish(), encounterProcedureId: z.uuid().nullish(), originEncounterId: z.uuid().nullish() }).strict()
const scheduleInput = z.object({ scheduledAt: z.iso.datetime({offset:true}) }).strict()
const completeInput = z.object({ encounterId: z.uuid(), outcome: z.string().trim().min(1).max(2000) }).strict()
const reasonInput = z.object({ reason: z.string().trim().min(1).max(2000) }).strict()
const listInput = z.object({ status: z.enum(["pendiente","programado","realizado","cancelado"]).optional() }).strict()

export function createPatientFollowUpsRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  app.get("/:id/follow-ups", async c => {
    const { orgId } = orgContextOf(c)
    const params = z.object({id:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = listInput.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      listFollowUps(tx, orgId, params.data.id, parsed.data)))
  })
  app.post("/:id/follow-ups", async c => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({id:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, tx =>
      createFollowUp(tx, orgId, userId, params.data.id, parsed.data)))
  })
  app.post("/:id/follow-ups/:followUpId/schedule", async c => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({id:z.uuid(),followUpId:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = scheduleInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      scheduleFollowUp(tx, orgId, userId, params.data.id, params.data.followUpId, parsed.data)))
  })
  app.post("/:id/follow-ups/:followUpId/complete", async c => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({id:z.uuid(),followUpId:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = completeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      completeFollowUp(tx, orgId, userId, params.data.id, params.data.followUpId, parsed.data)))
  })
  app.post("/:id/follow-ups/:followUpId/cancel", async c => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({id:z.uuid(),followUpId:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      cancelFollowUp(tx, orgId, userId, params.data.id, params.data.followUpId, parsed.data)))
  })
  return app
}
