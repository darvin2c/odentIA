import { withOrgContext } from "@odentia/db"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"
import { confirmPendingRepresentative, listResponsibilities, grantResponsibility, revokeResponsibility } from "@odentia/services"

const createInput = z.object({contactId:z.uuid(),kind:z.enum(["representante_legal","autorizado_informacion","responsable_economico"]),startsAt:z.iso.date(),endsAt:z.iso.date().nullish(),evidenceDocumentId:z.uuid().nullish(),notes:z.string().max(4000).nullish()}).strict()
const reasonInput = z.object({ reason: z.string().trim().min(1).max(2000) }).strict()

export function createPatientResponsibilitiesRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  app.get("/:id/responsibilities", async c => {
    const { orgId } = orgContextOf(c)
    const params = z.object({id:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      listResponsibilities(tx, orgId, params.data.id)))
  })
  app.post("/:id/responsibilities", async c => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({id:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, tx =>
      grantResponsibility(tx, orgId, userId, params.data.id, parsed.data)))
  })
  app.post("/:id/responsibilities/:responsibilityId/revoke", async c => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({id:z.uuid(),responsibilityId:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      revokeResponsibility(tx, orgId, userId, params.data.id, params.data.responsibilityId, parsed.data)))
  })
  // «Confirmar» en «Te espera»: el representante que nombró un registro en línea (patients.write, por el guarda de la ruta).
  app.post("/:id/responsibilities/pending/:taskId/confirm", async c => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({id:z.uuid(),taskId:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      confirmPendingRepresentative(tx, orgId, userId, params.data.id, params.data.taskId)))
  })
  return app
}
