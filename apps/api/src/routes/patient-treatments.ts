import { withOrgContext } from "@odentia/db"
import { getTreatmentJourney, revisePlanItem, setPlanItemStatus } from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const reviseInput = z
  .object({
    encounterId: z.uuid(),
    reason: z.string().trim().min(1).max(2000),
    serviceId: z.uuid(),
    toothNumber: z.number().int().nullish(),
    surfaces: z.array(z.string()).max(5).nullish(),
    quadrant: z.number().int().min(1).max(8).nullish(),
    arch: z.enum(["upper", "lower"]).nullish(),
    detail: z.string().max(4000).nullish(),
    diagnosisCode: z.string().max(10).nullish(),
  })
  .strict()
const completeInput = z.object({ encounterId: z.uuid() }).strict()
const reasonInput = z
  .object({ encounterId: z.uuid().optional(), reason: z.string().trim().min(1).max(2000) })
  .strict()
const resumeInput = z.object({ status: z.enum(["pendiente", "programado", "en_curso"]) }).strict()
const itemParams = z.object({ id: z.uuid(), itemId: z.uuid() })

export function createPatientTreatmentsRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  app.get("/:id/treatments/:itemId/journey", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const params = itemParams.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    // Ruta clínica (`clinical.read`); la caja del tratamiento solo viaja con `finance.read`.
    const finance = canAccess(memberRole, "finance.read")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getTreatmentJourney(tx, orgId, params.data.id, params.data.itemId, { finance }),
      ),
    )
  })
  app.post("/:id/treatments/:itemId/revise", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = itemParams.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = reviseInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        revisePlanItem(tx, orgId, userId, params.data.id, params.data.itemId, parsed.data),
      ),
    )
  })
  app.post("/:id/treatments/:itemId/complete", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = itemParams.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = completeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setPlanItemStatus(tx, orgId, userId, params.data.id, params.data.itemId, {
          ...parsed.data,
          status: "realizado",
        }),
      ),
    )
  })
  app.post("/:id/treatments/:itemId/resume", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = itemParams.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = resumeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setPlanItemStatus(tx, orgId, userId, params.data.id, params.data.itemId, {
          status: parsed.data.status,
        }),
      ),
    )
  })
  for (const [action, status] of [
    ["suspend", "suspendido"],
    ["cancel", "cancelado"],
  ] as const) {
    app.post(`/:id/treatments/:itemId/${action}`, async (c) => {
      const { orgId, userId } = orgContextOf(c)
      const params = itemParams.safeParse(c.req.param())
      if (!params.success) return validationError(c, params.error.issues)
      const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return validationError(c, parsed.error.issues)
      return runService(c, 200, () =>
        withOrgContext(deps.db, orgId, (tx) =>
          setPlanItemStatus(tx, orgId, userId, params.data.id, params.data.itemId, {
            encounterId: parsed.data.encounterId,
            statusReason: parsed.data.reason,
            status,
          }),
        ),
      )
    })
  }
  return app
}
