import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { automationJob } from "@odentia/db/schema/automation"
import { encounter } from "@odentia/db/schema/clinical"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  createAppointment,
  createRoom,
  getAppointment,
  markAppointmentCame,
  moveAppointment,
  setAppointmentArrival,
  setAppointmentStatus,
  updateAppointment,
} from "./appointments.js"
import { setProfessionalSchedule } from "./availability.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  createEncounter,
  finalizeEncounter,
  getEncounterClosing,
  getEncounterDetail,
  updateEncounterDraft,
  voidEncounter,
} from "./encounters.js"
import { getAgendaReport } from "./report-agenda.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
import { getWorkspaceHome, type WorkspaceAccess } from "./workspace.js"

/** «Llegó» y «Atender» (ADR 0032): la cita registra la llegada y la atención la cierra. */
setupTestDb()

/**
 * Zona cuyo reloj marca ahora entre las 12:00 y las 12:59: «hoy» no depende de
 * la hora a la que corre la prueba. `Etc/GMT` invierte el signo.
 */
function noonZone(now = new Date()): { zone: string; offsetHours: number } {
  const offsetHours = 12 - now.getUTCHours()
  const zone = offsetHours === 0 ? "Etc/GMT" : offsetHours > 0 ? `Etc/GMT-${offsetHours}` : `Etc/GMT+${-offsetHours}`
  return { zone, offsetHours }
}

