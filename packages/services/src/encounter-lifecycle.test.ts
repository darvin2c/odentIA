import { randomUUID } from "node:crypto"
import { member, user } from "@odentia/db/schema/auth"
import { cie10Code, encounter, odontogramEntry, patientCharge } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createAppointment, createChair, getAppointment } from "./appointments.js"
import { setProfessionalSchedule } from "./availability.js"
import { addClinicalNote, addOdontogramEntries } from "./clinical.js"
import { clinicalFixture, makeSigner } from "./clinical-test-fixture.js"
import { addEncounterDiagnosis } from "./encounter-diagnoses.js"
import {
  addEncounterProcedure,
  createEncounter,
  finalizeEncounter,
  getEncounterClosing,
  getEncounterDetail,
  listEncounters,
  takeOverEncounter,
  updateEncounterDraft,
  voidEncounter,
  voidEncounterProcedure,
} from "./encounters.js"
import { createFollowUp, listFollowUps, scheduleFollowUp } from "./follow-ups.js"
import { getPatientSummary } from "./patient-history.js"
import { listPlanItems } from "./plan.js"
import { getProfessionalProfile, setProfessionalProfile } from "./professional-profiles.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

async function withAgenda() {
  const f = await clinicalFixture()
  await ownerDb
    .insert(cie10Code)
    .values({ code: "K02.1", description: "Caries de la dentina" })
    .onConflictDoNothing()
  const [site] = await ownerDb
    .insert(branch)
    .values({
      organizationId: "org_a",
      name: `Sede ${randomUUID().slice(0, 6)}`,
      timezone: "America/Lima",
    })
    .returning()
  if (!site) throw new Error("Sin sede")
  const chair = await f.run((tx) => createChair(tx, "org_a", { branchId: site.id, name: "Sillón" }))
  await f.run((tx) =>
    setProfessionalSchedule(tx, "org_a", f.actor, {
      branchId: site.id,
      dentistUserId: f.actor,
      rules: Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        startMin: 0,
        endMin: 24 * 60 - 1,
      })),
    }),
  )
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  const book = (hour: number) =>
    f.run((tx) =>
      createAppointment(tx, "org_a", f.actor, {
        branchId: site.id,
        patientId: f.patient.id,
        dentistUserId: f.actor,
        chairId: chair.id,
        startsAt: `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`,
        durationMin: 30,
        status: "confirmada",
      }),
    )
  return { ...f, site, chair, date, book }
}

/**
 * Zona fija cuyo reloj marca ahora entre las 12:00 y las 12:59: «hoy» y «la
 * más cercana» no dependen de la hora a la que corre la prueba. `Etc/GMT`
 * invierte el signo: «Etc/GMT-3» es UTC+3.
 */
function noonZone(now = new Date()): { zone: string; offsetHours: number } {
  const offsetHours = 12 - now.getUTCHours()
  const zone =
    offsetHours === 0
      ? "Etc/GMT"
      : offsetHours > 0
        ? `Etc/GMT-${offsetHours}`
        : `Etc/GMT+${-offsetHours}`
  return { zone, offsetHours }
}

