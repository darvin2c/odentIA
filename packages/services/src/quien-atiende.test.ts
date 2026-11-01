import { ATTENDING_ROLES, canAttend, ORG_ROLES } from "@odentia/auth/permissions"
import { withOrgContext } from "@odentia/db"
import { seedOdentiaCatalog } from "@odentia/db/dental"
import { member, user } from "@odentia/db/schema/auth"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { getBranchHours, listAgentProfessionals } from "./agent-clinic-info.js"
import { createAppointment, createRoom, listScheduleResources, moveAppointment, setAppointmentStatus } from "./appointments.js"
import { listTeamAttendance } from "./attending.js"
import {
  createScheduleBlock,
  getAgendaAvailability,
  listAvailableSlots,
  setProfessionalSchedule,
  zonedTimeToUtc,
} from "./availability.js"
import { issuePersonalLink, listBookingLinkProfessionals } from "./booking-links.js"
import {
  createClinicalOrder,
  createFormResponse,
  createFormTemplate,
  listSpecialtiesOverview,
  publishFormTemplate,
  setProfessionalSpecialties,
  setSpecialtyProfessionals,
} from "./clinical-forms.js"
import { createContact } from "./contacts.js"
import { createEncounter } from "./encounters.js"
import { setCommissionRate } from "./finance.js"
import { listProfessionalProfiles, setProfessionalProfile } from "./professional-profiles.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { createService } from "./service-catalog.js"
import { librarySpecialtyIds } from "./specialties.js"
import { insertTestPatients } from "./test-patient.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Quién atiende (ADR 0124). «Puede atender» es del rol y lo exige el servidor en
 * toda operación que le da trabajo clínico a alguien; «atiende» es además tener
 * horario activo, y la base lo cierra cuando alguien deja de poder atender.
 */
setupTestDb()

const ORG = "org_quien_atiende"
const ZONE = "America/Lima"
const OWNER = "qa-owner"
const DOCTOR = "qa-doctor"
const RECEPTION = "qa-reception"
const CASHIER = "qa-cashier"
const MEMBER = "qa-member"

const run = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(appDb, ORG, fn)

let centro = ""
let roomId = ""
let patientId = ""
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
const MORNING = [{ weekday: 2, startMin: 9 * 60, endMin: 13 * 60 }]

/** Alguien nuevo en la clínica; cada caso que cambia de rol o sale usa el suyo. */
async function hire(id: string, role: string, name = id) {
  await ownerDb.insert(user).values({ id, name, email: `${id}@example.test` })
  await ownerDb.insert(member).values({ id: `m-${id}`, organizationId: ORG, userId: id, role, createdAt: new Date() })
}

const activeSchedule = (userId: string) =>
  ownerDb
    .select({ isActive: professionalSchedule.isActive, validUntil: professionalSchedule.validUntil })
    .from(professionalSchedule)
    .where(and(eq(professionalSchedule.organizationId, ORG), eq(professionalSchedule.professionalUserId, userId), eq(professionalSchedule.isActive, true)))

/** Su horario viene de antes: al cerrarlo se conserva, con la fecha en que dejó de valer. */
const backdateSchedule = (userId: string) =>
  ownerDb
    .update(professionalSchedule)
    .set({ validFrom: "2026-01-05" })
    .where(and(eq(professionalSchedule.organizationId, ORG), eq(professionalSchedule.professionalUserId, userId)))

beforeAll(async () => {
  tuesday = nextTuesday()
  await insertOrg(ownerDb, ORG, "quien-atiende")
  await seedOdentiaCatalog(ownerDb)
  const [row] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Centro", timezone: ZONE }).returning({ id: branch.id })
  centro = row!.id
  await hire(OWNER, "owner", "Dueña")
  await hire(DOCTOR, "clinician", "Dra. Real")
  await hire(RECEPTION, "reception", "Rita Recepción")
  await hire(CASHIER, "cashier", "Carlos Caja")
  await hire(MEMBER, "member", "Mario Miembro")
  const [patient] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Paciente Prueba", patientNumber: 9301 })
  patientId = patient!.id
  await run(async (tx) => {
    roomId = (await createRoom(tx, ORG, { branchId: centro, name: "Unidad 1" })).id
    await setProfessionalSchedule(tx, ORG, OWNER, { branchId: centro, professionalUserId: DOCTOR, rules: MORNING })
  })
})

