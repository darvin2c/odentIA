import { withOrgContext } from "@odentia/db"
import {
  appointmentReminderReach,
  createAppointment,
  operationBodySchema,
  createRoom,
  createScheduleBlock,
  deleteScheduleBlock,
  getAgendaAvailability,
  getAppointment,
  getAppointmentContext,
  getBranchHours,
  getPatientMissingData,
  getProfessionalSchedule,
  listAppointments,
  listRooms,
  roomNotFound,
  roomWord,
  listScheduleBlocks,
  listScheduleResources,
  moveAppointment,
  searchAgendaPatients,
  setAppointmentArrival,
  setAppointmentStatus,
  setBranchDefaultDuration,
  setProfessionalSchedule,
  updateAppointment,
  updateRoom,
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
  rooms: z.string().optional(),
  status: z.string().optional(),
  q: z.string().max(200).optional(),
  patientId: z.uuid().optional(),
})

// Reservar y mover una cita declaran sus campos una vez, para la pantalla y para el agente.
const createInput = operationBodySchema("cita.reservar")

const settingsInput = z.object({
  branchId: z.uuid(),
  defaultDurationMin: z.number().int().positive().max(480),
})

// Los detalles de la cita; el estado tiene sus propias vías (`/status`, `/arrival`
// y el cierre de la atención), cada una con sus efectos.
const patchInput = z
  .object({
    expectedVersion: z.number().int().positive(),
    reason: z.string().max(500).nullable().optional(),
    serviceId: z.uuid().nullable().optional(),
    professionalUserId: z.string().min(1).optional(),
    roomId: z.uuid().optional(),
  })
  .strict()

const arrivalInput = z.object({ arrived: z.boolean() }).strict()

const moveInput = operationBodySchema("cita.mover")

const statusInput = z.object({
  status: z.enum(STATUS),
  cancelReason: z.enum(["paciente", "clinica", "otro"]).optional(),
  cancelNote: z.string().max(500).optional(),
})

const roomInput = z.object({
  branchId: z.uuid(),
  name: z.string().trim().min(1, "Escribe el nombre.").max(120, "Escribe el nombre en 120 caracteres como mucho."),
})

