import { canAccess } from "@odentia/auth/permissions"
import { withOrgContext } from "@odentia/db"
import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  listFollowUps,
  scheduleFollowUp,
  stopFollowUpRepeat,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const createInput = z
  .object({
    kind: z.enum(["tratamiento", "mantenimiento"]),
    title: z.string().trim().min(1, "Escribe el título del control.").max(200),
    dueAt: z.iso.datetime({ offset: true, error: "Elige la fecha prevista en el calendario." }),
    instructions: z.string().max(4000).nullish(),
    planItemId: z.uuid().nullish(),
    encounterProcedureId: z.uuid().nullish(),
    originEncounterId: z.uuid().nullish(),
    // Cada cuántos meses se repite (issue 229, decisión 16); el servicio valida los valores.
    repeatEveryMonths: z.number().int().nullish(),
  })
  .strict()
const scheduleInput = z.union([
  z.object({ appointmentId: z.uuid() }).strict(),
  z
    .object({
      appointment: z
        .object({
          branchId: z.uuid().optional(),
          professionalUserId: z.string().min(1),
          roomId: z.uuid().optional(),
          serviceId: z.uuid().optional(),
          startsAt: z.iso.datetime({ offset: true }),
          endsAt: z.iso.datetime({ offset: true }).optional(),
          durationMin: z.number().int().positive().optional(),
        })
        .strict(),
    })
    .strict(),
])
const completeInput = z
  .object({
    encounterId: z.uuid("Elige la atención finalizada."),
    outcome: z.string().trim().min(1, "Escribe el resultado del control.").max(2000),
  })
  .strict()
const reasonInput = z
  .object({ reason: z.string().trim().min(1, "Escribe el motivo de la cancelación.").max(2000) })
  .strict()
const listInput = z
  .object({ status: z.enum(["pendiente", "programado", "realizado", "cancelado"]).optional() })
  .strict()

export function createPatientFollowUpsRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  app.get("/:id/follow-ups", async (c) => {
    const { orgId } = orgContextOf(c)
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = listInput.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listFollowUps(tx, orgId, params.data.id, parsed.data)),
    )
  })
  app.post("/:id/follow-ups", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createFollowUp(tx, orgId, userId, params.data.id, parsed.data),
      ),
    )
  })
  app.post("/:id/follow-ups/:followUpId/schedule", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.write"))
      return c.json(
        { error: { code: "FORBIDDEN", message: "No tienes permiso para programar citas" } },
        403,
      )
    const params = z.object({ id: z.uuid(), followUpId: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = scheduleInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        scheduleFollowUp(tx, orgId, userId, params.data.id, params.data.followUpId, parsed.data),
      ),
    )
  })
  app.post("/:id/follow-ups/:followUpId/complete", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({ id: z.uuid(), followUpId: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = completeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        completeFollowUp(tx, orgId, userId, params.data.id, params.data.followUpId, parsed.data),
      ),
    )
  })
  app.post("/:id/follow-ups/:followUpId/stop-repeat", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({ id: z.uuid(), followUpId: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        stopFollowUpRepeat(tx, orgId, userId, params.data.id, params.data.followUpId),
      ),
    )
  })
  app.post("/:id/follow-ups/:followUpId/cancel", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({ id: z.uuid(), followUpId: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        cancelFollowUp(tx, orgId, userId, params.data.id, params.data.followUpId, parsed.data),
      ),
    )
  })
  return app
}
