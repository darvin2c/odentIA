import { withOrgContext } from "@odentia/db"
import {
  createAppointment,
  createChair,
  getAppointment,
  listAppointments,
  listScheduleResources,
  moveAppointment,
  setAppointmentStatus,
  updateAppointment,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canWrite, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const STATUS = ["programada", "confirmada", "atendida", "no_asistio", "cancelada"] as const

const csv = (value: string | undefined) =>
  value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean)

const listQuery = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  branchId: z.uuid().optional(),
  professionals: z.string().optional(),
  chairs: z.string().optional(),
  status: z.string().optional(),
  q: z.string().max(200).optional(),
})

const createInput = z.object({
  branchId: z.uuid().optional(),
  patientId: z.uuid(),
  dentistUserId: z.string().min(1),
  chairId: z.uuid(),
  serviceId: z.uuid().optional(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  durationMin: z.number().int().positive().optional(),
  status: z.enum(STATUS).optional(),
  reason: z.string().max(500).optional(),
  source: z.string().max(40).optional(),
  conversationId: z.uuid().optional(),
})

const patchInput = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().max(500).nullable().optional(),
  serviceId: z.uuid().nullable().optional(),
  dentistUserId: z.string().min(1).optional(),
  chairId: z.uuid().optional(),
  status: z.enum(STATUS).optional(),
})

const moveInput = z.object({
  expectedVersion: z.number().int().positive(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  dentistUserId: z.string().min(1).optional(),
  chairId: z.uuid().optional(),
})

const statusInput = z.object({ status: z.enum(STATUS) })

const chairInput = z.object({
  branchId: z.uuid(),
  name: z.string().min(1).max(120),
})

/** Recursos de la agenda: sucursal resuelta, profesionales y sillones. */
export function createAgendaRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/resources", async (c) => {
    const { orgId } = orgContextOf(c)
    const branchId = c.req.query("branchId")
    if (branchId && !z.uuid().safeParse(branchId).success) {
      return c.json(errorBody(c, "VALIDATION", "branchId inválido"), 400)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listScheduleResources(tx, orgId, { branchId })),
    )
  })

  app.post("/chairs", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) {
      return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin pueden crear sillones"), 403)
    }
    const parsed = chairInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createChair(tx, orgId, parsed.data)),
    )
  })

  return app
}

export function createAppointmentsRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { professionals, chairs, status, ...rest } = parsed.data
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listAppointments(tx, orgId, {
          ...rest,
          professionals: csv(professionals),
          chairs: csv(chairs),
          statuses: csv(status),
        }),
      ),
    )
  })

  app.post("/", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createAppointment(tx, orgId, userId, parsed.data)),
    )
  })

  app.get("/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAppointment(tx, orgId, c.req.param("id"))),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = patchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateAppointment(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/:id/move", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = moveInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        moveAppointment(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/:id/status", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = statusInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setAppointmentStatus(tx, orgId, userId, c.req.param("id"), parsed.data.status),
      ),
    )
  })

  return app
}
