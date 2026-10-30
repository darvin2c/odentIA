import { withOrgContext } from "@odentia/db"
import { seedOdentiaCatalog } from "@odentia/db/dental"
import { member, user } from "@odentia/db/schema/auth"
import { branch } from "@odentia/db/schema/org"
import { beforeAll, describe, expect, it } from "vitest"
import { professionalRef } from "./agent-clinic-info.js"
import { findFreeGaps, GAPS_PER_PROFESSIONAL_PER_DAY } from "./agent-operations.js"
import { createRoom } from "./appointments.js"
import { createScheduleBlock, getAgendaAvailability, listAvailableSlots, setProfessionalSchedule, zonedTimeToUtc } from "./availability.js"
import { issuePersonalLink, listBookingLinkProfessionals, listBookingLinkSlots, NEXT_FREE_HORIZON_DAYS } from "./booking-links.js"
import { listSpecialtiesOverview, setSpecialtyProfessionals } from "./clinical-forms.js"
import { createContact } from "./contacts.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { createService } from "./service-catalog.js"
import { librarySpecialtyIds } from "./specialties.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * La agenda ofrece solo a quien atiende el servicio (decisiones 2, 3 y 16 de
 * la fase 4; ADR 0039): una sola regla para recepción, el enlace y el agente.
 */
setupTestDb()

const ORG = "org_agenda_esp"
const ZONE = "America/Lima"
const OWNER = "esp-owner"
const PEREZ = "esp-perez"
const RIOS = "esp-rios"
const ROJAS = "esp-rojas"
/** Atiende endodoncia, pero solo en la otra sede. */
const LEON = "esp-leon"

const run = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(appDb, ORG, fn)

let centro = ""
let norte = ""
let endodonciaId = ""
let endoServiceId = ""
let generalServiceId = ""
/** El próximo martes (fecha local de Lima), al menos dos días después de hoy: nada de eso ya pasó. */
let tuesday = ""

function nextTuesday(): string {
  const now = new Date()
  for (let add = 2; add < 10; add++) {
    const day = new Date(now.getTime() + add * 86_400_000)
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(day)
    if (new Date(`${local}T12:00:00Z`).getUTCDay() === 2) return local
  }
  throw new Error("sin martes")
}

const at = (minutes: number) => zonedTimeToUtc(tuesday, minutes, ZONE).toISOString()