const roomPatch = z
  .object({
    name: z.string().trim().min(1, "Escribe el nombre.").max(120, "Escribe el nombre en 120 caracteres como mucho.").optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

const scheduleRuleInput = z.object({
  weekday: z.number().int().min(0).max(6),
  startMin: z.number().int().min(0).max(1440),
  endMin: z.number().int().min(0).max(1440),
})

const scheduleInput = z.object({
  branchId: z.uuid(),
  professionalUserId: z.string().min(1),
  // El error va en `rules` y se dice junto al horario.
  rules: z.array(scheduleRuleInput).max(42, "Como mucho 42 turnos en la semana."),
})

const blockInput = z.object({
  branchId: z.uuid(),
  professionalUserId: z.string().min(1).nullable().optional(),
  roomId: z.uuid("Elige qué se cierra de la lista.").nullable().optional(),
  kind: z.enum(["bloqueo", "ausencia"], "Elige si es una ausencia o un bloqueo.").optional(),
  reason: z.string().max(500, "Escribe el motivo en 500 caracteres como mucho.").optional(),
  startsAt: z.iso.datetime({ offset: true, message: "Elige cuándo empieza." }),
  endsAt: z.iso.datetime({ offset: true, message: "Elige cuándo termina." }),
})

const availabilityQuery = z.object({
  branchId: z.uuid(),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  // Al reprogramar: el hueco de esa cita cuenta como libre.
  ignoreAppointmentId: z.uuid().optional(),
  // «Nueva cita» con servicio: solo quien lo atiende (ADR 0039).
  serviceId: z.uuid().optional(),
})

const searchQuery = z.object({ q: z.string().trim().min(2).max(200) })

/** Agenda: recursos, huecos, horarios y bloqueos. */
export function createAgendaRoute(deps: CrmDeps) {
  /** Lo que se reserva, con la palabra del producto de la clínica, para los mensajes de la ruta. */
  const roomWordOf = (orgId: string) => withOrgContext(deps.db, orgId, (tx) => roomWord(tx, orgId))
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

  // El horario de atención de la sede: la suma de los horarios del equipo y sus
  // próximos cierres, el mismo que dice el agente.
  app.get("/hours", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver la agenda"), 403)
    }
    const branchId = c.req.query("branchId")
    if (!branchId || !z.uuid().safeParse(branchId).success) {
      return c.json(errorBody(c, "VALIDATION", "branchId inválido"), 400)
    }
    return runService(c, 200, async () => {
      const [hours] = await withOrgContext(deps.db, orgId, (tx) => getBranchHours(tx, orgId, new Date(), { branchId }))
      return hours ?? null
    })
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

  app.post("/rooms", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", `No tienes permiso para configurar ${(await roomWordOf(orgId)).many}`), 403)
    }
    const parsed = roomInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createRoom(tx, orgId, parsed.data)),
    )
  })

  // Las unidades dentales de la sede para administrarlas: también las desactivadas.
  app.get("/rooms", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.read")) {
      return c.json(errorBody(c, "FORBIDDEN", `No tienes permiso para ver la configuración de ${(await roomWordOf(orgId)).many}`), 403)
    }
    const branchId = c.req.query("branchId")
    if (!branchId || !z.uuid().safeParse(branchId).success) {
      return c.json(errorBody(c, "VALIDATION", "branchId es obligatorio"), 400)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listRooms(tx, orgId, { branchId })),
    )
  })

  // Renombrar una unidad dental, desactivarla o reactivarla.
  app.patch("/rooms/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", `No tienes permiso para configurar ${(await roomWordOf(orgId)).many}`), 403)
    }
    const id = c.req.param("id")
    if (!z.uuid().safeParse(id).success) {
      return c.json(errorBody(c, "NOT_FOUND", roomNotFound((await roomWordOf(orgId)).one).message), 404)
    }
    const parsed = roomPatch.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => updateRoom(tx, orgId, userId, id, parsed.data)),
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
    const professionalUserId = c.req.query("professionalUserId")
    if (!branchId || !z.uuid().safeParse(branchId).success || !professionalUserId) {
      return c.json(errorBody(c, "VALIDATION", "branchId y professionalUserId son obligatorios"), 400)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getProfessionalSchedule(tx, orgId, branchId, professionalUserId),
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
    const { professionals, rooms, status, ...rest } = parsed.data
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listAppointments(tx, orgId, {
          ...rest,
          professionals: csv(professionals),
          rooms: csv(rooms),
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
      withOrgContext(deps.db, orgId, async (tx) => {
        const created = await createAppointment(tx, orgId, userId, parsed.data)
        // Si el recordatorio le llegará: «Carmen no recibirá el recordatorio: aún no tiene WhatsApp».
        return { ...created, reminderReach: await appointmentReminderReach(tx, orgId, created.patientId) }
      }),
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

  /**
   * Lo que el cajón de la cita dice además de la cita: a quién se le escribe
   * (con su teléfono), de qué conversación salió y cuándo le pedirá el agente
   * que confirme. Lo lee quien ve la agenda.
   */
  app.get("/:id/context", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver la agenda"), 403)
    }
    // «Faltan datos para atenderla»: la misma regla del servidor que la página
    // de la persona, solo para quien edita sus datos.
    const canEditPerson = canAccess(memberRole, "patients.write")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const context = await getAppointmentContext(tx, orgId, c.req.param("id"))
        const { patientId } = await getAppointment(tx, orgId, c.req.param("id"))
        return {
          ...context,
          missingData: canEditPerson ? await getPatientMissingData(tx, orgId, patientId) : null,
        }
      }),
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

  /**
   * «Llegó» y «Deshacer» (ADR 0032): la marcan recepción y el odontólogo, con el
   * mismo permiso que cambia las citas.
   */
  app.post("/:id/arrival", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para marcar la llegada"), 403)
    }
    const parsed = arrivalInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setAppointmentArrival(tx, orgId, userId, c.req.param("id"), parsed.data.arrived),
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
