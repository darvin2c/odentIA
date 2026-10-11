import { withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { patient, serviceCatalog } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { sql } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import {
  bookWaitlistEntry,
  createAppointment,
  createChair,
  listAppointments,
  listScheduleResources,
  moveAppointment,
  searchAgendaPatients,
  setAppointmentStatus,
  setBranchDefaultDuration,
  updateAppointment,
} from "./appointments.js"
import {
  addWaitlistEntry,
  createScheduleBlock,
  getAgendaAvailability,
  listAvailableSlots,
  offerWaitlistSlot,
  setProfessionalSchedule,
} from "./availability.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ORG = "org_agenda_svc"
const ACTOR = "agenda-actor"
const DENTIST = "agenda-dentist"
const DENTIST_2 = "agenda-dentist-2"

let branchId: string
let chairId: string
let chair2Id: string
let patientId: string
let serviceId: string

// 2026-10-05 America/Lima (UTC-5): 09:00–09:45 local.
const START = "2026-10-05T14:00:00Z"
const NEXT = "2026-10-05T14:45:00Z"
const NEXT_END = "2026-10-05T15:30:00Z"
const OVERLAP = "2026-10-05T14:30:00Z"
const OVERLAP_END = "2026-10-05T15:15:00Z"
const FROM = "2026-10-05T05:00:00Z"
const TO = "2026-10-06T05:00:00Z"

beforeAll(async () => {
  await ownerDb.execute(sql`
    insert into "organization" ("id", "name", "slug", "created_at")
    values (${ORG}, 'Clínica Agenda Svc', 'agenda-svc', now())
    on conflict do nothing`)
  const [createdBranch] = await ownerDb
    .insert(branch)
    .values({ organizationId: ORG, name: "Sede Agenda", timezone: "America/Lima" })
    .returning({ id: branch.id })
  branchId = createdBranch!.id
  await ownerDb.insert(user).values([
    { id: ACTOR, name: "Recepción Agenda", email: "agenda-actor@example.test" },
    { id: DENTIST, name: "Dra. Agenda Uno", email: "agenda-dentist@example.test" },
    { id: DENTIST_2, name: "Dr. Agenda Dos", email: "agenda-dentist-2@example.test" },
  ])
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      ('m-agenda-actor', ${ORG}, ${ACTOR}, 'owner', now()),
      ('m-agenda-dentist', ${ORG}, ${DENTIST}, 'member', now()),
      ('m-agenda-dentist-2', ${ORG}, ${DENTIST_2}, 'member', now())`)
  const [createdPatient] = await ownerDb
    .insert(patient)
    .values({ organizationId: ORG, displayName: "Paciente Agenda", patientNumber: 9101 })
    .returning({ id: patient.id })
  patientId = createdPatient!.id
  const [service] = await ownerDb
    .insert(serviceCatalog)
    .values({
      organizationId: ORG,
      name: "Limpieza Agenda",
      source: "custom",
      priceCents: 9000,
      currency: "PEN",
      durationMin: 45,
    })
    .returning({ id: serviceCatalog.id })
  serviceId = service!.id
  const [chair, chair2] = await withOrgContext(appDb, ORG, async (tx) => [
    await createChair(tx, ORG, { branchId, name: "Sillón Uno" }),
    await createChair(tx, ORG, { branchId, name: "Sillón Dos" }),
  ])
  chairId = chair!.id
  chair2Id = chair2!.id
  // Horario explícito Lun–Vie 09:00–13:00 y 14:00–18:00 (hora Lima): las citas
  // de prueba caen lunes a jueves por la mañana.
  const rules = [1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, startMin: 9 * 60, endMin: 13 * 60 },
    { weekday, startMin: 14 * 60, endMin: 18 * 60 },
  ])
  await withOrgContext(appDb, ORG, async (tx) => {
    await setProfessionalSchedule(tx, ORG, ACTOR, {
      branchId,
      dentistUserId: DENTIST,
      rules,
    })
    await setProfessionalSchedule(tx, ORG, ACTOR, {
      branchId,
      dentistUserId: DENTIST_2,
      rules,
    })
  })
}, 180_000)

const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, ORG, fn)

it("crea una cita con duración del servicio y la lista con nombres resueltos", async () => {
  const created = await run((tx) =>
    createAppointment(tx, ORG, ACTOR, {
      patientId,
      dentistUserId: DENTIST,
      chairId,
      serviceId,
      startsAt: START,
      reason: "Dolor de muela",
    }),
  )
  expect(created.serviceName).toBe("Limpieza Agenda")
  expect(created.endsAt).toBe("2026-10-05T14:45:00.000Z")
  expect(created.status).toBe("programada")

  const list = await run((tx) => listAppointments(tx, ORG, { from: FROM, to: TO }))
  const found = list.find((item) => item.id === created.id)
  expect(found).toMatchObject({
    patientName: "Paciente Agenda",
    dentistName: "Dra. Agenda Uno",
    chairName: "Sillón Uno",
  })

  const own = await run((tx) => listAppointments(tx, ORG, { from: FROM, to: TO, patientId }))
  expect(own.map((item) => item.id)).toContain(created.id)
  const other = await run((tx) =>
    listAppointments(tx, ORG, {
      from: FROM,
      to: TO,
      patientId: "00000000-0000-4000-8000-000000000000",
    }),
  )
  expect(other).toEqual([])
})

it("rechaza profesional ajeno, paciente ajeno y sillón inexistente", async () => {
  await expect(
    run((tx) =>
      createAppointment(tx, ORG, ACTOR, {
        patientId,
        dentistUserId: "no-es-miembro",
        chairId,
        startsAt: "2026-10-06T14:00:00Z",
        durationMin: 30,
      }),
    ),
  ).rejects.toMatchObject({ status: 404 })
  await expect(
    run((tx) =>
      createAppointment(tx, ORG, ACTOR, {
        patientId: "00000000-0000-4000-8000-000000000000",
        dentistUserId: DENTIST,
        chairId,
        startsAt: "2026-10-06T14:00:00Z",
        durationMin: 30,
      }),
    ),
  ).rejects.toMatchObject({ status: 404 })
  await expect(
    run((tx) =>
      createAppointment(tx, ORG, ACTOR, {
        patientId,
        dentistUserId: DENTIST,
        chairId: "00000000-0000-4000-8000-000000000000",
        startsAt: "2026-10-06T14:00:00Z",
        durationMin: 30,
      }),
    ),
  ).rejects.toMatchObject({ status: 404 })
})

it("la doble reserva del mismo sillón o profesional responde 409 APPOINTMENT_CONFLICT", async () => {
  await expect(
    run((tx) =>
      createAppointment(tx, ORG, ACTOR, {
        patientId,
        dentistUserId: DENTIST_2,
        chairId,
        startsAt: OVERLAP,
        endsAt: OVERLAP_END,
      }),
    ),
  ).rejects.toMatchObject({ code: "APPOINTMENT_CONFLICT", status: 409 })
  await expect(
    run((tx) =>
      createAppointment(tx, ORG, ACTOR, {
        patientId,
        dentistUserId: DENTIST,
        chairId: chair2Id,
        startsAt: OVERLAP,
        endsAt: OVERLAP_END,
      }),
    ),
  ).rejects.toMatchObject({ code: "APPOINTMENT_CONFLICT", status: 409 })
  // Contigua: permitida.
  const contiguous = await run((tx) =>
    createAppointment(tx, ORG, ACTOR, {
      patientId,
      dentistUserId: DENTIST,
      chairId,
      startsAt: NEXT,
      endsAt: NEXT_END,
    }),
  )
  expect(contiguous.startsAt).toBe(new Date(NEXT).toISOString())
})

it("mover a un hueco libre sube la versión; versión vieja da STALE_VERSION", async () => {
  const created = await run((tx) =>
    createAppointment(tx, ORG, ACTOR, {
      patientId,
      dentistUserId: DENTIST_2,
      chairId: chair2Id,
      startsAt: "2026-10-06T15:00:00Z",
      endsAt: "2026-10-06T15:30:00Z",
    }),
  )
  const moved = await run((tx) =>
    moveAppointment(tx, ORG, ACTOR, created.id, {
      expectedVersion: created.version,
      startsAt: "2026-10-06T16:00:00Z",
    }),
  )
  expect(moved.version).toBe(created.version + 1)
  expect(moved.endsAt).toBe("2026-10-06T16:30:00.000Z")
  await expect(
    run((tx) =>
      moveAppointment(tx, ORG, ACTOR, created.id, {
        expectedVersion: created.version,
        startsAt: "2026-10-06T17:00:00Z",
      }),
    ),
  ).rejects.toMatchObject({ code: "STALE_VERSION", status: 409 })
})

it("mover sobre un hueco ocupado da APPOINTMENT_CONFLICT", async () => {
  const created = await run((tx) =>
    createAppointment(tx, ORG, ACTOR, {
      patientId,
      dentistUserId: DENTIST_2,
      chairId: chair2Id,
      startsAt: "2026-10-07T15:00:00Z",
      endsAt: "2026-10-07T15:30:00Z",
    }),
  )
  await expect(
    run((tx) =>
      moveAppointment(tx, ORG, ACTOR, created.id, {
        expectedVersion: created.version,
        startsAt: OVERLAP,
        endsAt: OVERLAP_END,
        chairId,
      }),
    ),
  ).rejects.toMatchObject({ code: "APPOINTMENT_CONFLICT", status: 409 })
})

it("editar congela el nuevo servicio y cancelar libera el recurso", async () => {
  const created = await run((tx) =>
    createAppointment(tx, ORG, ACTOR, {
      patientId,
      dentistUserId: DENTIST,
      chairId,
      startsAt: "2026-10-08T15:00:00Z",
      endsAt: "2026-10-08T15:30:00Z",
    }),
  )
  const edited = await run((tx) =>
    updateAppointment(tx, ORG, ACTOR, created.id, {
      expectedVersion: created.version,
      serviceId,
      reason: "Control",
    }),
  )
  expect(edited.serviceName).toBe("Limpieza Agenda")
  expect(edited.reason).toBe("Control")

  const cancelled = await run((tx) => setAppointmentStatus(tx, ORG, ACTOR, created.id, "cancelada"))
  expect(cancelled.status).toBe("cancelada")
  // El mismo rango queda libre para otra cita.
  const reuse = await run((tx) =>
    createAppointment(tx, ORG, ACTOR, {
      patientId,
      dentistUserId: DENTIST,
      chairId,
      startsAt: "2026-10-08T15:00:00Z",
      endsAt: "2026-10-08T15:30:00Z",
    }),
  )
  expect(reuse.status).toBe("programada")
})

it("listScheduleResources devuelve miembros, sillones y la zona de la sucursal", async () => {
  const resources = await run((tx) => listScheduleResources(tx, ORG, {}))
  expect(resources.branchId).toBe(branchId)
  expect(resources.timeZone).toBe("America/Lima")
  expect(resources.professionals.map((p) => p.label)).toContain("Dra. Agenda Uno")
  expect(resources.chairs.map((c) => c.label)).toEqual(["Sillón Dos", "Sillón Uno"])
})

it("rechaza reserva fuera del horario y sin horario configurado", async () => {
  // Domingo 2026-10-11 sin turnos: fuera de horario aunque esté libre.
  await expect(
    run((tx) =>
      createAppointment(tx, ORG, ACTOR, {
        patientId,
        dentistUserId: DENTIST,
        chairId,
        startsAt: "2026-10-11T14:00:00Z",
        endsAt: "2026-10-11T14:30:00Z",
      }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION", status: 400 })
})

it("ofrece huecos dentro del horario y respeta bloqueos", async () => {
  const slots = await run((tx) =>
    listAvailableSlots(tx, ORG, {
      branchId,
      dentistUserId: DENTIST,
      from: "2026-10-05T05:00:00Z",
      to: "2026-10-06T05:00:00Z",
      durationMin: 30,
    }),
  )
  // 09:00 y 09:45 ocupadas por las citas previas; 10:30 libre con sillón.
  expect(slots.slots.some((slot) => slot.startsAt === "2026-10-05T15:30:00.000Z")).toBe(true)
  expect(slots.slots.some((slot) => slot.startsAt === "2026-10-05T14:00:00.000Z")).toBe(false)
  expect(slots.truncated).toBe(false)
  await run((tx) =>
    createScheduleBlock(tx, ORG, ACTOR, {
      branchId,
      dentistUserId: DENTIST,
      startsAt: "2026-10-05T15:30:00Z",
      endsAt: "2026-10-05T16:00:00Z",
      kind: "ausencia",
      reason: "Prueba",
    }),
  )
  const blocked = await run((tx) =>
    listAvailableSlots(tx, ORG, {
      branchId,
      dentistUserId: DENTIST,
      from: "2026-10-05T05:00:00Z",
      to: "2026-10-06T05:00:00Z",
      durationMin: 30,
    }),
  )
  expect(blocked.slots.some((slot) => slot.startsAt === "2026-10-05T15:30:00.000Z")).toBe(false)
})

it("la espera ofrece un hueco y lo reserva con el mismo servicio", async () => {
  const entry = await run((tx) =>
    addWaitlistEntry(tx, ORG, ACTOR, {
      branchId,
      patientId,
      dentistUserId: DENTIST_2,
      serviceId,
      priority: "alta",
      notes: "Prueba",
    }),
  )
  expect(entry.status).toBe("en_espera")
  const offered = await run((tx) =>
    offerWaitlistSlot(tx, ORG, ACTOR, entry.id, {
      startsAt: "2026-10-06T17:00:00Z",
      endsAt: "2026-10-06T17:45:00Z",
      dentistUserId: DENTIST_2,
      chairId: chair2Id,
    }),
  )
  expect(offered.status).toBe("ofrecida")
  const booked = await run((tx) => bookWaitlistEntry(tx, ORG, ACTOR, entry.id, {}))
  expect(booked.status).toBe("confirmada")
  expect(booked.serviceName).toBe("Limpieza Agenda")
})

it("la disponibilidad de la agenda materializa el horario y dice el próximo hueco de cada profesional", async () => {
  // Miércoles 2026-10-07 10:20 Lima: lo anterior ya pasó.
  const now = new Date("2026-10-07T15:20:00Z")
  const view = await run((tx) =>
    getAgendaAvailability(tx, ORG, {
      branchId,
      from: "2026-10-07T05:00:00Z",
      to: "2026-10-08T05:00:00Z",
      now,
    }),
  )
  expect(view.timeZone).toBe("America/Lima")
  expect(view.professionals.map((item) => item.id).sort()).toEqual([DENTIST, DENTIST_2].sort())
  // Dos turnos por profesional ese día: 09:00–13:00 y 14:00–18:00.
  expect(view.open.filter((item) => item.dentistUserId === DENTIST)).toEqual([
    { dentistUserId: DENTIST, startsAt: "2026-10-07T14:00:00.000Z", endsAt: "2026-10-07T18:00:00.000Z" },
    { dentistUserId: DENTIST, startsAt: "2026-10-07T19:00:00.000Z", endsAt: "2026-10-07T23:00:00.000Z" },
  ])
  for (const professional of view.professionals) {
    // El primer hueco nunca es anterior a «ahora» y cae en el paso de 15 minutos.
    expect(professional.nextFree?.startsAt).toBe("2026-10-07T15:30:00.000Z")
    expect(professional.nextFree?.chairId).toBeTruthy()
  }
})

it("los huecos descartan lo ya pasado cuando se indica el corte", async () => {
  const result = await run((tx) =>
    listAvailableSlots(tx, ORG, {
      branchId,
      dentistUserId: DENTIST,
      from: "2026-10-07T05:00:00Z",
      to: "2026-10-08T05:00:00Z",
      notBefore: "2026-10-07T20:10:00Z",
    }),
  )
  expect(result.slots[0]?.startsAt).toBe("2026-10-07T20:15:00.000Z")
})

it("la búsqueda de la agenda devuelve a la persona con sus próximas citas en pie", async () => {
  const [other] = await ownerDb
    .insert(patient)
    .values({ organizationId: ORG, displayName: "Zoila Sin Cita", patientNumber: 9102 })
    .returning({ id: patient.id })
  const booked = await run((tx) =>
    createAppointment(tx, ORG, ACTOR, {
      patientId: other!.id,
      dentistUserId: DENTIST,
      chairId,
      startsAt: "2026-10-08T21:00:00Z",
      durationMin: 30,
    }),
  )
  const now = new Date("2026-10-07T15:20:00Z")
  const found = await run((tx) => searchAgendaPatients(tx, ORG, { q: "zoila", now }))
  expect(found).toHaveLength(1)
  expect(found[0]?.appointments.map((item) => item.id)).toEqual([booked.id])

  await run((tx) => setAppointmentStatus(tx, ORG, ACTOR, booked.id, "cancelada"))
  const after = await run((tx) => searchAgendaPatients(tx, ORG, { q: "zoila", now }))
  expect(after[0]?.appointments).toEqual([])
  // Con menos de dos caracteres no se busca.
  expect(await run((tx) => searchAgendaPatients(tx, ORG, { q: "z", now }))).toEqual([])
})

it("cancelar deja el motivo y la nota en la auditoría, y rechaza un motivo desconocido", async () => {
  const booked = await run((tx) =>
    createAppointment(tx, ORG, ACTOR, {
      patientId,
      dentistUserId: DENTIST_2,
      chairId: chair2Id,
      startsAt: "2026-10-09T21:00:00Z",
      durationMin: 30,
    }),
  )
  await expect(
    run((tx) =>
      setAppointmentStatus(tx, ORG, ACTOR, booked.id, "cancelada", { cancelReason: "porque sí" }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  await run((tx) =>
    setAppointmentStatus(tx, ORG, ACTOR, booked.id, "cancelada", {
      cancelReason: "clinica",
      cancelNote: "  El doctor no viene  ",
    }),
  )
  const rows = await ownerDb.execute(
    sql`select metadata from audit_event
        where entity_id = ${booked.id} and action = ${"appointment.status_cancelada"}`,
  )
  expect(rows[0]?.metadata).toMatchObject({
    from: "programada",
    cancelReason: "clinica",
    cancelNote: "El doctor no viene",
  })
})

it("sin sillón indicado la agenda pone uno libre, y los tramos libres descuentan la cita", async () => {
  // Lunes 2026-11-09, 10:00–11:00 de Lima.
  const booked = await run((tx) =>
    createAppointment(tx, ORG, ACTOR, {
      branchId,
      patientId,
      dentistUserId: DENTIST,
      startsAt: "2026-11-09T15:00:00Z",
    }),
  )
  // Sin servicio ni duración: lo que dura una cita regular en la sede (1 h).
  expect(booked.durationMin).toBe(60)
  expect([chairId, chair2Id]).toContain(booked.chairId)

  const view = await run((tx) =>
    getAgendaAvailability(tx, ORG, {
      branchId,
      from: "2026-11-09T05:00:00Z",
      to: "2026-11-10T05:00:00Z",
      now: new Date("2026-11-01T12:00:00Z"),
    }),
  )
  expect(view.defaultDurationMin).toBe(60)
  expect(view.free.filter((item) => item.dentistUserId === DENTIST)).toEqual([
    { dentistUserId: DENTIST, startsAt: "2026-11-09T14:00:00.000Z", endsAt: "2026-11-09T15:00:00.000Z" },
    { dentistUserId: DENTIST, startsAt: "2026-11-09T16:00:00.000Z", endsAt: "2026-11-09T18:00:00.000Z" },
    { dentistUserId: DENTIST, startsAt: "2026-11-09T19:00:00.000Z", endsAt: "2026-11-09T23:00:00.000Z" },
  ])
  // A quien no tiene citas le queda libre todo su horario.
  expect(view.free.filter((item) => item.dentistUserId === DENTIST_2)).toEqual([
    { dentistUserId: DENTIST_2, startsAt: "2026-11-09T14:00:00.000Z", endsAt: "2026-11-09T18:00:00.000Z" },
    { dentistUserId: DENTIST_2, startsAt: "2026-11-09T19:00:00.000Z", endsAt: "2026-11-09T23:00:00.000Z" },
  ])

  // Con los dos sillones ocupados a esa hora, nadie más queda libre ni se puede reservar.
  await run((tx) =>
    createAppointment(tx, ORG, ACTOR, {
      branchId,
      patientId,
      dentistUserId: DENTIST_2,
      startsAt: "2026-11-09T15:00:00Z",
    }),
  )
  await expect(
    run((tx) =>
      createAppointment(tx, ORG, ACTOR, {
        branchId,
        patientId,
        dentistUserId: ACTOR,
        startsAt: "2026-11-09T15:00:00Z",
        outsideSchedule: true,
      }),
    ),
  ).rejects.toMatchObject({ code: "NO_CHAIR" })
})

it("fuera de horario solo se reserva como urgencia", async () => {
  // Sábado 2026-11-14: nadie tiene turno.
  const saturday = {
    branchId,
    patientId,
    dentistUserId: DENTIST,
    startsAt: "2026-11-14T15:00:00Z",
    durationMin: 30,
  }
  await expect(run((tx) => createAppointment(tx, ORG, ACTOR, saturday))).rejects.toMatchObject({
    status: 400,
  })
  const urgent = await run((tx) =>
    createAppointment(tx, ORG, ACTOR, { ...saturday, outsideSchedule: true }),
  )
  expect(urgent.status).toBe("programada")
  // La urgencia no salta lo demás: a la misma hora, el mismo profesional sigue ocupado.
  await expect(
    run((tx) => createAppointment(tx, ORG, ACTOR, { ...saturday, outsideSchedule: true })),
  ).rejects.toMatchObject({ code: "APPOINTMENT_CONFLICT" })
})

it("la duración de una cita regular se configura por sede", async () => {
  await expect(
    run((tx) => setBranchDefaultDuration(tx, ORG, ACTOR, { branchId, minutes: 50 })),
  ).rejects.toMatchObject({ status: 400 })
  await run((tx) => setBranchDefaultDuration(tx, ORG, ACTOR, { branchId, minutes: 30 }))
  const resources = await run((tx) => listScheduleResources(tx, ORG, { branchId }))
  expect(resources.defaultDurationMin).toBe(30)
  const booked = await run((tx) =>
    createAppointment(tx, ORG, ACTOR, {
      branchId,
      patientId,
      dentistUserId: DENTIST,
      startsAt: "2026-11-10T15:00:00Z",
    }),
  )
  expect(booked.durationMin).toBe(30)
  await run((tx) => setBranchDefaultDuration(tx, ORG, ACTOR, { branchId, minutes: 60 }))
})
