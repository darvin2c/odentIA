/**
 * Repaso final de la atención y la ficha (10 nov, entrega 10): los controles del servicio, uno por
 * fecha, cambiar su plazo, «Vino», la cita que quedó sin objeto, lo sumado a una cita y el
 * diagnóstico que sigue sin traer lo resuelto.
 */
import { randomUUID } from "node:crypto"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import {
  clinicalFollowUp,
  clinicalFollowUpItem,
  encounter,
  encounterDiagnosis,
  serviceCatalog,
  treatmentTemplate,
} from "@odentia/db/schema/clinical"
import { consentDocument, consentTemplateService } from "@odentia/db/schema/clinical-forms"
import { branch } from "@odentia/db/schema/org"
import { and, eq, isNull, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  createAppointment,
  getAppointment,
  markAppointmentCame,
  reuseAppointment,
  setAppointmentPlanItems,
} from "./appointments.js"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { createConsentDocument, createConsentTemplate, publishConsentTemplate } from "./clinical-forms.js"
import { clinicalFixture, seedDiagnosisCodes } from "./clinical-test-fixture.js"
import { treatmentConsentStates } from "./consent-state.js"
import { bringTreatmentToEncounter } from "./encounter-visit.js"
import { addEncounterProcedure, finalizeEncounter, getEncounterClosing, voidEncounter } from "./encounters.js"
import { undoFinishControls } from "./finish-controls.js"
import { changeFollowUpDue } from "./follow-ups.js"
import { addPlanItem, revisePlanItem } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const DAY = 86_400_000
type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** El servicio de la clínica pasa a ser de un tratamiento de la biblioteca con esa espera y esos controles. */
async function withGuide(
  f: Fixture,
  guide: { gap?: number; controls?: Array<{ afterDays: number; title: string }> },
) {
  const [template] = await ownerDb
    .insert(treatmentTemplate)
    .values({
      key: `guia-${randomUUID()}`,
      name: "Endodoncia de prueba",
      kind: "endodoncia",
      scope: "tooth",
      sessionGapDays: guide.gap ?? null,
      finishControls: guide.controls ?? [],
    })
    .returning()
  await ownerDb
    .update(serviceCatalog)
    .set({ templateId: template!.id, source: "template", scope: "tooth" })
    .where(eq(serviceCatalog.id, f.service.id))
  return template!
}

/** Un tratamiento aceptado en una pieza, con su presupuesto aceptado. */
async function accepted(f: Fixture, tooth: number | null, sessions = 1) {
  if (tooth)
    await ownerDb
      .update(serviceCatalog)
      .set({ scope: "tooth" })
      .where(eq(serviceCatalog.id, f.service.id))
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
      plannedSessions: sessions,
      ...(tooth ? { toothNumber: tooth } : {}),
    }),
  )
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
    }),
  )
  return item
}

async function attention(f: Fixture): Promise<string> {
  const [row] = await ownerDb
    .insert(encounter)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      professionalUserId: f.actor,
      reason: "Sesión",
    })
    .returning({ id: encounter.id })
  await f.ready(row!.id)
  return row!.id
}

