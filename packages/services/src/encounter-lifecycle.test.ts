import { randomUUID } from "node:crypto"
import { user } from "@odentia/db/schema/auth"
import { cie10Code, odontogramEntry, patientCharge } from "@odentia/db/schema/clinical"
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
  takeOverEncounter,
  updateEncounterDraft,
  voidEncounter,
  voidEncounterProcedure,
} from "./encounters.js"
import { createFollowUp, listFollowUps, scheduleFollowUp } from "./follow-ups.js"
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
