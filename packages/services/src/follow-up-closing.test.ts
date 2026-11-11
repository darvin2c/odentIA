import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { clinicalFollowUp, encounter, encounterProcedure } from "@odentia/db/schema/clinical"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { setAppointmentArrival, setAppointmentStatus } from "./appointments.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { finalizeEncounter, getEncounterClosing } from "./encounters.js"
import { createFollowUp, listFollowUps, scheduleFollowUp } from "./follow-ups.js"
import { findOrgLocale } from "./locale.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { dayKeyIn } from "./to-schedule.js"

/**
 * El control se pide al firmar y se cumple con la visita que toca (ADR 0152):
 * «¿Cuándo vuelve?», los controles que la ventana deja cumplir, el reservado
 * en la cita que se atiende y lo que suelta una cita cancelada o a la que no vino.
 */
setupTestDb()

const DAY = 86_400_000

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Otra atención de la persona: firmada (de antes) o en borrador (la de hoy). */
async function visit(f: Fixture, status: "borrador" | "finalizada", professionalUserId = f.actor) {
  const [row] = await ownerDb
    .insert(encounter)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      professionalUserId,
      reason: "Consulta",
      ...(status === "finalizada"
        ? { status, finalizedAt: new Date(), signerName: "Clínico", signerRegistration: "COP 12345" }
        : {}),
    })
    .returning()
  return row!
}

/** Un control indicado hace `createdDaysAgo` días para dentro de `dueInDays` (negativo: ya pasó). */
async function control(
  f: Fixture,
  createdDaysAgo: number,
  dueInDays: number,
  values: Partial<typeof clinicalFollowUp.$inferInsert> = {},
) {
  const [row] = await ownerDb
    .insert(clinicalFollowUp)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      kind: "mantenimiento",
      title: "Control de mantenimiento",
      createdAt: new Date(Date.now() - createdDaysAgo * DAY),
      dueAt: new Date(Date.now() + dueInDays * DAY),
      ...values,
    })
    .returning()
  return row!
}

it("«¿Cuándo vuelve?» al firmar indica el control con el tipo y el título del sistema, y no lo duplica", async () => {
  const f = await clinicalFixture()
  await f.ready(f.encounter.id)
  const { timezone } = await f.run((tx) => findOrgLocale(tx, "org_a"))
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(closing.controls).toMatchObject({ recallMonths: 6, due: [], next: null })
  // Un día que ya pasó no es «cuándo vuelve».
  await expect(
    f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, { nextControl: { dueAt: dayKeyIn(new Date(), timezone) } })),
  ).rejects.toMatchObject({ fields: { "nextControl.dueAt": expect.any(String) } })

  // «En 6 meses»: de mantenimiento, en el día civil del atajo en la zona de la clínica.
  const signed = await f.run((tx) =>
    finalizeEncounter(tx, ...f.args, f.encounter.id, { nextControl: { dueAt: closing.controls.shortcuts.recall } }),
  )
  expect(signed.controls.next).toMatchObject({ title: "Control de mantenimiento" })
  const [indicated] = await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id))
  expect(indicated).toMatchObject({
    kind: "mantenimiento",
    title: "Control de mantenimiento",
    status: "pendiente",
    originEncounterId: f.encounter.id,
  })
  expect(dayKeyIn(indicated!.dueAt, timezone)).toBe(closing.controls.shortcuts.recall)
  const [finalized] = await ownerDb
    .select({ metadata: auditEvent.metadata })
    .from(auditEvent)
    .where(and(eq(auditEvent.entityId, f.encounter.id), eq(auditEvent.action, "encounter.finalized")))
  expect(finalized?.metadata).toMatchObject({ nextControl: "fecha" })

  // La siguiente atención ya lo ve: no se pregunta, y si llega un día no se crea otro.
  const today = await visit(f, "borrador")
  await f.ready(today.id)
  const again = await f.run((tx) => getEncounterClosing(tx, ...f.args, today.id))
  expect(again.controls).toMatchObject({ due: [], next: { id: indicated!.id, own: false } })
  const second = await f.run((tx) =>
    finalizeEncounter(tx, ...f.args, today.id, { nextControl: { dueAt: again.controls.shortcuts.week } }),
  )
  expect(second.controls.next).toBeNull()
  expect(await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id))).toHaveLength(1)
})