async function booker(f: Fixture) {
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede ${randomUUID()}`, timezone: "America/Lima" })
    .returning()
  await ownerDb
    .insert(scheduleRoom)
    .values({ organizationId: "org_a", branchId: site!.id, name: "Unidad dental 1" })
  const base = new Date(Date.now() + 2 * DAY)
  base.setUTCMinutes(0, 0, 0)
  return (
    days: number,
    planItemIds: string[],
    extra: { followUpIds?: string[]; durationMin?: number } = {},
  ) =>
    f.run((tx) =>
      createAppointment(tx, "org_a", f.actor, {
        patientId: f.patient.id,
        professionalUserId: f.actor,
        branchId: site!.id,
        startsAt: new Date(base.getTime() + days * DAY).toISOString(),
        durationMin: extra.durationMin ?? 30,
        outsideSchedule: true,
        notice: false,
        planItemIds,
        ...(extra.followUpIds ? { followUpIds: extra.followUpIds } : {}),
      }),
    )
}

it("B4 y B5: dos endodoncias del mismo día dejan un solo control del año que nombra las dos piezas; deshacer una la saca", async () => {
  const f = await clinicalFixture()
  await withGuide(f, {
    gap: 7,
    controls: [{ afterDays: 365, title: "Control radiográfico de la endodoncia" }],
  })
  const a = await accepted(f, 46)
  const b = await accepted(f, 36)
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: a.id }))
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: b.id }))
  // El cierre anuncia uno solo, con las dos piezas.
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(closing.controls.finishing.map((row) => row.title)).toEqual([
    "Control radiográfico de la endodoncia · piezas 46 y 36",
  ])
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const open = await ownerDb
    .select()
    .from(clinicalFollowUp)
    .where(
      and(eq(clinicalFollowUp.patientId, f.patient.id), eq(clinicalFollowUp.status, "pendiente")),
    )
  const yearly = open.filter((row) => row.finishAfterDays === 365)
  expect(yearly).toHaveLength(1)
  expect(yearly[0]!.title).toBe("Control radiográfico de la endodoncia · piezas 46 y 36")
  const items = await ownerDb
    .select()
    .from(clinicalFollowUpItem)
    .where(eq(clinicalFollowUpItem.followUpId, yearly[0]!.id))
  expect(items.map((row) => row.planItemId).sort()).toEqual([a.id, b.id].sort())
  // Deshacer la de la 46 la saca del control: queda el de la 36.
  await f.run((tx) =>
    undoFinishControls(tx, {
      orgId: "org_a",
      actorUserId: f.actor,
      patientId: f.patient.id,
      planItemId: a.id,
      reason: "Era otra pieza",
      at: new Date(),
    }),
  )
  const [after] = await ownerDb
    .select()
    .from(clinicalFollowUp)
    .where(eq(clinicalFollowUp.id, yearly[0]!.id))
  expect(after).toMatchObject({
    status: "pendiente",
    title: "Control radiográfico de la endodoncia · pieza 36",
    planItemId: b.id,
  })
})

it("B5: el cierre dice el control que va a quedar y quien firma lo cambia de fecha para esta persona; después, «Cambiar fecha» lo mueve y el reservado no", async () => {
  const f = await clinicalFixture()
  await withGuide(f, { controls: [{ afterDays: 365, title: "Control radiográfico" }] })
  const endo = await accepted(f, 46, 2)
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: endo.id }))
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const second = await attention(f)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, second, { planItemId: endo.id }))
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, second))
  const left = closing.controls.finishing[0]!
  expect(left).toMatchObject({ title: "Control radiográfico · pieza 46", afterDays: 365 })
  const lima = (date: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(date)
  const sixMonths = lima(new Date(Date.now() + 180 * DAY))
  await f.run((tx) =>
    finalizeEncounter(tx, ...f.args, second, {
      finishControlChanges: [{ key: left.key, dueDay: sixMonths }],
    }),
  )
  const [control] = await ownerDb
    .select()
    .from(clinicalFollowUp)
    .where(
      and(eq(clinicalFollowUp.patientId, f.patient.id), eq(clinicalFollowUp.finishAfterDays, 365)),
    )
  expect(lima(control!.dueAt)).toBe(sixMonths)
  // Después de firmar: «Cambiar fecha», desde mañana; hoy no.
  const nine = lima(new Date(Date.now() + 270 * DAY))
  await f.run((tx) => changeFollowUpDue(tx, ...f.args, control!.id, { dueAt: nine }))
  const [moved] = await ownerDb
    .select()
    .from(clinicalFollowUp)
    .where(eq(clinicalFollowUp.id, control!.id))
  expect(lima(moved!.dueAt)).toBe(nine)
  await expect(
    f.run((tx) => changeFollowUpDue(tx, ...f.args, control!.id, { dueAt: lima(new Date()) })),
  ).rejects.toMatchObject({
    fields: { dueAt: expect.stringMatching(/desde mañana/) },
  })
})

it("B5: quitar en el cierre un control que va a quedar lo deja cancelado; la próxima atención lo lista entre los abiertos si se queda", async () => {
  const f = await clinicalFixture()
  await withGuide(f, {
    controls: [
      { afterDays: 30, title: "Control de la resina" },
      { afterDays: 365, title: "Control del año" },
    ],
  })
  const item = await accepted(f, 46)
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  const month = closing.controls.finishing.find((row) => row.afterDays === 30)!
  await f.run((tx) =>
    finalizeEncounter(tx, ...f.args, f.encounter.id, {
      finishControlChanges: [{ key: month.key, remove: true }],
    }),
  )
  const rows = await ownerDb
    .select()
    .from(clinicalFollowUp)
    .where(eq(clinicalFollowUp.patientId, f.patient.id))
  expect(rows.find((row) => row.finishAfterDays === 30)).toMatchObject({
    status: "cancelado",
    cancelledReason: "Quitado al firmar la atención",
  })
  const next = await attention(f)
  const open = (await f.run((tx) => getEncounterClosing(tx, ...f.args, next))).controls.open
  expect(open.map((row) => row.title)).toEqual(["Control del año · pieza 46"])
})

it("B1: «Vino» deja atendida una cita pasada sin abrir otra atención; su control vuelve a pendiente", async () => {
  const f = await clinicalFixture()
  const book = await booker(f)
  const booked = await book(1, [])
  // Ya pasó: se corre su hora a ayer.
  await ownerDb
    .update(appointment)
    .set({ startsAt: new Date(Date.now() - DAY), endsAt: new Date(Date.now() - DAY + 30 * 60_000) })
    .where(eq(appointment.id, booked.id))
  const came = await f.run((tx) => markAppointmentCame(tx, "org_a", f.actor, booked.id))
  expect(came.status).toBe("atendida")
  const encounters = await ownerDb
    .select({ id: encounter.id })
    .from(encounter)
    .where(eq(encounter.appointmentId, booked.id))
  expect(encounters).toHaveLength(0)
  // Una cita por venir no se marca «Vino».
  const later = await book(3, [])
  await expect(
    f.run((tx) => markAppointmentCame(tx, "org_a", f.actor, later.id)),
  ).rejects.toMatchObject({ code: "APPOINTMENT_NOT_YET" })
})

it("M1: la cita reservada para la sesión 2 que se hizo antes queda sin objeto: el cierre la dice y se usa para lo que sigue", async () => {
  const f = await clinicalFixture()
  const endo = await accepted(f, 46, 2)
  const crown = await accepted(f, 46)
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: endo.id }))
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const book = await booker(f)
  const forSession2 = await book(5, [endo.id])
  // Vuelve antes: la sesión 2 se hace hoy, en otra atención.
  const second = await attention(f)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, second, { planItemId: endo.id }))
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, second))
  expect(closed.freedAppointments.map((row) => row.id)).toEqual([forSession2.id])
  // Ya no dice «sesión 3 (2 previstas)».
  expect((await f.run((tx) => getAppointment(tx, "org_a", forSession2.id))).sessions).toEqual([])
  const reused = await f.run((tx) =>
    reuseAppointment(tx, "org_a", f.actor, forSession2.id, {
      expectedVersion: closed.freedAppointments[0]!.version,
      planItemId: crown.id,
    }),
  )
  expect(reused.brings?.map((row) => row.planItemId)).toEqual([crown.id])
})

it("M3: lo sumado a una cita se ve en ella aunque sea de una sesión, con los minutos que necesita si no cabe", async () => {
  const f = await clinicalFixture()
  await ownerDb
    .update(serviceCatalog)
    .set({ durationMin: 60 })
    .where(eq(serviceCatalog.id, f.service.id))
  const resin = await accepted(f, 36)
  const book = await booker(f)
  const visit = await book(2, [])
  const summed = await f.run((tx) =>
    setAppointmentPlanItems(tx, "org_a", f.actor, visit.id, {
      expectedVersion: visit.version,
      add: [resin.id],
    }),
  )
  expect(summed.brings?.map((row) => row.planItemId)).toEqual([resin.id])
  expect(summed.needsMinutes).toBe(90)
})

it("B3: lo aceptado se reserva sin esperar al control; el control va en la cita solo si cae en su ventana", async () => {
  const f = await clinicalFixture()
  const crown = await accepted(f, 46)
  const [control] = await ownerDb
    .insert(clinicalFollowUp)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      kind: "mantenimiento",
      title: "Control de la endodoncia",
      dueAt: new Date(Date.now() + 30 * DAY),
    })
    .returning()
  const book = await booker(f)
  const early = await book(1, [crown.id], { followUpIds: [control!.id] })
  expect(early.controlsLeftOut?.map((row) => row.id)).toEqual([control!.id])
  const [still] = await ownerDb
    .select()
    .from(clinicalFollowUp)
    .where(eq(clinicalFollowUp.id, control!.id))
  expect(still!.status).toBe("pendiente")
})

it("A2: «Continuar hoy» la corona no trae la pulpitis que la endodoncia resolvió", async () => {
  const f = await clinicalFixture()
  const crown = await accepted(f, 46)
  await seedDiagnosisCodes([{ code: "K04.0", title: "Pulpitis" }])
  // En la atención donde se indicó: la pulpitis de la 46, ya resuelta.
  await ownerDb.insert(encounterDiagnosis).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    encounterId: f.encounter.id,
    diagnosisSystem: "ICD-10-PE",
    diagnosisCode: "K04.0",
    diagnosisType: "confirmed",
    siteSystem: crown.siteSystem,
    siteCode: crown.siteCode,
    status: "resuelto",
  })
  await ownerDb.execute(
    sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${f.encounter.id}`,
  )
  const today = await attention(f)
  const brought = await f.run((tx) => bringTreatmentToEncounter(tx, ...f.args, today, crown.id))
  expect(brought.diagnosisAdded).toBe(false)
  const added = await ownerDb
    .select()
    .from(encounterDiagnosis)
    .where(and(eq(encounterDiagnosis.encounterId, today), isNull(encounterDiagnosis.voidedAt)))
  // La atención de hoy ya tenía el suyo (`ready`); la pulpitis resuelta no se suma.
  expect(added.filter((row) => row.diagnosisCode === "K04.0")).toHaveLength(0)
})

