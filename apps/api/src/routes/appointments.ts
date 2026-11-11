import { withOrgContext } from "@odentia/db"
import {
  appointmentPatientId,
  appointmentReminderReach,
  newPersonRemindersVia,
  createAppointment,
  createRoom,
  createScheduleBlock,
  deleteScheduleBlock,
  getAgendaAvailability,
  getAppointment,
  getAppointmentContext,
  getBranchHours,
  getProfessionalSchedule,
  getStaffMissingData,
  listAppointments,
  listRooms,
  listScheduleBlocks,
  listScheduleResources,
  listTeamAttendance,
  markAppointmentCame,
  undoAppointmentCame,
  skipAppointmentRecord,
  moveAppointment,
  operationBodySchema,
  requirePatient,
  reuseAppointment,
  roomNotFound,
  roomWord,
  ServiceError,
  searchAgendaPatients,
  setAppointmentArrival,
  setAppointmentPlanItems,
  setAppointmentStatus,
  setBranchDefaultDuration,
  setProfessionalSchedule,
  updateAppointment,
  updateRoom,
} from "@odentia/services"
import { type Context, Hono, type Next } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { canonicalUuid, patientLockRefusal } from "../lib/record-lock.js"
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
const planItemsInput = z
  .object({
    expectedVersion: z.number().int().positive(),
    add: z.array(z.uuid()).max(52).optional(),
    remove: z.array(z.uuid()).max(52).optional(),
  })
  .strict()

const patchInput = z
  .object({
    expectedVersion: z.number().int().positive(),
    reason: z.string().max(500).nullable().optional(),
    serviceId: z.uuid().nullable().optional(),
    professionalUserId: z.string().min(1).optional(),
    roomId: z.uuid().optional(),
  })
  .strict()

// `expectedVersion`: la versión que vio la pantalla; un cajón abierto antes no pisa lo que cambió otro.
const expectedVersion = z.number().int().positive().optional()

const arrivalInput = z.object({ arrived: z.boolean(), expectedVersion }).strict()

const cameInput = z.object({ undo: z.boolean().optional(), expectedVersion }).strict()

const moveInput = operationBodySchema("cita.mover")

const statusInput = z.object({
  status: z.enum(STATUS),
  cancelReason: z.enum(["paciente", "clinica", "otro"]).optional(),
  cancelNote: z.string().max(500).optional(),
  // Lo avisó por teléfono: ya lo sabe, no hace falta otro mensaje.
  notice: z.literal(false).optional(),
  // Cómo confirmó la persona, cuando lo anota el equipo: queda en la actividad de la cita.
  via: z.enum(["telefono", "en_persona", "mensaje"]).optional(),
  expectedVersion,
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
  // Quien se pidió al abrir: con servicio, viene aunque la regla no lo ofrezca (ADR 0039).
  professionalUserId: z.string().trim().min(1).max(200).optional(),
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

  // Qué días atiende cada persona y cuántas citas tiene por venir: lo que dice Equipo.
  app.get("/team", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver el equipo"), 403)
    }
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listTeamAttendance(tx, orgId)))
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

  // Bloqueos y ausencias. Quien configura, todo; quien lleva la agenda anota la ausencia de
  // cualquier profesional; quien atiende, solo la suya (mesa del 10 nov, decisiones 1 y 4).
  app.post("/blocks", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = blockInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const absence = parsed.data.kind === "ausencia" && Boolean(parsed.data.professionalUserId)
    const allowed =
      canAccess(memberRole, "settings.write") ||
      (absence && canAccess(memberRole, "appointments.absences")) ||
      (absence && parsed.data.professionalUserId === userId && canAccess(memberRole, "clinical.write"))
    if (!allowed) {
      return c.json(
        errorBody(
          c,
          "FORBIDDEN",
          absence && canAccess(memberRole, "clinical.write")
            ? "Solo puedes anotar tu propia ausencia"
            : "No tienes permiso para anotar ausencias ni bloqueos",
        ),
        403,
      )
    }
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createScheduleBlock(tx, orgId, userId, parsed.data),
      ),
    )
  })

  app.delete("/blocks/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const configures = canAccess(memberRole, "settings.write")
    const scope = configures
      ? undefined
      : canAccess(memberRole, "appointments.absences")
        ? { absenceOf: null }
        : canAccess(memberRole, "clinical.write")
          ? { absenceOf: userId }
          : null
    if (scope === null) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para configurar bloqueos"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await deleteScheduleBlock(tx, orgId, c.req.param("id"), userId, scope)
        return { ok: true }
      }),
    )
  })

  return app
}