it("con 1 semana y un procedimiento de hoy, el control lleva su nombre; «No hace falta» queda anotado", async () => {
  const f = await clinicalFixture()
  await f.ready(f.encounter.id)
  await ownerDb
    .insert(encounterProcedure)
    .values({ organizationId: "org_a", encounterId: f.encounter.id, description: "Resina simple", createdBy: f.actor })
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, { nextControl: { dueAt: closing.controls.shortcuts.week } }))
  expect(await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id))).toMatchObject([
    { kind: "mantenimiento", title: "Control de resina simple" },
  ])

  const other = await clinicalFixture()
  await other.ready(other.encounter.id)
  await other.run((tx) => finalizeEncounter(tx, ...other.args, other.encounter.id, { nextControl: { none: true } }))
  expect(await other.run((tx) => listFollowUps(tx, "org_a", other.patient.id))).toEqual([])
  const [finalized] = await ownerDb
    .select({ metadata: auditEvent.metadata })
    .from(auditEvent)
    .where(and(eq(auditEvent.entityId, other.encounter.id), eq(auditEvent.action, "encounter.finalized")))
  expect(finalized?.metadata).toMatchObject({ nextControl: "no_hace_falta" })
})

it("el cierre ofrece los controles de su ventana y cumple los marcados; el que se repite deja el siguiente", async () => {
  const f = await clinicalFixture()
  const before = await visit(f, "finalizada")
  const colleague = await visit(f, "finalizada", (await clinicalFixture()).actor)
  // A 6 meses, indicado hace 150 días por quien firma: su ventana abrió unos 45 días antes de su día.
  const mine = await control(f, 150, 30, { originEncounterId: before.id })
  // Olvidado hace dos años: la ventana no se cierra.
  const forgotten = await control(f, 900, -700, { originEncounterId: colleague.id, title: "Control de ortodoncia" })
  // A un mes, indicado ayer: aún no toca.
  const later = await control(f, 1, 30, { title: "Control de resina" })
  // Indicado en esta misma atención: no se cumple con ella.
  await control(f, 0, 3, { originEncounterId: f.encounter.id, title: "Control propio" })
  await f.ready(f.encounter.id)
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(closing.controls.due.map((due) => [due.id, due.mine])).toEqual([
    [forgotten.id, false],
    [mine.id, true],
  ])
  expect(closing.controls.next).toMatchObject({ title: "Control propio", own: true })

  // El colega no lo marcó y queda pendiente; el de quien firma, sí.
  const signed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, { followUpIds: [mine.id] }))
  expect(signed.controls.fulfilled).toEqual([{ id: mine.id, title: mine.title }])
  const byId = new Map((await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id))).map((row) => [row.id, row]))
  expect(byId.get(mine.id)).toMatchObject({ status: "realizado", completedEncounterId: f.encounter.id })
  expect(byId.get(forgotten.id)?.status).toBe("pendiente")
  expect(byId.get(later.id)?.status).toBe("pendiente")
  const [completed] = await ownerDb
    .select({ metadata: auditEvent.metadata })
    .from(auditEvent)
    .where(and(eq(auditEvent.entityId, mine.id), eq(auditEvent.action, "follow_up.completed")))
  expect(completed?.metadata).toMatchObject({ by: "ventana", encounterId: f.encounter.id })

  // Sin `followUpIds` (API sin pantalla) cumple solo los de quien firma, como vienen marcados. El que se
  // repite no deja otro mientras la persona tenga otro control abierto: la firma nunca deja dos.
  const repeating = await control(f, 100, 1, { originEncounterId: before.id, repeatEveryMonths: 6, title: "Control de presión" })
  const next = await visit(f, "borrador")
  await f.ready(next.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, next.id, {}))
  const rows = await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id))
  expect(rows.find((row) => row.id === forgotten.id)?.status).toBe("pendiente")
  expect(rows.find((row) => row.id === repeating.id)?.status).toBe("realizado")
  expect(rows.find((row) => row.repeatsFromId === repeating.id)).toBeUndefined()
})

