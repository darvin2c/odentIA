import { withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { sql } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import {
  createAppointment,
  createChair,
  listAppointments,
  listChairs,
  listScheduleResources,
  moveAppointment,
  searchAgendaPatients,
  setAppointmentStatus,
  setBranchDefaultDuration,
  updateAppointment,
  updateChair,
} from "./appointments.js"
import {
  createScheduleBlock,
  getAgendaAvailability,
  listAvailableSlots,
  setProfessionalSchedule,
} from "./availability.js"
import { findFreeGaps } from "./agent-operations.js"
import { listWeekSlots } from "./booking-links.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

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
  const [createdPatient] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Paciente Agenda", patientNumber: 9101 })
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
    await createChair(tx, ORG, { branchId, name: "Unidad dental Uno" }),
    await createChair(tx, ORG, { branchId, name: "Unidad dental Dos" }),
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
    chairName: "Unidad dental Uno",
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

it("rechaza profesional ajeno, paciente ajeno y unidad dental inexistente", async () => {
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

it("la doble reserva de la misma unidad dental o profesional responde 409 APPOINTMENT_CONFLICT", async () => {
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

it("«Editar» revisa la agenda igual que «Mover»: unidad bloqueada, quien no atiende y el servicio que dura más", async () => {
  // Viernes 2026-10-09, 10:00 en Lima.
  const created = await run((tx) =>
    createAppointment(tx, ORG, ACTOR, {
      patientId,
      dentistUserId: DENTIST,
      chairId,
      startsAt: "2026-10-09T15:00:00Z",
      endsAt: "2026-10-09T15:30:00Z",
    }),
  )
  await run((tx) =>
    createScheduleBlock(tx, ORG, ACTOR, {
      branchId,
      chairId: chair2Id,
      startsAt: "2026-10-09T14:00:00Z",
      endsAt: "2026-10-09T17:00:00Z",
      kind: "bloqueo",
      reason: "Mantenimiento de la unidad",
    }),
  )
  // A una unidad dental bloqueada: «Mover» no lo deja, y «Editar» tampoco.
  await expect(
    run((tx) => updateAppointment(tx, ORG, ACTOR, created.id, { expectedVersion: created.version, chairId: chair2Id })),
  ).rejects.toMatchObject({ code: "SCHEDULE_BLOCKED", status: 409 })
  // A alguien del equipo sin horario en la sede (recepción): no atiende.
  await expect(
    run((tx) => updateAppointment(tx, ORG, ACTOR, created.id, { expectedVersion: created.version, dentistUserId: ACTOR })),
  ).rejects.toMatchObject({ code: "VALIDATION", status: 400 })
  // Otro servicio, otra duración: la cita pasa a durar lo del servicio.
  const edited = await run((tx) => updateAppointment(tx, ORG, ACTOR, created.id, { expectedVersion: created.version, serviceId }))
  expect(new Date(edited.endsAt).getTime() - new Date(edited.startsAt).getTime()).toBe(45 * 60_000)
})

it("listScheduleResources devuelve miembros, unidades dentales y la zona de la sede", async () => {
  const resources = await run((tx) => listScheduleResources(tx, ORG, {}))
  expect(resources.branchId).toBe(branchId)
  expect(resources.timeZone).toBe("America/Lima")
  expect(resources.professionals.map((p) => p.label)).toContain("Dra. Agenda Uno")
  expect(resources.chairs.map((c) => c.label)).toEqual(["Unidad dental Dos", "Unidad dental Uno"])
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
  // 09:00 y 09:45 ocupadas por las citas previas; 10:30 libre con unidad dental.
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
      // Cada cuarto de hora (sin indicarlo, el paso sale de la duración: `bookingStepMin`).
      stepMin: 15,
    }),
  )
  expect(result.slots[0]?.startsAt).toBe("2026-10-07T20:15:00.000Z")
})

it("la búsqueda de la agenda devuelve a la persona con sus próximas citas en pie", async () => {
  const [other] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Zoila Sin Cita", patientNumber: 9102 })
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

it("la Agenda busca con el mismo buscador de personas: el teléfono escrito con espacios", async () => {
  await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Ana Teléfono", patientNumber: 9103, phone: "+51987654321" })
  const found = await run((tx) => searchAgendaPatients(tx, ORG, { q: "987 654 321" }))
  expect(found.map((item) => item.patientName)).toEqual(["Ana Teléfono"])
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

it("sin unidad dental indicada la agenda pone una libre, y los tramos libres descuentan la cita", async () => {
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

  // Con las dos unidades dentales ocupadas a esa hora, nadie más queda libre ni se puede reservar.
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

it("al reprogramar, el hueco de la propia cita cuenta como libre y la unidad dental se reasigna si hace falta", async () => {
  // Martes 2026-11-17: DENTIST 10:00–11:00 en la unidad dental 1; DENTIST_2 11:00–12:00 también en la unidad dental 1.
  const mine = await run((tx) =>
    createAppointment(tx, ORG, ACTOR, {
      branchId,
      patientId,
      dentistUserId: DENTIST,
      chairId,
      startsAt: "2026-11-17T15:00:00Z",
      endsAt: "2026-11-17T16:00:00Z",
    }),
  )
  await run((tx) =>
    createAppointment(tx, ORG, ACTOR, {
      branchId,
      patientId,
      dentistUserId: DENTIST_2,
      chairId,
      startsAt: "2026-11-17T16:00:00Z",
      endsAt: "2026-11-17T17:00:00Z",
    }),
  )
  const range = {
    branchId,
    from: "2026-11-17T05:00:00Z",
    to: "2026-11-18T05:00:00Z",
    now: new Date("2026-11-01T12:00:00Z"),
  }
  // Para los demás, su mañana se corta a las 10:00; para quien mueve esa cita, no.
  const others = await run((tx) => getAgendaAvailability(tx, ORG, range))
  expect(others.free.filter((item) => item.dentistUserId === DENTIST)[0]).toEqual({
    dentistUserId: DENTIST,
    startsAt: "2026-11-17T14:00:00.000Z",
    endsAt: "2026-11-17T15:00:00.000Z",
  })
  const moving = await run((tx) =>
    getAgendaAvailability(tx, ORG, { ...range, ignoreAppointmentId: mine.id }),
  )
  expect(moving.free.filter((item) => item.dentistUserId === DENTIST)[0]).toEqual({
    dentistUserId: DENTIST,
    startsAt: "2026-11-17T14:00:00.000Z",
    endsAt: "2026-11-17T18:00:00.000Z",
  })

  // A las 11:00 su unidad dental la ocupa otra cita: la cita se mueve y pasa a la unidad dental libre.
  const moved = await run((tx) =>
    moveAppointment(tx, ORG, ACTOR, mine.id, {
      expectedVersion: mine.version,
      startsAt: "2026-11-17T16:00:00Z",
    }),
  )
  expect(moved.startsAt).toBe("2026-11-17T16:00:00.000Z")
  expect(moved.chairId).toBe(chair2Id)
  // Media hora después sigue libre su unidad dental de ahora: la conserva.
  const again = await run((tx) =>
    moveAppointment(tx, ORG, ACTOR, mine.id, {
      expectedVersion: moved.version,
      startsAt: "2026-11-17T19:00:00Z",
    }),
  )
  expect(again.chairId).toBe(chair2Id)
})

it("una unidad dental se renombra, se desactiva y se reactiva; desactivada sale de las reservas y conserva sus citas", async () => {
  const extra = await run((tx) => createChair(tx, ORG, { branchId, name: "Unidad dental Tres" }))
  // Miércoles 2026-12-02, 10:00 de Lima: una cita en pie en esa unidad dental.
  const booked = await run((tx) =>
    createAppointment(tx, ORG, ACTOR, {
      branchId,
      patientId,
      dentistUserId: DENTIST,
      chairId: extra.id,
      startsAt: "2026-12-02T15:00:00Z",
      endsAt: "2026-12-02T15:30:00Z",
    }),
  )
  const now = new Date("2026-11-20T12:00:00Z")

  const renamed = await run((tx) => updateChair(tx, ORG, ACTOR, extra.id, { name: "  Sala de rayos  " }))
  expect(renamed).toEqual({ id: extra.id, name: "Sala de rayos", isActive: true })
  await expect(run((tx) => updateChair(tx, ORG, ACTOR, extra.id, { name: "   " }))).rejects.toMatchObject({ status: 400 })
  await expect(run((tx) => updateChair(tx, ORG, ACTOR, extra.id, {}))).rejects.toMatchObject({ status: 400 })

  // Quien lo va a desactivar ve antes cuántas citas en pie tiene por delante.
  const before = await run((tx) => listChairs(tx, ORG, { branchId, now }))
  expect(before.find((chair) => chair.id === extra.id)).toEqual({
    id: extra.id,
    name: "Sala de rayos",
    isActive: true,
    upcomingAppointments: 1,
  })

  await run((tx) => updateChair(tx, ORG, ACTOR, extra.id, { isActive: false }))
  // La agenda deja de ofrecerlo; Configuración lo sigue listando para reactivarlo.
  const resources = await run((tx) => listScheduleResources(tx, ORG, { branchId }))
  expect(resources.chairs.map((chair) => chair.id)).not.toContain(extra.id)
  const after = await run((tx) => listChairs(tx, ORG, { branchId, now }))
  expect(after.find((chair) => chair.id === extra.id)).toMatchObject({
    isActive: false,
    upcomingAppointments: 1,
  })
  // No admite reservas nuevas, pero la cita que tenía sigue en él.
  await expect(
    run((tx) =>
      createAppointment(tx, ORG, ACTOR, {
        branchId,
        patientId,
        dentistUserId: DENTIST_2,
        chairId: extra.id,
        startsAt: "2026-12-02T16:00:00Z",
        endsAt: "2026-12-02T16:30:00Z",
      }),
    ),
  ).rejects.toMatchObject({ status: 404 })
  const kept = await run((tx) =>
    listAppointments(tx, ORG, { from: "2026-12-02T05:00:00Z", to: "2026-12-03T05:00:00Z", branchId }),
  )
  expect(kept.find((item) => item.id === booked.id)).toMatchObject({
    chairId: extra.id,
    chairName: "Sala de rayos",
    status: "programada",
  })

  const back = await run((tx) => updateChair(tx, ORG, ACTOR, extra.id, { isActive: true }))
  expect(back.isActive).toBe(true)
  const restored = await run((tx) => listScheduleResources(tx, ORG, { branchId }))
  expect(restored.chairs.map((chair) => chair.id)).toContain(extra.id)

  // Otra organización no lo ve ni lo cambia.
  await expect(
    withOrgContext(appDb, "org_a", (tx) => updateChair(tx, "org_a", ACTOR, extra.id, { name: "Ajeno" })),
  ).rejects.toMatchObject({ status: 404 })
})

it("el enlace y el agente ofrecen las mismas horas: el mismo paso y quien atiende", async () => {
  // Martes 2 de marzo de 2027 en Lima, sin citas: lo que cambia es solo cómo se ofrece.
  const day = { from: "2027-03-02T05:00:00Z", to: "2027-03-03T05:00:00Z" }
  const link = await run((tx) => listWeekSlots(tx, ORG, { branchId, serviceId, ...day }))
  const agent = await run((tx) => findFreeGaps(tx, ORG, { branchId, serviceId, ...day }))
  expect(agent.gaps.length).toBeGreaterThan(0)
  const key = (slot: { startsAt: string; dentistUserId: string }) => `${slot.dentistUserId}@${slot.startsAt}`
  const offered = new Set(link.slots.map(key))
  // Cada hora que dice el agente es una que también ofrece el enlace (paso de 45 minutos, no de 15).
  for (const gap of agent.gaps) expect(offered.has(key(gap))).toBe(true)
  // El agente dice las dos primeras de cada profesional: las mismas que abren su día en el enlace.
  for (const dentist of [DENTIST, DENTIST_2]) {
    const first = link.slots.filter((slot) => slot.dentistUserId === dentist).slice(0, 2).map(key)
    expect(agent.gaps.filter((gap) => gap.dentistUserId === dentist).map(key)).toEqual(first)
  }
})