/** Un consentimiento publicado que pide el servicio del fixture. */
async function serviceAsksConsent(f: Fixture) {
  const draft = await f.run((tx) =>
    createConsentTemplate(tx, "org_a", f.actor, {
      key: `t-${randomUUID().slice(0, 8)}`,
      title: "Endodoncia",
      sections: { procedure: "Tratamiento de conductos.", benefits: ["Conservar la pieza"], risks: ["Dolor"], alternatives: ["Exodoncia"], consequences: "Puede avanzar." },
    }),
  )
  const template = await f.run((tx) => publishConsentTemplate(tx, "org_a", f.actor, draft.id))
  await ownerDb.insert(consentTemplateService).values({ organizationId: "org_a", templateKey: template.key, serviceId: f.service.id })
  return template
}

it("consentimientos: el estado va con el tratamiento; «Cambiar» la pieza anula lo pendiente y anular otra atención no lo toca", async () => {
  const f = await clinicalFixture()
  const template = await serviceAsksConsent(f)
  const item = await accepted(f, 46)
  const state = async (id: string) => (await f.run((tx) => treatmentConsentStates(tx, "org_a", [id]))).get(id)
  expect(await state(item.id)).toBe("falta")
  await ownerDb.execute(
    sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${f.encounter.id}`,
  )
  // Preparado en otra atención, la de hoy: sigue al tratamiento.
  const today = await attention(f)
  const doc = await f.run((tx) =>
    createConsentDocument(tx, "org_a", f.actor, { templateId: template.id, patientId: f.patient.id, encounterId: today, planItemId: item.id, procedureRef: "Endodoncia de la pieza 46" }),
  )
  expect(await state(item.id)).toBe("sin_firmar")
  // Anular la atención donde se preparó no anula el de un tratamiento que sigue.
  await f.run((tx) => voidEncounter(tx, ...f.args, today, { reason: "Prueba" }))
  const [kept] = await ownerDb.select({ status: consentDocument.status }).from(consentDocument).where(eq(consentDocument.id, doc.id))
  expect(kept?.status).toBe("pendiente")
  // «Cambiar» la pieza: el texto ya no es el suyo; se prepara otra vez.
  const next = await attention(f)
  const changed = await f.run((tx) =>
    revisePlanItem(tx, ...f.args, item.id, { encounterId: next, reason: "Era la 36", serviceId: f.service.id, toothNumber: 36 }),
  )
  const [reset] = await ownerDb.select({ status: consentDocument.status }).from(consentDocument).where(eq(consentDocument.id, doc.id))
  expect(reset?.status).not.toBe("pendiente")
  expect(await state(changed.id)).toBe("falta")
})