it("un control indicado hoy no se cumple hoy, aunque su ventana ya abra", async () => {
  const f = await clinicalFixture()
  // Fuera de la atención, para mañana: su ventana (2 días antes) empezaría ayer, pero nace hoy.
  await f.run((tx) =>
    createFollowUp(tx, ...f.args, { kind: "mantenimiento", title: "Control", dueAt: new Date(Date.now() + DAY).toISOString() }),
  )
  await f.ready(f.encounter.id)
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(closing.controls.due).toEqual([])
  expect(closing.controls.next).toMatchObject({ title: "Control" })
})

it("un control vencido de un colega sin marcar no frena «¿Cuándo vuelve?»; uno propio sin marcar, sí", async () => {
  const f = await clinicalFixture()
  const colleague = await visit(f, "finalizada", (await clinicalFixture()).actor)
  await control(f, 400, -200, { originEncounterId: colleague.id, title: "Control de ortodoncia" })
  await f.ready(f.encounter.id)
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(closing.controls.due).toMatchObject([{ mine: false }])
  const signed = await f.run((tx) =>
    finalizeEncounter(tx, ...f.args, f.encounter.id, { followUpIds: [], nextControl: { dueAt: closing.controls.shortcuts.recall } }),
  )
  expect(signed.controls.next).toMatchObject({ title: "Control de mantenimiento" })

  const own = await clinicalFixture()
  const before = await visit(own, "finalizada")
  await control(own, 150, 30, { originEncounterId: before.id })
  await own.ready(own.encounter.id)
  const ownClosing = await own.run((tx) => getEncounterClosing(tx, ...own.args, own.encounter.id))
  const kept = await own.run((tx) =>
    finalizeEncounter(tx, ...own.args, own.encounter.id, { followUpIds: [], nextControl: { dueAt: ownClosing.controls.shortcuts.week } }),
  )
  // Dejó sin marcar el suyo: sigue pendiente y no nace otro.
  expect(kept.controls.next).toBeNull()
  expect(await own.run((tx) => listFollowUps(tx, "org_a", own.patient.id))).toHaveLength(1)
})

/** Una sede, una unidad y una cita de la persona a `days` días (0: ahora). */
async function agenda(f: Fixture) {
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: "Sede control", timezone: "America/Lima" })
    .returning()
  const [room] = await ownerDb
    .insert(scheduleRoom)
    .values({ organizationId: "org_a", branchId: site!.id, name: "Unidad" })
    .returning()
  return async (days: number) => {
    const startsAt = new Date(Date.now() + days * DAY)
    const [row] = await ownerDb
      .insert(appointment)
      .values({
        organizationId: "org_a",
        branchId: site!.id,
        patientId: f.patient.id,
        professionalUserId: f.actor,
        roomId: room!.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        durationMin: 30,
      })
      .returning()
    return row!.id
  }
}