describe("puede atender: el servidor lo exige", () => {
  const NOT_ATTENDING = [RECEPTION, CASHIER, MEMBER]

  it("la lista de profesionales trae a quien puede atender, primero quien atiende de oficio", async () => {
    const resources = await run((tx) => listScheduleResources(tx, ORG, { branchId: centro }))
    expect(resources.professionals.map((item) => item.label)).toEqual(["Dra. Real", "Dueña"])
    expect(resources.professionals.map((item) => item.role)).toEqual(["clinician", "owner"])
    const profiles = await run((tx) => listProfessionalProfiles(tx, ORG))
    expect(profiles.map((item) => item.accountName).sort()).toEqual(["Dra. Real", "Dueña"])
  })

  it("recepción, caja y miembro no reciben horario, ausencia ni cita", async () => {
    for (const userId of NOT_ATTENDING) {
      await expect(
        run((tx) => setProfessionalSchedule(tx, ORG, OWNER, { branchId: centro, professionalUserId: userId, rules: MORNING })),
      ).rejects.toMatchObject({ code: "VALIDATION", fields: { professionalUserId: expect.stringContaining("no atiende pacientes") } })
      await expect(
        run((tx) =>
          createScheduleBlock(tx, ORG, OWNER, { branchId: centro, professionalUserId: userId, startsAt: at(9 * 60), endsAt: at(10 * 60), kind: "ausencia" }),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION" })
      // Ni como excepción de una persona del equipo: es lo que permitía «Añadir a la vista».
      await expect(
        run((tx) =>
          createAppointment(tx, ORG, OWNER, { patientId, professionalUserId: userId, roomId, startsAt: at(9 * 60), endsAt: at(9 * 60 + 30), outsideSchedule: true }),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION", fields: { professionalUserId: expect.any(String) } })
    }
  })

  it("tampoco reciben especialidad, comisión, colegiatura ni un formulario a su nombre", async () => {
    const specialtyId = await run(async (tx) => (await librarySpecialtyIds(tx, ORG, ["endodoncia"])).get("endodoncia")!)
    const templateId = await run(async (tx) => {
      const draft = await createFormTemplate(tx, ORG, OWNER, {
        title: "Evaluación",
        schema: { sections: [{ id: "uno", title: "Uno", fields: [{ id: "nota", label: "Nota", type: "texto_largo" }] }] },
      })
      return (await publishFormTemplate(tx, ORG, OWNER, draft.id)).id
    })
    for (const userId of NOT_ATTENDING) {
      await expect(run((tx) => setSpecialtyProfessionals(tx, ORG, OWNER, specialtyId, [userId]))).rejects.toMatchObject({
        fields: { userIds: expect.stringContaining("no atiende pacientes") },
      })
      await expect(run((tx) => setProfessionalSpecialties(tx, ORG, OWNER, userId, [specialtyId]))).rejects.toMatchObject({ code: "VALIDATION" })
      await expect(run((tx) => setCommissionRate(tx, ORG, OWNER, { professionalUserId: userId, rateBps: 3000 }))).rejects.toMatchObject({
        fields: { professionalUserId: expect.any(String) },
      })
      await expect(
        run((tx) => setProfessionalProfile(tx, ORG, OWNER, userId, { professionalTitle: "Cajero", registrationBody: "COP", registrationNumber: "99999" })),
      ).rejects.toMatchObject({ code: "VALIDATION" })
      await expect(
        run((tx) => createFormResponse(tx, ORG, OWNER, { templateId, patientId, professionalUserId: userId, answers: {} })),
      ).rejects.toMatchObject({ fields: { professionalUserId: expect.stringContaining("no atiende pacientes") } })
    }
    await expect(run((tx) => createFormResponse(tx, ORG, OWNER, { templateId, patientId, professionalUserId: DOCTOR, answers: {} }))).resolves.toMatchObject({
      professionalUserId: DOCTOR,
    })
    // Volver a 0 el porcentaje de quien ya no atiende sí se puede: es corregir, no darle trabajo.
    await expect(run((tx) => setCommissionRate(tx, ORG, OWNER, { professionalUserId: CASHIER, rateBps: 0 }))).resolves.toBeDefined()
  })

  it("quien dirige y quien atiende de oficio sí pueden", async () => {
    await expect(
      run((tx) => setProfessionalProfile(tx, ORG, OWNER, OWNER, { professionalTitle: "Cirujano dentista", registrationBody: "COP", registrationNumber: "12345" })),
    ).resolves.toMatchObject({ complete: true })
    await expect(run((tx) => setCommissionRate(tx, ORG, OWNER, { professionalUserId: DOCTOR, rateBps: 3000 }))).resolves.toBeDefined()
  })

  it("abrir una atención y derivar siguen rechazando a quien no atiende", async () => {
    await expect(run((tx) => createEncounter(tx, ORG, OWNER, patientId, { professionalUserId: CASHIER, reason: "Dolor" } as never))).rejects.toMatchObject({
      code: "VALIDATION",
    })
    await expect(
      run((tx) => createClinicalOrder(tx, ORG, DOCTOR, { kind: "interconsulta", patientId, recipientUserId: CASHIER, title: "Derivación" } as never)),
    ).rejects.toMatchObject({ fields: { recipientUserId: expect.any(String) } })
  })
})

describe("deja de atender: la base cierra su horario", () => {
  it("la lista de roles del disparador es la de los permisos", async () => {
    expect([...ATTENDING_ROLES].sort()).toEqual(ORG_ROLES.filter((role) => canAttend(role)).sort())
    let index = 0
    for (const role of ORG_ROLES) {
      index += 1
      const id = `qa-rol-${index}`
      await hire(id, "clinician")
      await run((tx) => setProfessionalSchedule(tx, ORG, OWNER, { branchId: centro, professionalUserId: id, rules: MORNING }))
      await ownerDb.update(member).set({ role }).where(eq(member.id, `m-${id}`))
      expect(await activeSchedule(id), `con el rol ${role}`).toHaveLength(canAttend(role) ? 1 : 0)
      await ownerDb.delete(member).where(eq(member.id, `m-${id}`))
    }
  })

  it("quien sale del equipo deja de ofrecerse y su horario de antes se conserva", async () => {
    const id = "qa-sale"
    await hire(id, "clinician", "Dra. Ya No Trabaja")
    await run((tx) => setProfessionalSchedule(tx, ORG, OWNER, { branchId: centro, professionalUserId: id, rules: [{ weekday: 2, startMin: 7 * 60, endMin: 20 * 60 }] }))
    await backdateSchedule(id)

    const offered = async () => {
      const agent = await run((tx) => listAgentProfessionals(tx, ORG))
      const view = await run((tx) => getAgendaAvailability(tx, ORG, { branchId: centro, from: at(0), to: at(24 * 60) }))
      const slots = await run((tx) => listAvailableSlots(tx, ORG, { branchId: centro, from: at(0), to: at(24 * 60) }))
      const hours = await run((tx) => getBranchHours(tx, ORG, new Date(), { branchId: centro }))
      const person = await run((tx) => createContact(tx, ORG, { displayName: `Marta ${Math.random()}` }))
      const link = await run((tx) => issuePersonalLink(tx, ORG, { contactId: person.id, booking: true, branchId: centro }, { secretsKey: secretsKeyFromEnv("cd".repeat(32)) }))
      const onLink = await run((tx) => listBookingLinkProfessionals(tx, ORG, link.token, { branchId: centro }))
      return {
        sofi: agent.map((item) => item.name),
        agenda: view.professionals.map((item) => item.label),
        huecos: [...new Set(slots.slots.map((slot) => slot.professionalName))].sort(),
        enlace: onLink.professionals.map((item) => item.name),
        sede: hours[0]?.week.flatMap((day) => day.ranges),
      }
    }

    const before = await offered()
    expect(before.sofi).toContain("Dra. Ya No Trabaja")
    expect(before.agenda).toContain("Dra. Ya No Trabaja")
    expect(before.huecos).toContain("Dra. Ya No Trabaja")
    expect(before.enlace).toContain("Dra. Ya No Trabaja")
    expect(before.sede).toEqual([[7 * 60, 20 * 60]])

    await ownerDb.delete(member).where(eq(member.id, `m-${id}`))

    const after = await offered()
    expect(after.sofi).not.toContain("Dra. Ya No Trabaja")
    expect(after.agenda).not.toContain("Dra. Ya No Trabaja")
    expect(after.huecos).not.toContain("Dra. Ya No Trabaja")
    expect(after.enlace).not.toContain("Dra. Ya No Trabaja")
    // El horario de la sede vuelve a ser el de quien sí atiende.
    expect(after.sede).toEqual([[9 * 60, 13 * 60]])

    const history = await ownerDb
      .select({ isActive: professionalSchedule.isActive, validUntil: professionalSchedule.validUntil })
      .from(professionalSchedule)
      .where(and(eq(professionalSchedule.organizationId, ORG), eq(professionalSchedule.professionalUserId, id)))
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ isActive: false })
    expect(history[0]?.validUntil).not.toBeNull()
  })

  it("quien cambia a recepción: su cita sigue, se pasa a otra persona y no se le dan más", async () => {
    const id = "qa-cambia"
    await hire(id, "clinician", "Dr. Cambia")
    await run((tx) => setProfessionalSchedule(tx, ORG, OWNER, { branchId: centro, professionalUserId: id, rules: MORNING }))
    const [other] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Otra Paciente", patientNumber: 9302 })
    const cita = await run((tx) => createAppointment(tx, ORG, OWNER, { patientId: other!.id, professionalUserId: id, roomId, startsAt: at(11 * 60), endsAt: at(11 * 60 + 30) }))

    await ownerDb.update(member).set({ role: "reception" }).where(eq(member.id, `m-${id}`))

    expect(await activeSchedule(id)).toHaveLength(0)
    // Lo que dice Equipo: sin horario y con una cita por mover.
    const attendance = await run((tx) => listTeamAttendance(tx, ORG))
    expect(attendance.find((item) => item.userId === id)).toMatchObject({ schedules: [], upcomingAppointments: 1 })
    expect(attendance.find((item) => item.userId === DOCTOR)?.schedules).toEqual([{ branchName: "Centro", weekdays: [2] }])

    // Se puede confirmar o cancelar como siempre; lo que no, moverla sin cambiar de persona.
    const confirmed = await run((tx) => setAppointmentStatus(tx, ORG, OWNER, cita.id, "confirmada"))
    await expect(
      run((tx) => moveAppointment(tx, ORG, OWNER, cita.id, { expectedVersion: confirmed.version, startsAt: at(12 * 60), endsAt: at(12 * 60 + 30) })),
    ).rejects.toMatchObject({ fields: { professionalUserId: expect.stringContaining("no atiende pacientes") } })
    const moved = await run((tx) =>
      moveAppointment(tx, ORG, OWNER, cita.id, { expectedVersion: confirmed.version, professionalUserId: DOCTOR, startsAt: at(12 * 60), endsAt: at(12 * 60 + 30) }),
    )
    expect(moved.professionalUserId).toBe(DOCTOR)
  })

  it("una especialidad ya no se queda con quien dejó de atender", async () => {
    const id = "qa-especialista"
    await hire(id, "clinician", "Dra. Especialista")
    const specialtyId = await run(async (tx) => (await librarySpecialtyIds(tx, ORG, ["endodoncia"])).get("endodoncia")!)
    const serviceId = await run(
      async (tx) =>
        (await createService(tx, ORG, OWNER, { name: "Endodoncia", specialtyId, scope: "tooth", priceCents: 45000, durationMin: 60, officialCode: "D3310" })).id,
    )
    await run((tx) => setProfessionalSchedule(tx, ORG, OWNER, { branchId: centro, professionalUserId: id, rules: MORNING }))
    await run((tx) => setSpecialtyProfessionals(tx, ORG, OWNER, specialtyId, [id]))
    const offeredFor = async () =>
      new Set((await run((tx) => listAvailableSlots(tx, ORG, { branchId: centro, serviceId, from: at(0), to: at(24 * 60) }))).slots.map((slot) => slot.professionalName))
    expect([...(await offeredFor())]).toEqual(["Dra. Especialista"])

    await ownerDb.update(member).set({ role: "cashier" }).where(eq(member.id, `m-${id}`))

    // Sin nadie adscrito con horario, la regla no aplica y se ofrece a quien atiende (ADR 0039).
    expect(await offeredFor()).toContain("Dra. Real")
    expect(await offeredFor()).not.toContain("Dra. Especialista")
    const overview = await run((tx) => listSpecialtiesOverview(tx, ORG))
    expect(overview.find((item) => item.id === specialtyId)?.professionals).toEqual([])
  })
})