export function createAppointmentsRoute(deps: CrmDeps) {
  const app = new Hono()

  // La historia bloqueada (ADR 0080) también en la cita que se abre por su id:
  // la cita dice de quién es. `?patientId=` y el cuerpo los guarda `lockedRecordGuard`.
  const appointmentLock = async (c: Context, next: Next) => {
    const id = canonicalUuid(c.req.param("id"))
    if (id) {
      const { orgId } = orgContextOf(c)
      const patientId = await withOrgContext(deps.db, orgId, (tx) => appointmentPatientId(tx, orgId, id)).catch((error) => {
        // Una cita que no existe lo dice su ruta, con su 404 de siempre.
        if (error instanceof ServiceError && error.status === 404) return null
        throw error
      })
      const refusal = patientId ? await patientLockRefusal(c, deps.db, patientId, "Cita no encontrada") : null
      if (refusal) return refusal
    }
    await next()
  }
  app.use("/:id", appointmentLock)
  app.use("/:id/*", appointmentLock)

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

  // Por dónde le llegarían los recordatorios a alguien que aún no está registrado: la Agenda no promete WhatsApp si no saldrán (B2).
  app.get("/reminders-via", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para reservar citas"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => ({ via: await newPersonRemindersVia(tx, orgId) })),
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
        // El origen lo fija el servidor: por esta ruta reserva una persona del equipo (en una
        // conversación o en recepción). «Agente» y «enlace» los ponen Sofi y el enlace en su propio
        // servicio: el origen decide el cobro y lo que Reportes atribuye a Sofi.
        const source = parsed.data.conversationId ? "conversacion" : "recepcion"
        const created = await createAppointment(tx, orgId, userId, { ...parsed.data, source }, { requested: true })
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
          missingData: canEditPerson ? await getStaffMissingData(tx, orgId, patientId) : null,
          // «atenderlo» o «atenderla»: la frase concuerda con el paciente.
          patientSex: canEditPerson ? (await requirePatient(tx, orgId, patientId)).sex : null,
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

  // Lo que lleva una cita que ya existe: «Sumar a su cita» y su «Deshacer» (la lista entera).
  app.post("/:id/plan-items", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para modificar citas"), 403)
    }
    const parsed = planItemsInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setAppointmentPlanItems(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  // «Vino»: la cita pasada que nadie cerró queda atendida sin abrir otra atención (decisión B1).
  app.post("/:id/came", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.write")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "No tienes permiso para cambiar el estado de citas"),
        403,
      )
    }
    const parsed = cameInput.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const options = { expectedVersion: parsed.data.expectedVersion }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        parsed.data.undo
          ? undoAppointmentCame(tx, orgId, userId, c.req.param("id"), options)
          : markAppointmentCame(tx, orgId, userId, c.req.param("id"), options),
      ),
    )
  })

  // «No hace falta»: la cita cerrada con «Vino» no tendrá su atención registrada. Lo decide quien
  // atiende (escribe en la historia), no recepción: la fila es del profesional.
  app.post("/:id/record-skipped", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Lo decide quien atiende: solo quien escribe en la historia clínica"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => skipAppointmentRecord(tx, orgId, userId, c.req.param("id"))),
    )
  })

  // «Usarla para la corona»: la cita que quedó sin objeto lleva otro tratamiento aceptado (QA del 10 nov, M1).
  app.post("/:id/reuse", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para modificar citas"), 403)
    }
    const parsed = z
      .object({ expectedVersion: z.number().int().min(0), planItemId: z.uuid() })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        reuseAppointment(tx, orgId, userId, c.req.param("id"), parsed.data),
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
        moveAppointment(tx, orgId, userId, c.req.param("id"), parsed.data, { requested: true }),
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
        setAppointmentArrival(tx, orgId, userId, c.req.param("id"), parsed.data.arrived, new Date(), {
          expectedVersion: parsed.data.expectedVersion,
        }),
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
          ...(parsed.data.via ? { via: parsed.data.via } : {}),
          ...(parsed.data.notice === false ? { notice: false } : {}),
          expectedVersion: parsed.data.expectedVersion,
        }),
      ),
    )
  })

  return app
}