it("el control reservado en la cita que se atiende se cumple con ella y se pregunta cuándo vuelve", async () => {
  for (const repeatEveryMonths of [null, 6]) {
    const f = await clinicalFixture()
    const book = await agenda(f)
    const today = await book(0)
    // «Programar control»: el control queda en la cita de hoy.
    const reserved = await control(f, 30, 0, { repeatEveryMonths })
    await f.run((tx) => scheduleFollowUp(tx, ...f.args, reserved.id, { appointmentId: today }))
    // «Atender» desde esa cita: la atención en curso queda unida a ella.
    await ownerDb.update(encounter).set({ appointmentId: today }).where(eq(encounter.id, f.encounter.id))
    const attending = f.encounter
    await f.ready(attending.id)
    const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, attending.id))
    // No es «el próximo»: lo cumple esta firma.
    expect(closing.controls.next).toBeNull()
    expect(closing.controls.byAppointment).toEqual([{ id: reserved.id, title: reserved.title, repeatEveryMonths, byName: null }])
    const signed = await f.run((tx) =>
      finalizeEncounter(tx, ...f.args, attending.id, { followUpIds: [], nextControl: { dueAt: closing.controls.shortcuts.recall } }),
    )
    const rows = await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id))
    expect(rows.find((row) => row.id === reserved.id)?.status).toBe("realizado")
    const open = rows.filter((row) => row.status === "pendiente")
    // Uno solo abierto: el de «¿Cuándo vuelve?» o, si se repite, el siguiente de la serie.
    expect(open).toHaveLength(1)
    if (repeatEveryMonths) {
      expect(signed.controls.next).toBeNull()
      expect(open[0]?.repeatsFromId).toBe(reserved.id)
    } else {
      expect(signed.controls.next).toMatchObject({ title: "Control de mantenimiento" })
      expect(open[0]?.id).toBe(signed.controls.next?.id)
    }
  }
})

it("«No vino» y después «Llegó» el mismo día vuelve a unir el control a su cita", async () => {
  const f = await clinicalFixture()
  const book = await agenda(f)
  const today = await book(0)
  const reserved = await control(f, 30, 0)
  await f.run((tx) => scheduleFollowUp(tx, ...f.args, reserved.id, { appointmentId: today }))
  await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, today, "no_asistio"))
  expect((await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id)))[0]).toMatchObject({ status: "pendiente", appointmentId: null })
  await f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, today, true))
  expect((await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id)))[0]).toMatchObject({ status: "programado", appointmentId: today })
  // Deshacer la llegada la deja otra vez en «No vino»: el control se suelta de nuevo.
  await f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, today, false))
  expect((await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id)))[0]).toMatchObject({ status: "pendiente", appointmentId: null })
})


it("cancelar la cita del control o marcar «No vino» lo devuelve a pendiente y suelta la cita", async () => {
  const f = await clinicalFixture()
  const book = await agenda(f)
  const reserved = await control(f, 10, 20)
  for (const [status, by] of [
    ["cancelada", "cita_cancelada"],
    ["no_asistio", "no_vino"],
  ] as const) {
    const id = await book(status === "cancelada" ? 20 : 21)
    await f.run((tx) => scheduleFollowUp(tx, ...f.args, reserved.id, { appointmentId: id }))
    if (status === "no_asistio") {
      // «No vino» se marca cuando su hora ya llegó: antes se rechaza y la cita sigue como estaba.
      await expect(f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, id, status))).rejects.toMatchObject({ code: "APPOINTMENT_NOT_YET" })
      const hourAgo = new Date(Date.now() - 60 * 60_000)
      await ownerDb.update(appointment).set({ startsAt: hourAgo, endsAt: new Date(hourAgo.getTime() + 30 * 60_000) }).where(eq(appointment.id, id))
    }
    await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, id, status))
    const [row] = await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id))
    expect(row).toMatchObject({ id: reserved.id, status: "pendiente", appointmentId: null, scheduledAt: null })
    const [released] = await ownerDb
      .select({ metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(and(eq(auditEvent.entityId, reserved.id), eq(auditEvent.action, "follow_up.unscheduled")))
      .orderBy(auditEvent.createdAt)
      .limit(1)
      .offset(status === "cancelada" ? 0 : 1)
    expect(released?.metadata).toMatchObject({ appointmentId: id, by })
  }
})