/** Sede en esa zona, con horario todo el día y citas que se reservan a una hora local. */
async function withZoneAgenda() {
  const f = await clinicalFixture()
  const { zone, offsetHours } = noonZone()
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede ${randomUUID().slice(0, 6)}`, timezone: zone })
    .returning()
  if (!site) throw new Error("Sin sede")
  const chair = await f.run((tx) => createChair(tx, "org_a", { branchId: site.id, name: "Sillón" }))
  const schedule = (dentistUserId: string) =>
    f.run((tx) =>
      setProfessionalSchedule(tx, "org_a", f.actor, {
        branchId: site.id,
        dentistUserId,
        rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMin: 0, endMin: 24 * 60 - 1 })),
      }),
    )
  await schedule(f.actor)
  const localToday = new Date(Date.now() + offsetHours * 3_600_000)
  /** Cita a esa hora local, `dayOffset` días desde hoy en la zona de la sede. */
  const bookLocal = (dayOffset: number, hour: number, minute: number, dentistUserId = f.actor) =>
    f.run((tx) =>
      createAppointment(tx, "org_a", f.actor, {
        branchId: site.id,
        patientId: f.patient.id,
        dentistUserId,
        chairId: chair.id,
        startsAt: new Date(
          Date.UTC(
            localToday.getUTCFullYear(),
            localToday.getUTCMonth(),
            localToday.getUTCDate() + dayOffset,
            hour,
            minute,
          ) -
            offsetHours * 3_600_000,
        ).toISOString(),
        durationMin: 30,
        status: "confirmada",
      }),
    )
  return { ...f, site, schedule, bookLocal }
}

it("sin cita indicada, la atención se une a la cita de hoy más cercana y al cerrarla queda atendida", async () => {
  const f = await withZoneAgenda()
  await f.run((tx) => voidEncounter(tx, ...f.args, f.encounter.id, { reason: "Borrador de prueba" }))
  const early = await f.bookLocal(0, 9, 0)
  const near = await f.bookLocal(0, 13, 30)
  await f.bookLocal(1, 12, 30)
  const control = await f.run((tx) =>
    createFollowUp(tx, ...f.args, { kind: "mantenimiento", title: "Control", dueAt: near.startsAt }),
  )
  await f.run((tx) => scheduleFollowUp(tx, ...f.args, control.id, { appointmentId: near.id }))
  // La sede elegida por defecto no manda: manda la de la cita.
  const first = await f.run((tx) => createEncounter(tx, ...f.args, { reason: "Dolor", branchId: null }))
  expect(first).toMatchObject({ appointmentId: near.id, branchId: f.site.id, dentistUserId: f.actor })
  await f.ready(first.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, first.id))
  expect((await f.run((tx) => getAppointment(tx, "org_a", near.id))).status).toBe("atendida")
  expect((await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id)))[0]).toMatchObject({
    status: "realizado",
    completedEncounterId: first.id,
  })
  expect((await f.run((tx) => getAppointment(tx, "org_a", early.id))).status).toBe("confirmada")
  // La siguiente se une a la que queda hoy; la de mañana nunca.
  const second = await f.run((tx) => createEncounter(tx, ...f.args, { reason: "Otra molestia" }))
  expect(second.appointmentId).toBe(early.id)
  await f.ready(second.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, second.id))
  const third = await f.run((tx) => createEncounter(tx, ...f.args, { reason: "Sin cita hoy" }))
  expect(third.appointmentId).toBeNull()
})

it("atender la cita con un borrador sin cita del mismo día lo une a ella en vez de abrir otro", async () => {
  const f = await withZoneAgenda()
  const visit = await f.bookLocal(0, 13, 30)
  // Un borrador de otro día no es esta visita: no se mueve.
  await ownerDb
    .update(encounter)
    .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
    .where(eq(encounter.id, f.encounter.id))
  await expect(
    f.run((tx) => createEncounter(tx, ...f.args, { reason: "Control", appointmentId: visit.id })),
  ).rejects.toMatchObject({ code: "DRAFT_OPEN" })
  await ownerDb.update(encounter).set({ createdAt: new Date() }).where(eq(encounter.id, f.encounter.id))
  const joined = await f.run((tx) =>
    createEncounter(tx, ...f.args, { reason: "Control", appointmentId: visit.id }),
  )
  expect(joined).toMatchObject({
    id: f.encounter.id,
    appointmentId: visit.id,
    branchId: f.site.id,
    status: "borrador",
    reason: "Consulta",
  })
  // Atender otra vez la misma cita continúa el mismo borrador.
  const again = await f.run((tx) =>
    createEncounter(tx, ...f.args, { reason: "Otra vez", appointmentId: visit.id }),
  )
  expect(again.id).toBe(f.encounter.id)
  // Ya unido a una cita, no se une a otra.
  const other = await f.bookLocal(0, 9, 0)
  await expect(
    f.run((tx) => createEncounter(tx, ...f.args, { reason: "Otra", appointmentId: other.id })),
  ).rejects.toMatchObject({ code: "DRAFT_OPEN" })
  await f.ready(joined.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, joined.id))
  expect((await f.run((tx) => getAppointment(tx, "org_a", visit.id))).status).toBe("atendida")
})

it("por defecto atiende quien abre, aunque la cita sea de otro, y solo un profesional clínico puede atender", async () => {
  const f = await withZoneAgenda()
  await f.run((tx) => voidEncounter(tx, ...f.args, f.encounter.id, { reason: "Borrador de prueba" }))
  const colleague = randomUUID()
  const cashier = randomUUID()
  await ownerDb.insert(user).values([
    { id: colleague, name: "Ana", email: `${colleague}@example.test` },
    { id: cashier, name: "Caja", email: `${cashier}@example.test` },
  ])
  await makeSigner("org_a", colleague)
  await ownerDb
    .insert(member)
    .values({ id: randomUUID(), organizationId: "org_a", userId: cashier, role: "cashier", createdAt: new Date() })
  await f.schedule(colleague)
  // La cita es de Ana; quien pulsa (el actor) la cubre y es quien escribe.
  const visit = await f.bookLocal(0, 13, 30, colleague)
  await expect(
    f.run((tx) => createEncounter(tx, ...f.args, { reason: "Dolor", dentistUserId: cashier })),
  ).rejects.toMatchObject({ status: 400 })
  const covered = await f.run((tx) => createEncounter(tx, ...f.args, { reason: "Dolor" }))
  expect(covered).toMatchObject({ appointmentId: visit.id, dentistUserId: f.actor })
  await f.run((tx) => voidEncounter(tx, ...f.args, covered.id, { reason: "Lo atiende Ana" }))
  const byColleague = await f.run((tx) =>
    createEncounter(tx, ...f.args, { reason: "Dolor", dentistUserId: colleague }),
  )
  expect(byColleague.dentistUserId).toBe(colleague)
})

it("cerrar exige motivo, diagnóstico, evolución y colegiatura, y firma con su instantánea", async () => {
  const f = await clinicalFixture()
  // El borrador del fixture ya existe: se usa como atención en curso.
  const encounterId = f.encounter.id
  expect(await f.run((tx) => getEncounterClosing(tx, ...f.args, encounterId))).toEqual({
    ready: false,
    missing: ["diagnosis", "evolution"],
  })
  await expect(f.run((tx) => finalizeEncounter(tx, ...f.args, encounterId))).rejects.toMatchObject({
    code: "CLOSING_INCOMPLETE",
  })
  await f.ready(encounterId)
  // Sin colegiatura no hay firma, aunque el resto esté completo.
  await f.run((tx) =>
    setProfessionalProfile(tx, "org_a", f.actor, f.actor, { registrationNumber: null }),
  )
  expect((await f.run((tx) => getEncounterClosing(tx, ...f.args, encounterId))).missing).toEqual([
    "signature",
  ])
  await expect(
    f.run((tx) =>
      setProfessionalProfile(tx, "org_a", f.actor, f.actor, { registrationNumber: "12 345" }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  await f.run((tx) =>
    setProfessionalProfile(tx, "org_a", f.actor, f.actor, {
      registrationNumber: "54321",
      signatureName: "Dra. Firma",
    }),
  )
  expect((await f.run((tx) => getProfessionalProfile(tx, "org_a", f.actor))).complete).toBe(true)
  await expect(
    f.run((tx) =>
      finalizeEncounter(tx, ...f.args, encounterId, { endedAt: "2000-01-01T00:00:00Z" }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, encounterId))
  expect(closed.encounter).toMatchObject({
    status: "finalizada",
    signerName: "Dra. Firma",
    signerTitle: "Cirujano dentista",
    signerRegistration: "COP 54321",
  })
  expect(closed.encounter.endedAt).not.toBeNull()
  // Cambiar el perfil después no reescribe lo firmado.
  await f.run((tx) =>
    setProfessionalProfile(tx, "org_a", f.actor, f.actor, { registrationNumber: "99999" }),
  )
  expect(
    (await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, encounterId))).encounter
      .signerRegistration,
  ).toBe("COP 54321")
})

it("la atención nace de la cita y al cerrarse la deja atendida con su control realizado", async () => {
  const f = await withAgenda()
  // Cierra el borrador del fixture para poder abrir la atención de la cita.
  await f.run((tx) =>
    voidEncounter(tx, ...f.args, f.encounter.id, { reason: "Borrador de prueba" }),
  )
  const visit = await f.book(14)
  const control = await f.run((tx) =>
    createFollowUp(tx, ...f.args, {
      kind: "mantenimiento",
      title: "Control semestral",
      dueAt: visit.startsAt,
    }),
  )
  await f.run((tx) => scheduleFollowUp(tx, ...f.args, control.id, { appointmentId: visit.id }))
  const draft = await f.run((tx) =>
    createEncounter(tx, ...f.args, { reason: "Control", appointmentId: visit.id }),
  )
  expect(draft).toMatchObject({
    appointmentId: visit.id,
    branchId: f.site.id,
    dentistUserId: f.actor,
  })
  await f.ready(draft.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, draft.id))
  expect((await f.run((tx) => getAppointment(tx, "org_a", visit.id))).status).toBe("atendida")
  const [row] = await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id))
  expect(row).toMatchObject({ status: "realizado", completedEncounterId: draft.id })
  // Una cita atendida no vuelve a abrir atención.
  await expect(
    f.run((tx) => createEncounter(tx, ...f.args, { reason: "Otra", appointmentId: visit.id })),
  ).rejects.toMatchObject({ code: "APPOINTMENT_NOT_ATTENDABLE" })
})

it("anular el borrador lo cierra con motivo y anula sus actos sin cargos; la cita puede reatenderse", async () => {
  const f = await withAgenda()
  await f.run((tx) => voidEncounter(tx, ...f.args, f.encounter.id, { reason: "Inicial" }))
  const visit = await f.book(16)
  const draft = await f.run((tx) =>
    createEncounter(tx, ...f.args, { reason: "Paciente equivocado", appointmentId: visit.id }),
  )
  const [finding] = await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 36,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "enamel" },
      encounterId: draft.id,
    }),
  )
  await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, draft.id, {
      cie10Code: "K02.1",
      diagnosisType: "definitivo",
    }),
  )
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, draft.id, { serviceId: f.service.id }))
  await f.run((tx) => addClinicalNote(tx, ...f.args, { note: "Dolor", encounterId: draft.id }))
  await expect(
    f.run((tx) => voidEncounter(tx, ...f.args, draft.id, { reason: "  " })),
  ).rejects.toMatchObject({ status: 400 })
  const voided = await f.run((tx) =>
    voidEncounter(tx, ...f.args, draft.id, { reason: "Paciente equivocado" }),
  )
  expect(voided).toMatchObject({ status: "anulada", voidReason: "Paciente equivocado" })
  const detail = await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, draft.id))
  expect(detail.procedures.every((p) => p.voidedAt !== null)).toBe(true)
  expect(detail.diagnoses.every((d) => d.voidedAt !== null)).toBe(true)
  const [entry] = await ownerDb
    .select({ status: odontogramEntry.status })
    .from(odontogramEntry)
    .where(eq(odontogramEntry.id, finding!.id))
  expect(entry?.status).toBe("voided")
  // El tratamiento directo se cancela: no queda realizado ni genera cargo.
  const items = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))
  expect(items.filter((i) => i.sourceEncounterId === draft.id).map((i) => i.status)).toEqual([
    "cancelado",
  ])
  expect(
    await ownerDb.select().from(patientCharge).where(eq(patientCharge.patientId, f.patient.id)),
  ).toEqual([])
  // Inmutable una vez anulada.
  await expect(
    f.run((tx) => updateEncounterDraft(tx, ...f.args, draft.id, { reason: "Otro" })),
  ).rejects.toMatchObject({ code: "VOIDED" })
  // La cita sigue confirmada y puede atenderse en otra atención.
  expect((await f.run((tx) => getAppointment(tx, "org_a", visit.id))).status).toBe("confirmada")
  const again = await f.run((tx) =>
    createEncounter(tx, ...f.args, { reason: "Atención correcta", appointmentId: visit.id }),
  )
  expect(again.appointmentId).toBe(visit.id)
})

it("un procedimiento anulado en borrador no cuenta como sesión ni genera cargo", async () => {
  const f = await clinicalFixture()
  const proc = await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: f.service.id }),
  )
  await f.run((tx) =>
    voidEncounterProcedure(tx, ...f.args, f.encounter.id, proc.id, {
      reason: "Registro duplicado",
    }),
  )
  await expect(
    f.run((tx) =>
      voidEncounterProcedure(tx, ...f.args, f.encounter.id, proc.id, { reason: "Otra vez" }),
    ),
  ).rejects.toMatchObject({ code: "ALREADY_VOIDED" })
  await f.ready(f.encounter.id)
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(closed.charges).toEqual([])
  expect(
    await ownerDb
      .select()
      .from(patientCharge)
      .where(and(eq(patientCharge.patientId, f.patient.id))),
  ).toEqual([])
})

it("otro profesional lee el borrador y solo lo continúa tomando el relevo", async () => {
  const f = await clinicalFixture()
  const colleague = randomUUID()
  await ownerDb
    .insert(user)
    .values({ id: colleague, name: "Colega", email: `${colleague}@example.test` })
  await makeSigner("org_a", colleague)
  await expect(
    f.run((tx) =>
      updateEncounterDraft(tx, "org_a", colleague, f.patient.id, f.encounter.id, {
        evolution: "Sigo yo",
      }),
    ),
  ).rejects.toMatchObject({ code: "NOT_ATTENDING" })
  const taken = await f.run((tx) =>
    takeOverEncounter(tx, "org_a", colleague, f.patient.id, f.encounter.id),
  )
  expect(taken.dentistUserId).toBe(colleague)
  await f.run((tx) =>
    updateEncounterDraft(tx, "org_a", colleague, f.patient.id, f.encounter.id, {
      evolution: "Sigo yo",
    }),
  )
})

it("el hallazgo tratado deja de estar vigente al cerrar la atención que lo trató", async () => {
  const f = await clinicalFixture()
  const [finding] = await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 36,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "enamel" },
      encounterId: f.encounter.id,
    }),
  )
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, {
      serviceId: f.service.id,
      odontogramEntryId: finding!.id,
    }),
  )
  await f.ready(f.encounter.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const [entry] = await ownerDb
    .select()
    .from(odontogramEntry)
    .where(eq(odontogramEntry.id, finding!.id))
  expect(entry?.resolvedAt).not.toBeNull()
  expect(entry?.status).toBe("recorded")
  expect(entry?.voidedAt).toBeNull()
})

it("la lista de atenciones filtra por estado y resume diagnósticos y actos vigentes", async () => {
  const f = await clinicalFixture()
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: f.service.id }),
  )
  const anulado = await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: f.service.id }),
  )
  await f.run((tx) =>
    voidEncounterProcedure(tx, ...f.args, f.encounter.id, anulado.id, { reason: "Duplicado" }),
  )
  await f.ready(f.encounter.id)
  const all = await f.run((tx) => listEncounters(tx, "org_a", f.patient.id, {}))
  expect(all.items).toHaveLength(1)
  expect(all.items[0]).toMatchObject({
    status: "borrador",
    diagnosisCodes: ["K02.1"],
    procedureCount: 1,
  })
  const finalizadas = await f.run((tx) =>
    listEncounters(tx, "org_a", f.patient.id, { status: "finalizada" }),
  )
  expect(finalizadas.items).toEqual([])
})

it("el resumen muestra la atención en curso con lo que le falta para cerrarse", async () => {
  const f = await clinicalFixture()
  const before = await f.run((tx) => getPatientSummary(tx, "org_a", f.patient.id))
  expect(before.openEncounter).toMatchObject({
    id: f.encounter.id,
    diagnosisCount: 0,
    procedureCount: 0,
    missing: ["diagnosis", "evolution"],
  })
  expect(before.pendingConsents).toEqual([])
  await f.ready(f.encounter.id)
  const after = await f.run((tx) => getPatientSummary(tx, "org_a", f.patient.id))
  expect(after.openEncounter).toMatchObject({ diagnosisCount: 1, missing: [] })
})

it("la nota normativa valida signos vitales y el cargo multiplica la cantidad", async () => {
  const f = await clinicalFixture()
  await expect(
    f.run((tx) =>
      updateEncounterDraft(tx, ...f.args, f.encounter.id, { vitals: { presionSistolica: 120 } }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  const updated = await f.run((tx) =>
    updateEncounterDraft(tx, ...f.args, f.encounter.id, {
      presentIllness: "Dolor pulsátil desde hace dos días",
      illnessDuration: "2 días",
      vitals: { presionSistolica: 120, presionDiastolica: 80, temperatura: "36.6" },
      prognosis: "Favorable",
    }),
  )
  expect(updated).toMatchObject({
    illnessDuration: "2 días",
    vitals: { presionSistolica: 120, presionDiastolica: 80, temperatura: 36.6 },
  })
  const proc = await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: f.service.id, quantity: 3 }),
  )
  expect(proc).toMatchObject({ quantity: 3, priceCents: 360000 })
  await f.ready(f.encounter.id)
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(closed.charges.map((c) => c.amountCents)).toEqual([360000])
})

it("una categoría CIE-10 con subcódigos no se registra como diagnóstico", async () => {
  const f = await clinicalFixture()
  await ownerDb
    .insert(cie10Code)
    .values([
      { code: "K04", description: "Enfermedades de la pulpa y de los tejidos periapicales" },
      { code: "K04.0", description: "Pulpitis" },
    ])
    .onConflictDoNothing()
  await expect(
    f.run((tx) =>
      addEncounterDiagnosis(tx, ...f.args, f.encounter.id, {
        cie10Code: "K04",
        diagnosisType: "definitivo",
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
})

it("el perfil profesional no trae título ni colegio por defecto: los escribe la persona", async () => {
  const f = await clinicalFixture()
  const newcomer = `sin-perfil-${randomUUID()}`
  await ownerDb.insert(user).values({ id: newcomer, name: "Sin Perfil", email: `${newcomer}@example.test` })
  await ownerDb
    .insert(member)
    .values({ id: randomUUID(), organizationId: "org_a", userId: newcomer, role: "dentist", createdAt: new Date() })
  expect(await f.run((tx) => getProfessionalProfile(tx, "org_a", newcomer))).toMatchObject({
    professionalTitle: "",
    registrationBody: "",
    registrationNumber: null,
    complete: false,
  })
  // La colegiatura sola no basta: nadie rellena el título ni el colegio de un país.
  await expect(
    f.run((tx) => setProfessionalProfile(tx, "org_a", f.actor, newcomer, { registrationNumber: "777" })),
  ).rejects.toMatchObject({ status: 400 })
  const saved = await f.run((tx) =>
    setProfessionalProfile(tx, "org_a", f.actor, newcomer, {
      professionalTitle: "Odontóloga",
      registrationBody: "COEM",
      registrationNumber: "28-001",
    }),
  )
  expect(saved).toMatchObject({ professionalTitle: "Odontóloga", registrationBody: "COEM", complete: true })
})