beforeAll(async () => {
  tuesday = nextTuesday()
  await insertOrg(ownerDb, ORG, "agenda-esp")
  // En el Perú cada servicio propio lleva su código CPMS (ADR 0069).
  await seedOdentiaCatalog(ownerDb)
  const branches = await ownerDb
    .insert(branch)
    .values([
      { organizationId: ORG, name: "Centro", timezone: ZONE },
      { organizationId: ORG, name: "Norte", timezone: ZONE },
    ])
    .returning({ id: branch.id, name: branch.name })
  centro = branches.find((row) => row.name === "Centro")!.id
  norte = branches.find((row) => row.name === "Norte")!.id
  await ownerDb.insert(user).values([
    { id: OWNER, name: "Dueña", email: "esp-owner@example.test" },
    { id: PEREZ, name: "Dr. Pérez", email: "esp-perez@example.test" },
    { id: RIOS, name: "Dra. Ríos", email: "esp-rios@example.test" },
    { id: ROJAS, name: "Dra. Rojas", email: "esp-rojas@example.test" },
    { id: LEON, name: "Dr. León", email: "esp-leon@example.test" },
  ])
  await ownerDb.insert(member).values(
    [OWNER, PEREZ, RIOS, ROJAS, LEON].map((userId) => ({
      id: `m-${userId}`,
      organizationId: ORG,
      userId,
      role: userId === OWNER ? "owner" : "clinician",
      createdAt: new Date(),
    })),
  )
  await run(async (tx) => {
    for (const name of ["Unidad dental 1", "Unidad dental 2", "Unidad dental 3"]) await createRoom(tx, ORG, { branchId: centro, name })
    await createRoom(tx, ORG, { branchId: norte, name: "Unidad dental Norte" })
    // Pérez, general, todos los días; Ríos, los martes por la mañana; Rojas, martes y jueves por la tarde.
    await setProfessionalSchedule(tx, ORG, OWNER, {
      branchId: centro,
      professionalUserId: PEREZ,
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 18 * 60 })),
    })
    await setProfessionalSchedule(tx, ORG, OWNER, {
      branchId: centro,
      professionalUserId: RIOS,
      rules: [{ weekday: 2, startMin: 8 * 60, endMin: 12 * 60 }],
    })
    await setProfessionalSchedule(tx, ORG, OWNER, {
      branchId: centro,
      professionalUserId: ROJAS,
      rules: [2, 4].map((weekday) => ({ weekday, startMin: 14 * 60, endMin: 18 * 60 })),
    })
    await setProfessionalSchedule(tx, ORG, OWNER, {
      branchId: norte,
      professionalUserId: LEON,
      rules: [{ weekday: 2, startMin: 9 * 60, endMin: 13 * 60 }],
    })
    const specialties = await librarySpecialtyIds(tx, ORG, ["endodoncia", "general"])
    endodonciaId = specialties.get("endodoncia")!
    endoServiceId = (
      await createService(tx, ORG, OWNER, {
        name: "Endodoncia unirradicular",
        specialtyId: endodonciaId,
        scope: "tooth",
        priceCents: 45000,
        durationMin: 60,
        officialCode: "D3310",
      })
    ).id
    generalServiceId = (
      await createService(tx, ORG, OWNER, {
        name: "Consulta",
        specialtyId: specialties.get("general")!,
        scope: "general",
        priceCents: 5000,
        durationMin: 30,
        officialCode: "D0150",
      })
    ).id
  })
})

const slotsFor = (serviceId: string, extra: { professionalUserId?: string } = {}) =>
  run((tx) => listAvailableSlots(tx, ORG, { branchId: centro, serviceId, from: at(0), to: at(24 * 60), ...extra }))

describe("la agenda ofrece solo a quien atiende el servicio", () => {
  it("sin nadie adscrito se ofrece a cualquiera, como antes", async () => {
    const result = await slotsFor(endoServiceId)
    expect(result.attending).toBeNull()
    expect(new Set(result.slots.map((slot) => slot.professionalUserId))).toEqual(new Set([PEREZ, RIOS, ROJAS]))
    // Especialidades lo avisa: nadie atiende Endodoncia y tiene un servicio.
    const overview = await run((tx) => listSpecialtiesOverview(tx, ORG))
    expect(overview.find((item) => item.id === endodonciaId)).toMatchObject({ professionals: [], serviceCount: 1 })
  })

  it("si quien la atiende no tiene horario en esa sede, tampoco aplica", async () => {
    await run((tx) => setSpecialtyProfessionals(tx, ORG, OWNER, endodonciaId, [LEON]))
    const result = await slotsFor(endoServiceId)
    expect(result.attending).toBeNull()
    expect(new Set(result.slots.map((slot) => slot.professionalUserId))).toEqual(new Set([PEREZ, RIOS, ROJAS]))
  })

  it("con alguien adscrito y con horario en la sede, solo sus huecos; pedir a otro no da ninguno", async () => {
    await run((tx) => setSpecialtyProfessionals(tx, ORG, OWNER, endodonciaId, [ROJAS, LEON]))
    const result = await slotsFor(endoServiceId)
    expect(result.attending).toEqual({ specialtyName: "Endodoncia", professionalUserIds: [ROJAS] })
    expect(result.slots.length).toBeGreaterThan(0)
    expect(result.slots.every((slot) => slot.professionalUserId === ROJAS)).toBe(true)
    // Martes por la tarde: 14:00 es su primer hueco.
    expect(result.slots[0]?.startsAt).toBe(at(14 * 60))
    const other = await slotsFor(endoServiceId, { professionalUserId: PEREZ })
    expect(other.slots).toEqual([])
    expect(other.attending?.professionalUserIds).toEqual([ROJAS])
    // Recepción («Nueva cita» con el servicio) ve lo mismo: solo a quien atiende.
    const view = await run((tx) =>
      getAgendaAvailability(tx, ORG, { branchId: centro, serviceId: endoServiceId, from: at(0), to: at(24 * 60), now: new Date(at(0)) }),
    )
    expect(view.professionals.map((item) => item.id)).toEqual([ROJAS])
    expect(view.free.every((item) => item.professionalUserId === ROJAS)).toBe(true)
    expect(view.attending?.specialtyName).toBe("Endodoncia")
    // Un servicio de otra especialidad sin nadie adscrito sigue para todos.
    const general = await slotsFor(generalServiceId)
    expect(general.attending).toBeNull()
    expect(new Set(general.slots.map((slot) => slot.professionalUserId))).toEqual(new Set([PEREZ, RIOS, ROJAS]))
  })

  it("los huecos se ordenan por hora, mezclando a los profesionales", async () => {
    const result = await run((tx) =>
      listAvailableSlots(tx, ORG, { branchId: centro, durationMin: 30, from: at(8 * 60), to: at(12 * 60) }),
    )
    const starts = result.slots.map((slot) => slot.startsAt)
    expect(starts).toEqual([...starts].sort())
    // Ríos abre a las 8:00 y Pérez a las 9:00: los dos aparecen antes de las 9:15.
    const early = result.slots.filter((slot) => slot.startsAt <= at(9 * 60 + 15)).map((slot) => slot.professionalUserId)
    expect(early[0]).toBe(RIOS)
    expect(early).toContain(PEREZ)
  })
})

