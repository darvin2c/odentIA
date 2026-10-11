import { withOrgContext } from "@odentia/db"
import {
  createAppointment,
  createChair,
  createScheduleBlock,
  deleteScheduleBlock,
  getAgendaAvailability,
  getAppointment,
  getProfessionalSchedule,
  listAppointments,
  listAvailableSlots,
  listScheduleBlocks,
  listScheduleResources,
  moveAppointment,
  searchAgendaPatients,
  setAppointmentStatus,
  setBranchDefaultDuration,
  setProfessionalSchedule,
  updateAppointment,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
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
  patientId: z.uuid().optional(),
})

const createInput = z.object({
  branchId: z.uuid().optional(),
  patientId: z.uuid(),
  dentistUserId: z.string().min(1),
  chairId: z.uuid().optional(),
  serviceId: z.uuid().optional(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  durationMin: z.number().int().positive().optional(),
  status: z.enum(STATUS).optional(),
  reason: z.string().max(500).optional(),
  source: z.string().max(40).optional(),
  conversationId: z.uuid().optional(),
  outsideSchedule: z.boolean().optional(),
})

const settingsInput = z.object({
  branchId: z.uuid(),
  defaultDurationMin: z.number().int().positive().max(480),
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

const statusInput = z.object({
  status: z.enum(STATUS),
  cancelReason: z.enum(["paciente", "clinica", "otro"]).optional(),
  cancelNote: z.string().max(500).optional(),
})

const chairInput = z.object({
  branchId: z.uuid(),
  name: z.string().min(1).max(120),
})

const scheduleRuleInput = z.object({
  weekday: z.number().int().min(0).max(6),
  startMin: z.number().int().min(0).max(1440),
  endMin: z.number().int().min(0).max(1440),
})

const scheduleInput = z.object({
  branchId: z.uuid(),
  dentistUserId: z.string().min(1),
  rules: z.array(scheduleRuleInput).max(42),
})

const blockInput = z.object({
  branchId: z.uuid(),
  dentistUserId: z.string().min(1).nullable().optional(),
  chairId: z.uuid().nullable().optional(),
  kind: z.enum(["bloqueo", "ausencia"]).optional(),
  reason: z.string().max(500).optional(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
})

const slotsQuery = z.object({
  branchId: z.uuid(),
  dentistUserId: z.string().min(1).optional(),
  chairId: z.uuid().optional(),
  serviceId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  durationMin: z.coerce.number().int().positive().max(480).optional(),
  timeZone: z.string().max(60).optional(),
  stepMin: z.coerce.number().int().min(5).max(120).optional(),
})

const availabilityQuery = z.object({
  branchId: z.uuid(),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  // Al reprogramar: el hueco de esa cita cuenta como libre.
  ignoreAppointmentId: z.uuid().optional(),
})

const searchQuery = z.object({ q: z.string().trim().min(2).max(200) })

/** Agenda: recursos, huecos, horarios y bloqueos. */
export function createAgendaRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/resources", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver la agenda"), 403)
    }
    const branchId = c.req.query("branchId")
    if (branchId && !z.uuid().safeParse(branchId).success) {
      return c.json(errorBody(c, "VALIDATION", "branchId inválido"), 400)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listScheduleResources(tx, orgId, { branchId })),
    )
  })

  // Lo que dura una cita regular en la sede (la que se reserva sin servicio).
  app.put("/settings", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para configurar la agenda"), 403)
    }
    const parsed = settingsInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setBranchDefaultDuration(tx, orgId, userId, {
          branchId: parsed.data.branchId,
          minutes: parsed.data.defaultDurationMin,
        }),
      ),
    )
  })

  app.post("/chairs", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para configurar sillones"), 403)
    }
    const parsed = chairInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createChair(tx, orgId, parsed.data)),
    )
  })

  // Huecos reservables con zona IANA.
  app.get("/slots", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver la agenda"), 403)
    }
    const parsed = slotsQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        // Lo ya pasado no se ofrece: el corte lo pone el servidor, no el reloj del cliente.
        listAvailableSlots(tx, orgId, { ...parsed.data, notBefore: new Date().toISOString() }),
      ),
    )
  })

  // Lo que la agenda pinta como reservable: horario, bloqueos y próximo hueco por profesional.
  app.get("/availability", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver la agenda"), 403)
    }
    const parsed = availabilityQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAgendaAvailability(tx, orgId, parsed.data)),
    )
  })

  // Búsqueda de la cita de un paciente: personas y sus próximas citas en pie.
  app.get("/search", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver la agenda"), 403)
    }
    // Busca por documento y teléfono: exige también poder ver pacientes.
    if (!canAccess(memberRole, "patients.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para buscar pacientes"), 403)
    }
    const parsed = searchQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => searchAgendaPatients(tx, orgId, parsed.data)),
    )
  })

  // Horario semanal del profesional.
  app.get("/schedules", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver la agenda"), 403)
    }
    const branchId = c.req.query("branchId")
    const dentistUserId = c.req.query("dentistUserId")
    if (!branchId || !z.uuid().safeParse(branchId).success || !dentistUserId) {
      return c.json(errorBody(c, "VALIDATION", "branchId y dentistUserId son obligatorios"), 400)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getProfessionalSchedule(tx, orgId, branchId, dentistUserId),
      ),
    )
  })

  // Configuración de horario.
  app.put("/schedules", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para configurar horarios"), 403)
    }
    const parsed = scheduleInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setProfessionalSchedule(tx, orgId, userId, parsed.data),
      ),
    )
  })

  // Bloqueos y ausencias.
  app.get("/blocks", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver la agenda"), 403)
    }
    const branchId = c.req.query("branchId")
    const from = c.req.query("from")
    const to = c.req.query("to")
    if (!branchId || !z.uuid().safeParse(branchId).success || !from || !to) {
      return c.json(errorBody(c, "VALIDATION", "branchId, from y to son obligatorios"), 400)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listScheduleBlocks(tx, orgId, { branchId, from, to }),
      ),
    )
  })

  // Configuración de bloqueos.
  app.post("/blocks", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para configurar bloqueos"), 403)
    }
    const parsed = blockInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createScheduleBlock(tx, orgId, userId, parsed.data),
      ),
    )
  })

  app.delete("/blocks/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para configurar bloqueos"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await deleteScheduleBlock(tx, orgId, c.req.param("id"))
        return { ok: true }
      }),
    )
  })

  return app
}

export function createAppointmentsRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver la agenda"), 403)
    }
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
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para reservar citas"), 403)
    }
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createAppointment(tx, orgId, userId, parsed.data)),
    )
  })

  app.get("/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver la agenda"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAppointment(tx, orgId, c.req.param("id"))),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para modificar citas"), 403)
    }
    const parsed = patchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateAppointment(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/:id/move", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para mover citas"), 403)
    }
    const parsed = moveInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        moveAppointment(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/:id/status", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para cambiar el estado de citas"), 403)
    }
    const parsed = statusInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setAppointmentStatus(tx, orgId, userId, c.req.param("id"), parsed.data.status, {
          cancelReason: parsed.data.cancelReason,
          cancelNote: parsed.data.cancelNote,
        }),
      ),
    )
  })

  return app
}
