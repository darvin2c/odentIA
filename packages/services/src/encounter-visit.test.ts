/**
 * «Hoy viene a…» (QA de la atención del 8 nov, propuesta 4.1): sin cita, la
 * atención sabe a qué viene la persona (su sesión 2, su control) y un toque la
 * prepara; «sesión N de M» cuenta la de hoy; el consentimiento es de lo que se
 * hace hoy; «Quitar» corrige lo indicado hoy sin ensuciar el Plan; y el
 * presupuesto se dice en una línea honesta.
 */

import { randomUUID } from "node:crypto"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { clinicalFollowUp, encounter, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import {
  createConsentTemplate,
  getEncounterConsentNeeds,
  prepareEncounterConsents,
  publishConsentTemplate,
  setConsentTemplateServices,
} from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { removeIndicatedFromEncounter } from "./encounter-plan-remove.js"
import {
  bringTreatmentToEncounter,
  chooseVisitControl,
  leaveTreatmentFromEncounter,
} from "./encounter-visit.js"
import {
  addEncounterProcedure,
  finalizeEncounter,
  getEncounterClosing,
  getEncounterDetail,
} from "./encounters.js"
import { budgetLine } from "./plan-next.js"
import { addPlanItem, listPlanItems } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Un tratamiento de `sessions` sesiones, aceptado en su presupuesto. */
async function accepted(f: Fixture, sessions: number) {
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
      plannedSessions: sessions,
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

/** La primera atención queda firmada (como en las demás pruebas de sesiones) y abre otra sin cita, sin motivo. */
async function secondVisit(f: Fixture): Promise<string> {
  await ownerDb.execute(
    sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${f.encounter.id}`,
  )
  const [row] = await ownerDb
    .insert(encounter)
    .values({ organizationId: "org_a", patientId: f.patient.id, professionalUserId: f.actor })
    .returning({ id: encounter.id })
  return row!.id
}

it("«Hoy viene a…» dice que la corona va después de la endodoncia en curso de su pieza, y la deja como segunda opción (entrega 8)", async () => {
  const f = await clinicalFixture()
  await f.ready(f.encounter.id)
  const endo = await accepted(f, 2)
  const corona = await accepted(f, 1)
  // La endodoncia y la corona en la 46, cada una en su fase; la sesión 1 de la endodoncia ya se hizo.
  await ownerDb
    .update(treatmentPlanItem)
    .set({ siteSystem: "FDI", siteCode: "46", phase: "basica" })
    .where(eq(treatmentPlanItem.id, endo.id))
  await ownerDb
    .update(treatmentPlanItem)
    .set({ siteSystem: "FDI", siteCode: "46", phase: "rehabilitadora" })
    .where(eq(treatmentPlanItem.id, corona.id))
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: endo.id }))
  const today = await secondVisit(f)
  const visit = (await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, today))).visit
  // Antes: «Corona · Aceptado, sin empezar [Hacerla hoy]», sin decir que va después.
  expect(visit?.treatments.map((row) => [row.planItemId, row.after])).toEqual([
    [endo.id, null],
    [corona.id, { title: endo.title, today: false }],
  ])
  // Traída la endodoncia a hoy, la corona dice que va después de lo de hoy.
  await f.run((tx) => bringTreatmentToEncounter(tx, ...f.args, today, endo.id))
  const again = (await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, today))).visit
  expect(again?.treatments.find((row) => row.planItemId === corona.id)?.after).toEqual({
    title: endo.title,
    today: true,
  })
})

it("sin cita, la sesión 2 viene a la atención: «Continuar hoy» la trae con motivo y diagnóstico, y cuenta la de hoy", async () => {
  const f = await clinicalFixture()
  await f.ready(f.encounter.id)
  const item = await accepted(f, 2)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  const today = await secondVisit(f)
  const detail = () => f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, today))

  // Antes no decía nada: la atención salía en blanco.
  expect((await detail()).visit?.treatments).toEqual([
    expect.objectContaining({
      planItemId: item.id,
      n: 2,
      m: 2,
      started: true,
      linked: false,
      registered: false,
    }),
  ])

  const brought = await f.run((tx) => bringTreatmentToEncounter(tx, ...f.args, today, item.id))
  expect(brought).toEqual({ reasonSet: true, diagnosisAdded: true })
  const after = await detail()
  expect(after.encounter.reason).toBe("Continúa: Tratamiento propio")
  // El diagnóstico que sigue, con su tipo: no se sube a definitivo ni se inventa.
  expect(after.diagnoses.filter((dx) => !dx.voidedAt)).toEqual([
    expect.objectContaining({ diagnosisType: "confirmed" }),
  ])
  expect(after.visit?.treatments[0]).toMatchObject({ linked: true, registered: false, n: 2 })
  expect(after.plannedItems.map((row) => row.id)).toEqual([item.id])
  // Traído y sin registrar: el cierre lo avisa aunque no haya cita.
  const closing = await f.run((tx) =>
    getEncounterClosing(tx, "org_a", f.actor, f.patient.id, today),
  )
  expect(closing.sessions.notRegistered).toEqual([
    expect.objectContaining({ planItemId: item.id, n: 2, m: 2 }),
  ])

  // Registrada la sesión de hoy, «sesión 2 de 2» (antes decía «sesión 1 de 2»).
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, today, { planItemId: item.id }))
  const done = await detail()
  expect(done.plannedItems[0]).toMatchObject({ sessionsDone: 2 })
  expect(done.visit?.treatments[0]).toMatchObject({ registered: true, n: 2 })
  // Con su sesión registrada ya no se saca de la atención.
  await expect(
    f.run((tx) => leaveTreatmentFromEncounter(tx, ...f.args, today, item.id)),
  ).rejects.toMatchObject({
    code: "SESSION_REGISTERED",
  })
})

it("«Hoy no» saca lo traído y el motivo escrito no se pisa", async () => {
  const f = await clinicalFixture()
  await f.ready(f.encounter.id)
  const item = await accepted(f, 2)
  const today = await secondVisit(f)
  await ownerDb
    .update(encounter)
    .set({ reason: "Dolor en otra pieza" })
    .where(eq(encounter.id, today))
  const brought = await f.run((tx) => bringTreatmentToEncounter(tx, ...f.args, today, item.id))
  expect(brought.reasonSet).toBe(false)
  await f.run((tx) => leaveTreatmentFromEncounter(tx, ...f.args, today, item.id))
  const detail = await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, today))
  expect(detail.encounter.reason).toBe("Dolor en otra pieza")
  expect(detail.plannedItems).toEqual([])
  expect(detail.visit?.treatments[0]).toMatchObject({ linked: false, n: 1, started: false })
})

it("«Viene a su control» de otro doctor queda marcado en el cierre y se cumple al firmar", async () => {
  const f = await clinicalFixture()
  const today = await secondVisit(f)
  await f.ready(today)
  const [control] = await ownerDb
    .insert(clinicalFollowUp)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      kind: "mantenimiento",
      title: "Limpieza y control",
      dueAt: new Date(Date.now() - 180 * 86_400_000),
      // Lo indicó otro doctor hace un año, para dentro de seis meses: hoy está vencido.
      createdAt: new Date(Date.now() - 360 * 86_400_000),
    })
    .returning()
  const visit = (await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, today))).visit
  expect(visit?.controls).toEqual([
    expect.objectContaining({ id: control!.id, overdue: true, chosen: false }),
  ])
  const closingBefore = await f.run((tx) =>
    getEncounterClosing(tx, "org_a", f.actor, f.patient.id, today),
  )
  expect(closingBefore.controls.due).toEqual([
    expect.objectContaining({ id: control!.id, mine: false, chosen: false }),
  ])

  const chose = await f.run((tx) => chooseVisitControl(tx, ...f.args, today, control!.id))
  expect(chose.reasonSet).toBe(true)
  const closing = await f.run((tx) =>
    getEncounterClosing(tx, "org_a", f.actor, f.patient.id, today),
  )
  expect(closing.controls.due).toEqual([expect.objectContaining({ id: control!.id, chosen: true })])
  // Elegir no lo cumple: sigue pendiente hasta firmar.
  const [still] = await ownerDb
    .select()
    .from(clinicalFollowUp)
    .where(eq(clinicalFollowUp.id, control!.id))
  expect(still!.status).toBe("pendiente")

  await f.run((tx) => finalizeEncounter(tx, ...f.args, today, { nextControl: { none: true } }))
  const [fulfilled] = await ownerDb
    .select()
    .from(clinicalFollowUp)
    .where(eq(clinicalFollowUp.id, control!.id))
  expect(fulfilled).toMatchObject({ status: "realizado", completedEncounterId: today })
})

it("el consentimiento es de lo que se hace hoy: lo indicado para otro día no lo pide; traído o hecho, sí", async () => {
  const f = await clinicalFixture()
  const created = await f.run((tx) =>
    createConsentTemplate(tx, "org_a", f.actor, {
      key: `t-${randomUUID().slice(0, 8)}`,
      title: "Tratamiento propio",
      sections: {
        procedure: "El tratamiento con anestesia local.",
        benefits: ["Quitar el dolor"],
        risks: ["Dolor los primeros días"],
        alternatives: ["Otro tratamiento"],
        consequences: "Puede avanzar.",
      },
    }),
  )
  await f.run((tx) => publishConsentTemplate(tx, "org_a", f.actor, created.id))
  await f.run((tx) => setConsentTemplateServices(tx, "org_a", f.actor, created.id, [f.service.id]))
  const needs = () =>
    f.run((tx) => getEncounterConsentNeeds(tx, "org_a", f.patient.id, f.encounter.id))
  // Indicado hoy para más adelante (la corona de dentro de semanas): no pide nada todavía.
  const item = await accepted(f, 1)
  expect(await needs()).toEqual([])
  // Se hace hoy: lo pide.
  await f.run((tx) => bringTreatmentToEncounter(tx, ...f.args, f.encounter.id, item.id))
  expect((await needs()).map((need) => need.title)).toEqual(["Tratamiento propio"])
  // Preparado y después «Hoy no»: queda en Documentos, pero ya no falta al cerrar.
  await f.run((tx) => prepareEncounterConsents(tx, ...f.args, f.encounter.id))
  await f.run((tx) => leaveTreatmentFromEncounter(tx, ...f.args, f.encounter.id, item.id))
  expect(await needs()).toEqual([])
})

it("«Quitar» lo indicado hoy sin respuesta: sale del plan y del presupuesto en borrador; lo ya respondido no", async () => {
  const f = await clinicalFixture()
  const indicated = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
    }),
  )
  const kept = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
    }),
  )
  await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [indicated.id, kept.id] }),
  )
  const detail = await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, f.encounter.id))
  expect(detail.indicatedItems.map((row) => row.removable)).toEqual([true, true])

  await f.run((tx) => removeIndicatedFromEncounter(tx, ...f.args, f.encounter.id, indicated.id))
  const [row] = await ownerDb
    .select()
    .from(treatmentPlanItem)
    .where(eq(treatmentPlanItem.id, indicated.id))
  expect(row).toMatchObject({ status: "cancelado", budgetId: null })
  // El Plan de la persona no lo lista: fue corregir el borrador.
  const plan = await f.run((tx) =>
    listPlanItems(tx, "org_a", f.patient.id, undefined, { withoutVoided: true }),
  )
  expect(plan.map((item) => item.id)).toEqual([kept.id])

  // Ya entregado, no se quita desde la atención.
  const [{ id: budgetId } = { id: "" }] = await ownerDb
    .select({ id: treatmentPlanItem.budgetId })
    .from(treatmentPlanItem)
    .where(eq(treatmentPlanItem.id, kept.id))
    .then((rows) => rows.map((r) => ({ id: r.id ?? "" })))
  await f.run((tx) => deliverBudget(tx, ...f.args, budgetId))
  await expect(
    f.run((tx) => removeIndicatedFromEncounter(tx, ...f.args, f.encounter.id, kept.id)),
  ).rejects.toMatchObject({
    code: "NOT_REMOVABLE",
  })
})

it("el presupuesto en una línea: cada opción con su total y «falta que elija»; elegida, «Eligió la opción A»", () => {
  const option = (position: number, cents: number, decision = "pendiente") => ({
    id: `o${position}`,
    position,
    label: `Opción ${String.fromCharCode(64 + position)}`,
    name: null,
    pros: null,
    cons: null,
    isRecommended: position === 1,
    decision,
    lineCount: 1,
    totals: [{ currency: "PEN", totalCents: cents }],
    totalCents: cents,
    acceptedCents: null,
    tariffTotalCents: null,
    discountCents: null,
  })
  const budget = (options: ReturnType<typeof option>[]) =>
    ({
      options,
      items: [{}, {}, {}],
      totals: [{ currency: "PEN", totalCents: 135_000 }],
    }) as unknown as Parameters<typeof budgetLine>[0]
  const two = budgetLine(budget([option(1, 135_000), option(2, 15_000)]), "es-PE")
  expect(two).toMatch(/^Opción A S\/\s?1,350\.00 · Opción B S\/\s?150\.00 · falta que elija$/)
  const chosen = budgetLine(
    budget([option(1, 135_000, "elegida"), option(2, 15_000, "no_elegida")]),
    "es-PE",
  )
  expect(chosen).toMatch(/^Eligió la opción A · S\/\s?1,350\.00$/)
})

it("«Hacerla hoy» de lo que aún no empezó no arrastra el diagnóstico de otro, y «Hoy no» se lleva el motivo que puso", async () => {
  const f = await clinicalFixture()
  await f.ready(f.encounter.id)
  const item = await accepted(f, 2)
  const today = await secondVisit(f)
  const brought = await f.run((tx) => bringTreatmentToEncounter(tx, ...f.args, today, item.id))
  // Sin empezar: el diagnóstico de la atención donde se indicó no se copia (la corona no hereda la pulpitis).
  expect(brought).toEqual({ reasonSet: true, diagnosisAdded: false })
  await f.run((tx) => leaveTreatmentFromEncounter(tx, ...f.args, today, item.id))
  const detail = await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, today))
  expect(detail.encounter.reason).toBeNull()
  expect(detail.diagnoses).toEqual([])
})

it("el control reservado en la cita de hoy sigue a la vista y el cierre dice cuál se cumple (QA del 9 nov, repaso 3)", async () => {
  const f = await clinicalFixture()
  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}` }).returning()
  const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: "org_a", branchId: site!.id, name: "Unidad 1" }).returning()
  const startsAt = new Date()
  const [visitAt] = await ownerDb
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
      status: "confirmada",
      reason: "Limpieza y control",
    })
    .returning()
  // El control lo indicó la atención de antes y quedó reservado en la cita de hoy.
  const [control] = await ownerDb
    .insert(clinicalFollowUp)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      kind: "mantenimiento",
      title: "Limpieza y control",
      dueAt: new Date(Date.now() - 30 * 86_400_000),
      status: "programado",
      appointmentId: visitAt!.id,
      originEncounterId: f.encounter.id,
    })
    .returning()
  const today = await secondVisit(f)
  await ownerDb.update(encounter).set({ appointmentId: visitAt!.id }).where(eq(encounter.id, today))
  const visit = (await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, today))).visit
  expect(visit?.controls).toEqual([
    expect.objectContaining({ id: control!.id, chosen: true, byAppointment: true }),
  ])
  const closing = await f.run((tx) => getEncounterClosing(tx, "org_a", f.actor, f.patient.id, today))
  expect(closing.controls.byAppointment).toEqual([
    expect.objectContaining({ id: control!.id, title: "Limpieza y control" }),
  ])
})
