import { MEDICAL_LEAVE_MAX_DAYS } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import {
  cancelMedicalLeave,
  createMedicalLeave,
  getMedicalLeavePrint,
  listMedicalLeaves,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

/** El descanso médico (issue 229, decisión 8): emitir, listar, imprimir y anular, como la receta. */
const createInput = z
  .object({
    encounterId: z.uuid().nullish(),
    startsOn: z.iso.date().nullish(),
    days: z.number().int().min(1).max(MEDICAL_LEAVE_MAX_DAYS),
    showDiagnosis: z.boolean().optional(),
    diagnosisCode: z.string().max(10).nullish(),
    diagnosisSystem: z.string().max(20).nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .strict()
const reasonInput = z.object({ reason: z.string().trim().min(1).max(2000) }).strict()
const leaveParams = z.object({ id: z.uuid(), leaveId: z.uuid() })

export function createPatientMedicalLeavesRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  app.get("/:id/medical-leaves", async (c) => {
    const { orgId } = orgContextOf(c)
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listMedicalLeaves(tx, orgId, params.data.id)),
    )
  })
  app.post("/:id/medical-leaves", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createMedicalLeave(tx, orgId, userId, params.data.id, parsed.data),
      ),
    )
  })
  // Datos de la hoja impresa: la plataforma la compone y el navegador la imprime.
  app.get("/:id/medical-leaves/:leaveId/print", async (c) => {
    const { orgId } = orgContextOf(c)
    const params = leaveParams.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getMedicalLeavePrint(tx, orgId, params.data.id, params.data.leaveId),
      ),
    )
  })
  app.post("/:id/medical-leaves/:leaveId/cancel", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = leaveParams.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        cancelMedicalLeave(tx, orgId, userId, params.data.id, params.data.leaveId, parsed.data),
      ),
    )
  })
  return app
}