async function scene() {
  const f = await clinicalFixture()
  // El borrador del fixture no es de esta visita.
  await f.run((tx) => voidEncounter(tx, ...f.args, f.encounter.id, { reason: "Borrador de prueba" }))
  const { zone, offsetHours } = noonZone()
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede ${randomUUID().slice(0, 6)}`, timezone: zone })
    .returning()
  if (!site) throw new Error("Sin sede")
  const room = await f.run((tx) => createRoom(tx, "org_a", { branchId: site.id, name: "Unidad dental" }))
  await f.run((tx) =>
    setProfessionalSchedule(tx, "org_a", f.actor, {
      branchId: site.id,
      professionalUserId: f.actor,
      rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMin: 0, endMin: 24 * 60 - 1 })),
    }),
  )
  const localToday = new Date(Date.now() + offsetHours * 3_600_000)
  /** Cita a esa hora local, `dayOffset` días desde hoy en la zona de la sede. */
  const book = (dayOffset: number, hour: number, input: { status?: string; reason?: string; minute?: number } = {}) =>
    f.run((tx) =>
      createAppointment(tx, "org_a", f.actor, {
        branchId: site.id,
        patientId: f.patient.id,
        professionalUserId: f.actor,
        roomId: room.id,
        startsAt: new Date(
          Date.UTC(localToday.getUTCFullYear(), localToday.getUTCMonth(), localToday.getUTCDate() + dayOffset, hour, input.minute ?? 0) -
            offsetHours * 3_600_000,
        ).toISOString(),
        durationMin: 30,
        status: input.status ?? "programada",
        reason: input.reason,
        notice: false,
      }),
    )
  return { ...f, site, room, book }
}

it("«Llegó» confirma la cita, cancela sus recordatorios pendientes y «Deshacer» la devuelve como estaba", async () => {
  const f = await scene()
  const visit = await f.book(0, 13)
  const [reminder] = await ownerDb
    .insert(automationJob)
    .values({ organizationId: "org_a", kind: "recordatorio_cita", dedupeKey: randomUUID(), scheduledFor: new Date(), appointmentId: visit.id })
    .returning()

  const arrived = await f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, visit.id, true))
  expect(arrived).toMatchObject({ status: "confirmada", visit: "llego" })
  expect(arrived.arrivedAt).not.toBeNull()
  const [job] = await ownerDb.select().from(automationJob).where(eq(automationJob.id, reminder!.id))
  expect(job?.status).toBe("cancelado")
  // Marcarla otra vez no cambia la hora.
  expect((await f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, visit.id, true))).arrivedAt).toBe(arrived.arrivedAt)

  const undone = await f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, visit.id, false))
  expect(undone).toMatchObject({ status: "programada", visit: "por_confirmar", arrivedAt: null })
  const actions = await ownerDb
    .select({ action: auditEvent.action })
    .from(auditEvent)
    .where(and(eq(auditEvent.entity, "appointment"), eq(auditEvent.entityId, visit.id)))
  expect(actions.map((row) => row.action)).toEqual(expect.arrayContaining(["appointment.arrived", "appointment.arrival_undone"]))
  // Solo una cita de hoy.
  const tomorrow = await f.book(1, 13)
  await expect(f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, tomorrow.id, true))).rejects.toMatchObject({
    code: "APPOINTMENT_NOT_TODAY",
  })
})

it("llega tarde tras «No vino»: la cita se recupera si su hueco sigue libre y, si no, lo dice", async () => {
  const f = await scene()
  const late = await f.book(0, 10)
  await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, late.id, "no_asistio"))
  // Otra persona ocupó el hueco liberado.
  const other = await clinicalFixture()
  const taken = await f.run((tx) =>
    createAppointment(tx, "org_a", f.actor, {
      branchId: f.site.id, patientId: other.patient.id, professionalUserId: f.actor, roomId: f.room.id,
      startsAt: late.startsAt, durationMin: 30, notice: false,
    }),
  )
  await expect(f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, late.id, true))).rejects.toMatchObject({
    code: "APPOINTMENT_CONFLICT",
    message: expect.stringContaining("reagenda"),
  })
  await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, taken.id, "cancelada"))
  const recovered = await f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, late.id, true))
  expect(recovered).toMatchObject({ status: "confirmada", visit: "llego" })
  // Deshacer la deja otra vez como «No vino».
  expect((await f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, late.id, false))).visit).toBe("no_vino")
})

it("con la persona en la clínica no se marca «No vino» ni se cancela, «Atendida» no se pone a mano y mover a otro día borra la llegada", async () => {
  const f = await scene()
  const visit = await f.book(0, 14, { status: "confirmada" })
  await f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, visit.id, true))
  for (const status of ["no_asistio", "cancelada"]) {
    await expect(f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, visit.id, status))).rejects.toMatchObject({
      code: "APPOINTMENT_ARRIVED",
    })
  }
  await expect(f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, visit.id, "atendida"))).rejects.toMatchObject({
    code: "ATTENDED_BY_ENCOUNTER",
  })
  const current = await f.run((tx) => getAppointment(tx, "org_a", visit.id))
  const moved = await f.run((tx) =>
    moveAppointment(tx, "org_a", f.actor, visit.id, {
      expectedVersion: current.version,
      startsAt: new Date(Date.parse(visit.startsAt) + 86_400_000).toISOString(),
    }),
  )
  expect(moved).toMatchObject({ arrivedAt: null, visit: "confirmada" })
})

it("«Atender» desde la cita abre sin pedir motivo, marca la llegada a la hora de empezar y la cita queda atendida al firmar", async () => {
  const f = await scene()
  const visit = await f.book(0, 11, { reason: "Dolor de muela" })
  const opened = await f.run((tx) => createEncounter(tx, ...f.args, { appointmentId: visit.id }))
  // El motivo de la cita es de quien reservó: se ofrece y no cuenta hasta que quien atiende lo usa.
  expect(opened).toMatchObject({ appointmentId: visit.id, reason: null, professionalUserId: f.actor })
  expect((await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, opened.id))).bookedReason).toBe("Dolor de muela")
  const attending = await f.run((tx) => getAppointment(tx, "org_a", visit.id))
  expect(attending).toMatchObject({ status: "confirmada", visit: "en_atencion", encounter: { id: opened.id, status: "borrador" } })
  // La llegada que marca «Atender» es la hora de inicio: esa espera queda sin dato.
  expect(attending.arrivedAt).toBe(opened.startedAt.toISOString())
  await expect(f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, visit.id, false))).rejects.toMatchObject({
    code: "ATTENTION_STARTED",
  })
  await expect(f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, visit.id, "cancelada"))).rejects.toMatchObject({
    code: "APPOINTMENT_IN_ATTENTION",
  })
  await f.run((tx) => updateEncounterDraft(tx, ...f.args, opened.id, { reason: "Dolor de muela" }))
  await f.ready(opened.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, opened.id))
  expect(await f.run((tx) => getAppointment(tx, "org_a", visit.id))).toMatchObject({ status: "atendida", visit: "atendida" })
  await expect(f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, visit.id, "no_asistio"))).rejects.toMatchObject({
    code: "APPOINTMENT_ATTENDED",
  })

  // Sin motivo en la cita, la atención nace sin él y el cierre lo pide.
  const plain = await f.book(0, 15)
  const blank = await f.run((tx) => createEncounter(tx, ...f.args, { appointmentId: plain.id }))
  expect(blank.reason).toBeNull()
  expect((await f.run((tx) => getEncounterClosing(tx, "org_a", f.actor, f.patient.id, blank.id))).missing).toContain("reason")
  await f.run((tx) => voidEncounter(tx, ...f.args, blank.id, { reason: "Prueba" }))
  // Anulada la atención, la llegada sigue (vino) y se puede deshacer. Sin cita
  // también se abre sin motivo (ADR 0098): el cierre lo pide igual.
  expect((await f.run((tx) => getAppointment(tx, "org_a", plain.id))).visit).toBe("llego")
  await f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, plain.id, false))
  await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, plain.id, "cancelada"))
  const walkIn = await f.run((tx) => createEncounter(tx, ...f.args, {}))
  expect(walkIn.reason).toBeNull()
  expect((await f.run((tx) => getEncounterClosing(tx, "org_a", f.actor, f.patient.id, walkIn.id))).missing).toContain("reason")
})

it("dos citas el mismo día: sin indicar cuál, la atención se une a la que llegó", async () => {
  const f = await scene()
  const near = await f.book(0, 12)
  const later = await f.book(0, 17)
  await f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, later.id, true))
  const opened = await f.run((tx) => createEncounter(tx, ...f.args, { reason: "Control" }))
  expect(opened.appointmentId).toBe(later.id)
  expect((await f.run((tx) => getAppointment(tx, "org_a", near.id))).visit).toBe("por_confirmar")
})

it("«Espera en sala» mide de la llegada al inicio de la atención, por profesional, y sin llegadas dice que no hay datos", async () => {
  const f = await scene()
  // Ayer y hoy en la clínica, no «este mes»: la cita es de hace unas horas y en las primeras horas del mes cae en el anterior.
  const clinicDay = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(at)
  const query = { period: `${clinicDay(Date.now() - 86_400_000)}..${clinicDay(Date.now())}`, branchId: f.site.id }
  const report = () => withOrgContext(appDb, "org_a", (tx) => getAgendaReport(tx, "org_a", query))
  expect((await report()).waitInRoom).toEqual({ medianMinutes: null, measured: 0 })

  const waited = await f.book(0, 9)
  await f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, waited.id, true))
  await ownerDb.update(appointment).set({ arrivedAt: sql`now() - interval '12 minutes'` }).where(eq(appointment.id, waited.id))
  const first = await f.run((tx) => createEncounter(tx, ...f.args, { appointmentId: waited.id }))
  await f.run((tx) => voidEncounter(tx, ...f.args, first.id, { reason: "Para la siguiente" }))
  // La atención se anuló: esa espera ya no cuenta.
  expect((await report()).waitInRoom.measured).toBe(0)
  await f.run((tx) => createEncounter(tx, ...f.args, { appointmentId: waited.id }))
  // Nadie marcó la llegada: «Atender» la anota a la misma hora y no se mide.
  const unmarked = await clinicalFixture()
  await unmarked.run((tx) => voidEncounter(tx, ...unmarked.args, unmarked.encounter.id, { reason: "Prueba" }))
  const walkIn = await unmarked.run((tx) =>
    createAppointment(tx, "org_a", f.actor, {
      branchId: f.site.id, patientId: unmarked.patient.id, professionalUserId: f.actor, roomId: f.room.id,
      startsAt: new Date(Date.parse(waited.startsAt) + 3 * 3_600_000).toISOString(), durationMin: 30, notice: false,
    }),
  )
  await f.run((tx) => createEncounter(tx, "org_a", f.actor, unmarked.patient.id, { appointmentId: walkIn.id }))

  const agenda = await report()
  const wait = agenda.waitInRoom
  expect(wait.measured).toBe(1)
  expect(wait.medianMinutes).toBeGreaterThanOrEqual(11)
  expect(wait.medianMinutes).toBeLessThanOrEqual(13)
  // La de cada profesional va en su fila.
  expect(agenda.professionals.find((row) => row.userId === f.actor)).toMatchObject({ name: "Clínico", waitMinutes: wait.medianMinutes })
})

it("Inicio: la dueña que atiende ve «Mis pacientes de hoy» con la sala, y su atención de ayer sin cerrar espera en «Te espera»", async () => {
  const f = await scene()
  const owner: WorkspaceAccess = {
    patients: true, appointments: true, conversations: false, tasks: false, finance: false, clinical: true,
    crm: false, agent: false, allTasks: false, configure: false, ownAppointments: false, attends: true,
  }
  const home = (access: WorkspaceAccess) =>
    withOrgContext(appDb, "org_a", (tx) => getWorkspaceHome(tx, "org_a", f.actor, access, { branchId: f.site.id }))

  // Una atención de hace dos días que sigue en borrador le sale a quien la lleva, con lo que le falta.
  const stale = await f.run((tx) => createEncounter(tx, ...f.args, { reason: "Control" }))
  expect(stale.appointmentId).toBeNull()
  await ownerDb
    .update(encounter)
    .set({ startedAt: new Date(Date.now() - 2 * 86_400_000), createdAt: new Date(Date.now() - 2 * 86_400_000) })
    .where(eq(encounter.id, stale.id))
  const staleRows = (await home(owner)).waiting.filter((row) => row.kind === "staleEncounter")
  expect(staleRows).toEqual([
    expect.objectContaining({ id: stale.id, patientId: f.patient.id, missing: ["diagnosis", "evolution"] }),
  ])
  // Quien no atiende no la recibe.
  expect((await home({ ...owner, attends: false })).waiting.some((row) => row.kind === "staleEncounter")).toBe(false)

  // Las citas de hoy, cerca de la hora actual: son de hoy también en la zona de la clínica.
  const waiting = await f.book(0, 12, { status: "confirmada" })
  const later = await f.book(0, 12, { status: "confirmada", minute: 30 })
  await f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, waiting.id, true))

  const mine = await home(owner)
  expect(mine.today?.scope).toBe("mine")
  const rows = mine.today!.appointments.filter((row) => row.id === waiting.id || row.id === later.id)
  expect(rows.map((row) => [row.id, row.visit])).toEqual([[waiting.id, "llego"], [later.id, "confirmada"]])
  // La agenda de la sede le queda en una línea.
  expect(mine.agendaLine).toMatchObject({ branch: { id: f.site.id }, summary: { waiting: 1 } })
  // Sin citas propias hoy, quien dirige sigue viendo la agenda de la sede.
  const colleague = randomUUID()
  const other = await withOrgContext(appDb, "org_a", (tx) => getWorkspaceHome(tx, "org_a", colleague, owner, { branchId: f.site.id }))
  expect(other.today?.scope).toBe("branch")
  expect(other.today!.appointments.map((row) => row.id)).toContain(waiting.id)
})

it("mover una cita: solo la programada o confirmada y sin atención; lo atendido o cancelado ya no se mueve", async () => {
  const f = await scene()
  const nextDay = (iso: string) => new Date(Date.parse(iso) + 86_400_000).toISOString()
  const visit = await f.book(1, 10)
  await f.run((tx) => createEncounter(tx, ...f.args, { appointmentId: visit.id }))
  const attending = await f.run((tx) => getAppointment(tx, "org_a", visit.id))
  await expect(
    f.run((tx) => moveAppointment(tx, "org_a", f.actor, visit.id, { expectedVersion: attending.version, startsAt: nextDay(visit.startsAt) })),
  ).rejects.toMatchObject({ code: "APPOINTMENT_IN_ATTENTION" })

  const cancelled = await f.book(2, 9)
  await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, cancelled.id, "cancelada", { cancelReason: "paciente" }))
  const after = await f.run((tx) => getAppointment(tx, "org_a", cancelled.id))
  await expect(
    f.run((tx) => moveAppointment(tx, "org_a", f.actor, cancelled.id, { expectedVersion: after.version, startsAt: nextDay(cancelled.startsAt) })),
  ).rejects.toMatchObject({ code: "APPOINTMENT_STATUS" })
})

// ----- Las reglas del estado y del reloj viven en la operación (QA del 10 nov, C3, C4, C5 y C33) -----

/** Lleva la cita a hace `minutes` minutos, como si su hora ya hubiera pasado. */
async function startedAgo(id: string, minutes: number) {
  const startsAt = new Date(Date.now() - minutes * 60_000)
  await ownerDb.update(appointment).set({ startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) }).where(eq(appointment.id, id))
}

it("el estado no vuelve atrás: de «Cancelada» y de «No vino» no se sale por el cambio de estado", async () => {
  const f = await scene()
  const cancelled = await f.book(1, 9)
  await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, cancelled.id, "cancelada", { notice: false }))
  for (const next of ["confirmada", "programada", "no_asistio"])
    await expect(f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, cancelled.id, next))).rejects.toMatchObject({ code: "APPOINTMENT_CANCELLED", status: 409 })
  // Repetir lo mismo no es un error: ya estaba así.
  expect((await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, cancelled.id, "cancelada"))).status).toBe("cancelada")

  const missed = await f.book(1, 10)
  await startedAgo(missed.id, 90)
  await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, missed.id, "no_asistio"))
  for (const next of ["confirmada", "programada", "cancelada"])
    await expect(f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, missed.id, next))).rejects.toMatchObject({ code: "APPOINTMENT_NO_SHOW", status: 409 })

  // Una confirmada tampoco vuelve a «por confirmar».
  const confirmed = await f.book(1, 11, { status: "confirmada" })
  await expect(f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, confirmed.id, "programada"))).rejects.toMatchObject({ code: "APPOINTMENT_STATUS" })
})

it("«No vino» se marca cuando su hora ya llegó: antes se rechaza y la cita sigue en pie", async () => {
  const f = await scene()
  const tomorrow = await f.book(1, 9)
  await expect(f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, tomorrow.id, "no_asistio"))).rejects.toMatchObject({ code: "APPOINTMENT_NOT_YET", status: 409 })
  expect((await f.run((tx) => getAppointment(tx, "org_a", tomorrow.id))).status).toBe("programada")
  await startedAgo(tomorrow.id, 5)
  expect((await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, tomorrow.id, "no_asistio"))).status).toBe("no_asistio")
})

it("el botón de una pantalla abierta antes del cambio no se aplica: confirmar, «No vino», «Llegó» y «Vino» miran la versión", async () => {
  const f = await scene()
  const visit = await f.book(0, 13)
  await startedAgo(visit.id, 10)
  // Otra persona la alarga: la versión sube.
  const fresh = await f.run((tx) => getAppointment(tx, "org_a", visit.id))
  const edited = await f.run((tx) => updateAppointment(tx, "org_a", f.actor, visit.id, { expectedVersion: fresh.version, reason: "Control" }))
  expect(edited.version).toBe(fresh.version + 1)
  const stale = { code: "STALE_VERSION", status: 409 }
  await expect(f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, visit.id, "confirmada", { expectedVersion: fresh.version }))).rejects.toMatchObject(stale)
  await expect(f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, visit.id, "no_asistio", { expectedVersion: fresh.version }))).rejects.toMatchObject(stale)
  await expect(f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, visit.id, true, new Date(), fresh.version))).rejects.toMatchObject(stale)
  await expect(f.run((tx) => markAppointmentCame(tx, "org_a", f.actor, visit.id, fresh.version))).rejects.toMatchObject(stale)
  expect(await f.run((tx) => getAppointment(tx, "org_a", visit.id))).toMatchObject({ status: "programada", arrivedAt: null, version: edited.version })
  // Con la versión que se ve, sí; y quien no la manda (el agente, el enlace) actúa sobre la cita de ahora.
  expect((await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, visit.id, "confirmada", { expectedVersion: edited.version }))).status).toBe("confirmada")
  expect((await f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, visit.id, true))).visit).toBe("llego")
})

it("quien pide mover una cita no la lleva a una hora que ya pasó; alargarla sin tocar su hora sí vale", async () => {
  const f = await scene()
  const visit = await f.book(1, 9)
  const yesterday = new Date(Date.now() - 24 * 3_600_000).toISOString()
  await expect(
    f.run((tx) => moveAppointment(tx, "org_a", f.actor, visit.id, { expectedVersion: visit.version, startsAt: yesterday }, { requested: true })),
  ).rejects.toMatchObject({ code: "VALIDATION", fields: { startsAt: expect.stringContaining("ya pasó") } })
  expect((await f.run((tx) => getAppointment(tx, "org_a", visit.id))).startsAt).toBe(visit.startsAt)
  // Una cita no dura más de ocho horas, se diga con minutos o con su hora de fin.
  await expect(
    f.run((tx) => moveAppointment(tx, "org_a", f.actor, visit.id, { expectedVersion: visit.version, startsAt: visit.startsAt, endsAt: new Date(new Date(visit.startsAt).getTime() + 3 * 24 * 3_600_000).toISOString() }, { requested: true })),
  ).rejects.toMatchObject({ code: "VALIDATION", fields: { endsAt: expect.stringContaining("8 horas") } })
  // Ya empezó y se alarga un cuarto de hora: su hora de inicio no cambia.
  await startedAgo(visit.id, 10)
  const started = await f.run((tx) => getAppointment(tx, "org_a", visit.id))
  const longer = await f.run((tx) =>
    moveAppointment(tx, "org_a", f.actor, visit.id, { expectedVersion: started.version, startsAt: started.startsAt, endsAt: new Date(new Date(started.startsAt).getTime() + 45 * 60_000).toISOString() }, { requested: true }),
  )
  expect(longer.durationMin).toBe(45)
})

it("los detalles de una cita que ya no está en pie no se reescriben, y editar deja dicho qué cambió", async () => {
  const f = await scene()
  const visit = await f.book(1, 9, { reason: "Dolor" })
  const edited = await f.run((tx) => updateAppointment(tx, "org_a", f.actor, visit.id, { expectedVersion: visit.version, reason: "Dolor de muela" }))
  const [event] = await ownerDb
    .select({ metadata: auditEvent.metadata })
    .from(auditEvent)
    .where(and(eq(auditEvent.entityId, visit.id), eq(auditEvent.action, "appointment.updated")))
  expect(event?.metadata).toMatchObject({ changed: ["reason"] })
  await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, visit.id, "cancelada", { notice: false }))
  const cancelled = await f.run((tx) => getAppointment(tx, "org_a", visit.id))
  await expect(
    f.run((tx) => updateAppointment(tx, "org_a", f.actor, visit.id, { expectedVersion: cancelled.version, reason: "Otro motivo" })),
  ).rejects.toMatchObject({ code: "APPOINTMENT_STATUS", status: 409 })
  expect((await f.run((tx) => getAppointment(tx, "org_a", visit.id))).reason).toBe(edited.reason)
})