describe("los huecos del agente (decisión 16)", () => {
  it("dos por profesional y día, por hora, y siempre de quien atiende el servicio", async () => {
    const all = await run((tx) => findFreeGaps(tx, ORG, { branchId: centro, from: tuesday, to: `${tuesday}T23:59` }))
    const perProfessional = new Map<string, number>()
    for (const gap of all.gaps) perProfessional.set(gap.professionalUserId, (perProfessional.get(gap.professionalUserId) ?? 0) + 1)
    expect(Object.fromEntries(perProfessional)).toEqual({
      [PEREZ]: GAPS_PER_PROFESSIONAL_PER_DAY,
      [RIOS]: GAPS_PER_PROFESSIONAL_PER_DAY,
      [ROJAS]: GAPS_PER_PROFESSIONAL_PER_DAY,
    })
    expect(all.gaps.map((gap) => gap.startsAt)).toEqual(all.gaps.map((gap) => gap.startsAt).sort())
    expect(all.gaps[0]?.professionalName).toBe("Dra. Ríos")
    const endo = await run((tx) =>
      findFreeGaps(tx, ORG, { branchId: centro, serviceId: endoServiceId, from: tuesday, to: `${tuesday}T23:59` }),
    )
    expect(endo.gaps.map((gap) => gap.professionalUserId)).toEqual([ROJAS, ROJAS])
    expect(endo.attending).toEqual({ specialtyName: "Endodoncia", names: ["Dra. Rojas"] })
  })

  it("«quiero cita con la Dra. Rojas»: su identificador trae solo sus huecos", async () => {
    const mine = await run((tx) =>
      findFreeGaps(tx, ORG, { branchId: centro, professionalRef: professionalRef(ORG, ROJAS), from: tuesday, to: `${tuesday}T23:59` }),
    )
    expect(mine.gaps).toHaveLength(GAPS_PER_PROFESSIONAL_PER_DAY)
    expect(mine.gaps.every((gap) => gap.professionalUserId === ROJAS)).toBe(true)
    // Pedir endodoncia con alguien que no la atiende: ninguna hora, y se dice por qué.
    const wrong = await run((tx) =>
      findFreeGaps(tx, ORG, {
        branchId: centro,
        serviceId: endoServiceId,
        professionalRef: professionalRef(ORG, PEREZ),
        from: tuesday,
        to: `${tuesday}T23:59`,
      }),
    )
    expect(wrong.gaps).toEqual([])
    expect(wrong.professionalNotAttending).toBe(true)
    // Un identificador que no es de nadie de la clínica no se adivina.
    await expect(
      run((tx) => findFreeGaps(tx, ORG, { branchId: centro, professionalRef: "pro-0000000000", from: tuesday, to: `${tuesday}T23:59` })),
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe("«Su enlace»: con quién reservar y su próximo horario", () => {
  const KEY = secretsKeyFromEnv("cd".repeat(32))

  it("son quienes atienden su servicio en la sede, cada uno con su próximo horario: el primero de las horas del enlace", async () => {
    // Endodoncia la atiende la Dra. Rojas en Centro; el Dr. León, solo en Norte.
    await run((tx) => setSpecialtyProfessionals(tx, ORG, OWNER, endodonciaId, [ROJAS, LEON]))
    const person = await run((tx) => createContact(tx, ORG, { displayName: "Marta Quispe" }))
    const endo = await run((tx) =>
      issuePersonalLink(tx, ORG, { contactId: person.id, booking: true, serviceId: endoServiceId, branchId: centro }, { secretsKey: KEY }),
    )
    const list = await run((tx) => listBookingLinkProfessionals(tx, ORG, endo.token, { branchId: centro }))
    expect(list.professionals.map((item) => item.id)).toEqual([ROJAS])
    const rojas = list.professionals[0]!
    expect(rojas.next).not.toBeNull()
    expect(rojas.current).toBe(false)
    expect(list.first).toEqual({ startsAt: rojas.next!.startsAt, professionalUserId: ROJAS })
    expect(new Date(list.until).getTime() - Date.now()).toBeGreaterThan((NEXT_FREE_HORIZON_DAYS - 1) * 86_400_000)
    const now = new Date()
    const week = await run((tx) =>
      listBookingLinkSlots(tx, ORG, endo.token, { branchId: centro, from: now.toISOString(), to: new Date(now.getTime() + 7 * 86_400_000).toISOString() }),
    )
    expect(week.slots[0]).toMatchObject({ startsAt: rojas.next!.startsAt, professionalUserId: ROJAS })

    // Un servicio sin nadie adscrito: todos los que tienen horario en la sede, por nombre (León atiende en Norte).
    const general = await run((tx) =>
      issuePersonalLink(tx, ORG, { contactId: person.id, booking: true, serviceId: generalServiceId, branchId: centro }, { secretsKey: KEY }),
    )
    const all = await run((tx) => listBookingLinkProfessionals(tx, ORG, general.token, { branchId: centro }))
    expect(all.professionals.map((item) => item.name)).toEqual(["Dr. Pérez", "Dra. Ríos", "Dra. Rojas"])
    expect(all.professionals.every((item) => item.next !== null)).toBe(true)
    const earliest = all.professionals.map((item) => item.next!.startsAt).sort()[0]
    expect(all.first?.startsAt).toBe(earliest)

    // Quien no tiene ningún horario libre en esas semanas sigue en la lista, sin próximo horario.
    await run((tx) =>
      createScheduleBlock(tx, ORG, OWNER, {
        branchId: centro,
        professionalUserId: RIOS,
        startsAt: new Date(Date.now() - 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + (NEXT_FREE_HORIZON_DAYS + 7) * 86_400_000).toISOString(),
      }),
    )
    const blocked = await run((tx) => listBookingLinkProfessionals(tx, ORG, general.token, { branchId: centro }))
    expect(blocked.professionals.find((item) => item.id === RIOS)?.next).toBeNull()
    expect(blocked.first?.professionalUserId).not.toBe(RIOS)
    // El enlace es para Centro: otra sede no se pregunta.
    await expect(run((tx) => listBookingLinkProfessionals(tx, ORG, general.token, { branchId: norte }))).rejects.toMatchObject({ status: 400 })
  })
})
