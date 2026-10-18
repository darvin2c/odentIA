/**
 * Reportes › Pacientes: el embudo sigue a las mismas personas y sus pasos son
 * los momentos de Oportunidades; «Cómo nos conoció» es de una lista; «Si
 * vuelven» se cuenta con las citas atendidas. Cada caso arma su propia clínica.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import { clinicalFollowUp, encounter, patient, patientPayment, serviceCatalog, treatmentBudget, treatmentPlan } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createAppointment } from "./appointments.js"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { makeSigner } from "./clinical-test-fixture.js"
import { createOpportunity } from "./opportunities.js"
import { createPatient, nextPatientNumber, updatePatient } from "./patients.js"
import { momentRank } from "./pipelines.js"
import { addPlanItem } from "./plan.js"
import {
  activePatientsMany,
  funnelChannels,
  funnelMany,
  getPatientReportList,
  getReportFunnel,
  getReportPatients,
  returnedMany,
} from "./report-patients.js"
import { budgetAcceptanceMany } from "./report-summary.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

setupTestDb()

/** Lunes 12 de octubre de 2026, 10:00 en Lima. */
const NOW = new Date("2026-10-12T15:00:00Z")
const DAY = 86_400_000

async function clinic() {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `pacientes-${orgId}`)
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro", timezone: "America/Lima" }).returning()
  const [chair] = await ownerDb.insert(scheduleChair).values({ organizationId: orgId, branchId: site!.id, name: "Unidad dental 1" }).returning()
  const actor = randomUUID()
  await ownerDb.insert(user).values({ id: actor, name: "Dra. Ana", email: `${actor}@pacientes.test` })
  await makeSigner(orgId, actor)
  const [service] = await ownerDb
    .insert(serviceCatalog)
    .values({ organizationId: orgId, name: "Evaluación", scope: "general", source: "custom", priceCents: 120_000, currency: "PEN" })
    .returning()
  const person = async (name: string, values: { createdAt?: Date } = {}) => {
    const patientNumber = await nextPatientNumber(ownerDb, orgId)
    const [row] = await insertTestPatients(ownerDb, { organizationId: orgId, displayName: name, patientNumber, ...values })
    return { patientId: row!.id, personId: row!.personId }
  }
  const channel = async (name: string) => {
    const [row] = await ownerDb
      .insert(channelConnection)
      .values({ organizationId: orgId, channel: name, provider: "prueba", displayName: name, configEncrypted: "x", webhookSecret: "y" })
      .returning()
    return row!.id
  }
  /** Una conversación con un mensaje de la persona. */
  const wrote = async (contactId: string, connectionId: string, at: string, status: "open" | "closed" = "closed") => {
    const when = new Date(at)
    const [row] = await ownerDb
      .insert(conversation)
      .values({
        organizationId: orgId,
        contactId,
        channelConnectionId: connectionId,
        externalThreadId: randomUUID(),
        createdAt: when,
        lastInboundAt: when,
        lastMessageAt: when,
        status,
        ...(status === "closed" ? { closedAt: new Date(when.getTime() + 3_600_000), closeReason: "sin_respuesta" } : {}),
      })
      .returning()
    await ownerDb.insert(message).values({ organizationId: orgId, conversationId: row!.id, direction: "in", senderKind: "contact", status: "received", createdAt: when })
  }
  const visit = (patientId: string, startsAt: string, status: string, createdAt?: string) =>
    ownerDb.insert(appointment).values({
      organizationId: orgId,
      branchId: site!.id,
      chairId: chair!.id,
      dentistUserId: actor,
      patientId,
      serviceName: "Evaluación",
      startsAt: new Date(startsAt),
      endsAt: new Date(new Date(startsAt).getTime() + 30 * 60_000),
      durationMin: 30,
      status,
      ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
    })
  return { orgId, run, branchId: site!.id, chairId: chair!.id, actor, service: service!, person, channel, wrote, visit }
}

it("el embudo y Oportunidades dan las mismas cifras: agendar, presentar y aceptar son sus momentos", async () => {
  const c = await clinic()
  // Cinco personas que nos buscaron hoy (las registró recepción), cada una con su interés anotado.
  const people = [await c.person("Ana"), await c.person("Beto"), await c.person("Carla"), await c.person("Diego"), await c.person("Elsa")]
  for (const item of people)
    await c.run((tx) => createOpportunity(tx, c.orgId, { contactId: item.personId, title: "Evaluación", serviceId: c.service.id }, { userId: c.actor }))
  const [, beto, carla, diego, elsa] = people as [(typeof people)[number], ...Array<(typeof people)[number]>]
  let hour = 0
  const book = (patientId: string) => {
    hour += 1
    const startsAt = new Date(Date.now() + 3 * DAY)
    startsAt.setUTCHours(hour + 8, 0, 0, 0)
    return c.run((tx) =>
      createAppointment(tx, c.orgId, c.actor, {
        branchId: c.branchId, chairId: c.chairId, patientId, dentistUserId: c.actor, serviceId: c.service.id,
        startsAt: startsAt.toISOString(), outsideSchedule: true,
      }),
    )
  }
  /** Vino, se le preparó un presupuesto y se le presentó. */
  const present = async (patientId: string) => {
    const booked = await book(patientId)
    await ownerDb.update(appointment).set({ status: "atendida" }).where(eq(appointment.id, booked.id))
    const [session] = await ownerDb.insert(encounter).values({ organizationId: c.orgId, patientId, dentistUserId: c.actor, reason: "Evaluación" }).returning()
    const [plan] = await ownerDb.insert(treatmentPlan).values({ organizationId: c.orgId, patientId, title: "Plan", originEncounterId: session!.id }).returning()
    const item = await c.run((tx) => addPlanItem(tx, c.orgId, c.actor, patientId, { serviceId: c.service.id, planId: plan!.id, sourceEncounterId: session!.id }))
    const budget = await c.run((tx) => createBudget(tx, c.orgId, c.actor, patientId, { planId: plan!.id, itemIds: [item.id] }))
    await c.run((tx) => deliverBudget(tx, c.orgId, c.actor, patientId, budget.id))
    return { budgetId: budget.id, itemId: item.id }
  }
  await book(beto!.patientId)
  await present(carla!.patientId)
  const accepted = await present(diego!.patientId)
  await c.run((tx) => decideBudget(tx, c.orgId, c.actor, diego!.patientId, accepted.budgetId, { decisions: [{ planItemId: accepted.itemId, decision: "aceptado" }] }))
  await ownerDb
    .insert(patientPayment)
    .values({ organizationId: c.orgId, patientId: diego!.patientId, branchId: c.branchId, amountCents: 120_000, currency: "PEN", paidAt: new Date(), methodName: "Efectivo" })
  const rejected = await present(elsa!.patientId)
  await c.run((tx) => decideBudget(tx, c.orgId, c.actor, elsa!.patientId, rejected.budgetId, { decisions: [{ planItemId: rejected.itemId, decision: "rechazado" }] }))

  // Lo que dice Oportunidades: hasta qué momento llegó cada una.
  const opportunities = await ownerDb.execute<{ moment: string; status: string }>(sql`
    select s.moment, o.status from opportunity o join pipeline_stage s on s.id = o.stage_id where o.organization_id = ${c.orgId}`)
  const reached = (moment: string) => opportunities.filter((row) => momentRank(row.moment) >= momentRank(moment)).length
  const today = { start: new Date(Date.now() - DAY), end: new Date(Date.now() + DAY) }
  const [funnel] = await c.run((tx) => funnelMany(tx, c.orgId, [today]))
  expect(funnel).toEqual({
    sought: opportunities.length,
    booked: reached("evaluacion_agendada"),
    // Beto agendó pero todavía no viene.
    came: 3,
    budget: reached("presupuesto_enviado"),
    accepted: opportunities.filter((row) => row.status === "won").length,
    paid: 1,
  })
  expect(funnel).toEqual({ sought: 5, booked: 4, came: 3, budget: 3, accepted: 1, paid: 1 })
  // Las listas tienen tantas personas como su paso, y las que se cayeron, las que faltan.
  const list = (name: "funnel_budget" | "funnel_lost_booked" | "funnel_lost_accepted") =>
    c.run((tx) => getPatientReportList(tx, c.orgId, { period: "este_mes", list: name }))
  expect((await list("funnel_budget")).total).toBe(3)
  expect((await list("funnel_lost_booked")).rows.map((row) => row.personName)).toEqual(["Ana"])
  expect((await list("funnel_lost_accepted")).rows).toHaveLength(2)
  // La aceptación de la pestaña es la del Resumen.
  const tab = await c.run((tx) => getReportPatients(tx, c.orgId, { period: "este_mes" }))
  expect(tab.acceptance.current).toEqual((await c.run((tx) => budgetAcceptanceMany(tx, c.orgId, [tab.period].map((span) => ({ start: new Date(span.start), end: new Date(span.end) })))))[0])
  // Carla espera respuesta, Diego aceptó y Elsa lo rechazó: uno de tres.
  expect(tab.acceptance.current).toEqual({ presented: 3, accepted: 1 })
})

it("el embudo sigue a las mismas personas: quien escribió en agosto y aceptó en octubre cuenta en agosto", async () => {
  const c = await clinic()
  const whatsapp = await c.channel("whatsapp")
  const instagram = await c.channel("instagram")
  // Lucía escribe el 3 de agosto, la registran el 8, viene el 10 y acepta su presupuesto el 2 de octubre.
  const lucia = await c.person("Lucía", { createdAt: new Date("2026-08-08T15:00:00Z") })
  await c.wrote(lucia.personId, whatsapp, "2026-08-03T15:00:00Z")
  await c.visit(lucia.patientId, "2026-08-10T15:00:00Z", "atendida", "2026-08-08T15:00:00Z")
  const [plan] = await ownerDb.insert(treatmentPlan).values({ organizationId: c.orgId, patientId: lucia.patientId, title: "Plan" }).returning()
  await ownerDb.insert(treatmentBudget).values({
    organizationId: c.orgId, patientId: lucia.patientId, planId: plan!.id, budgetNumber: 1, title: "Tratamiento", currency: "PEN",
    status: "aceptado", presentedAt: new Date("2026-09-20T15:00:00Z"), decidedAt: new Date("2026-10-02T15:00:00Z"),
  })
  // Mario pregunta por Instagram en agosto y no vuelve a escribir; Rosa pregunta en septiembre y sigue conversando.
  const [mario] = await ownerDb.insert(contact).values({ organizationId: c.orgId, displayName: "Mario" }).returning()
  await c.wrote(mario!.id, instagram, "2026-08-20T15:00:00Z")
  const rosa = await c.person("Rosa", { createdAt: new Date("2026-09-15T15:00:00Z") })
  await c.wrote(rosa.personId, whatsapp, "2026-09-15T15:00:00Z", "open")
  // Una paciente de siempre que escribe por primera vez en septiembre no nos buscó en septiembre.
  const old = await c.person("Teresa", { createdAt: new Date("2025-03-01T15:00:00Z") })
  await c.visit(old.patientId, "2025-03-05T15:00:00Z", "atendida", "2025-03-01T15:00:00Z")
  await c.wrote(old.personId, whatsapp, "2026-09-18T15:00:00Z")

  const august = await c.run((tx) => getReportPatients(tx, c.orgId, { period: "2026-08" }, NOW))
  expect(august.funnel.current).toEqual({ sought: 2, booked: 1, came: 1, budget: 1, accepted: 1, paid: 0 })
  expect(august.channels).toEqual([
    { channel: "instagram", sought: 1, came: 0 },
    { channel: "whatsapp", sought: 1, came: 1 },
  ])
  // Mario dejó de escribir; agosto terminó hace más de un mes: ya no está abierto.
  expect(august.funnel.stopped).toBe(1)
  expect(august.funnel.open).toBe(false)
  const september = await c.run((tx) => getReportFunnel(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(september.funnel.current).toEqual({ sought: 1, booked: 0, came: 0, budget: 0, accepted: 0, paid: 0 })
  expect(september.funnel.previous.sought).toBe(2)
  expect(september.funnel.open).toBe(true)
  // Rosa sigue conversando: no dejó de escribir.
  const { stopped } = await c.run((tx) => funnelChannels(tx, c.orgId, { start: new Date("2026-09-01T05:00:00Z"), end: new Date("2026-10-01T05:00:00Z") }, NOW))
  expect(stopped).toBe(0)
  const stoppedList = await c.run((tx) => getPatientReportList(tx, c.orgId, { period: "2026-08", list: "funnel_stopped" }, NOW))
  expect(stoppedList.rows).toMatchObject([{ personName: "Mario", patientId: null, personId: mario!.id, channel: "instagram" }])
})

it("«Cómo nos conoció» es de una lista: lo escrito sin elegir queda en «Otro» y otra opción no lleva texto", async () => {
  const c = await clinic()
  const created = await c.run((tx) => createPatient(tx, c.orgId, c.actor, { displayName: "Nora Díaz", referralSource: "por mi prima" }))
  expect(created).toMatchObject({ referralKind: "otro", referralSource: "por mi prima" })
  const changed = await c.run((tx) => updatePatient(tx, c.orgId, c.actor, created.id, { referralKind: "redes_sociales" }))
  expect(changed).toMatchObject({ referralKind: "redes_sociales", referralSource: null })
  await expect(c.run((tx) => updatePatient(tx, c.orgId, c.actor, created.id, { referralKind: "tiktok" }))).rejects.toThrow()
  // La base tampoco guarda un texto fuera de «Otro».
  await expect(
    ownerDb.update(patient).set({ referralKind: "convenio", referralSource: "Empresa X" }).where(eq(patient.id, created.id)),
  ).rejects.toThrow()

  // El gráfico cuenta a los pacientes nuevos del periodo por lo que respondieron.
  const nora = created.id
  await c.visit(nora, "2026-09-10T15:00:00Z", "atendida")
  const [other] = [await c.person("Sin respuesta")]
  await c.visit(other!.patientId, "2026-09-11T15:00:00Z", "atendida")
  const september = await c.run((tx) => getReportPatients(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(september.newPatients.current).toBe(2)
  expect(september.referral).toEqual([
    { kind: "redes_sociales", count: 1 },
    { kind: null, count: 1 },
  ])
})

it("si vuelven: activos en 18 meses, volvieron en el año y sin venir hace más de 6 meses sin nada pendiente", async () => {
  const c = await clinic()
  const [a, b, d, e] = [await c.person("Activa"), await c.person("Volvió"), await c.person("No volvió"), await c.person("Con control")]
  // Volvió: vino hace 18 meses y otra vez hace 2.
  await c.visit(b.patientId, "2025-04-10T15:00:00Z", "atendida")
  await c.visit(b.patientId, "2026-08-10T15:00:00Z", "atendida")
  // No volvió: vino hace 14 meses y nunca más.
  await c.visit(d.patientId, "2025-08-10T15:00:00Z", "atendida")
  // Activa: vino hace un mes.
  await c.visit(a.patientId, "2026-09-10T15:00:00Z", "atendida")
  // Con control: vino hace un año, pero tiene un control pendiente: alguien ya se encarga.
  await c.visit(e.patientId, "2025-09-10T15:00:00Z", "atendida")
  await ownerDb.insert(clinicalFollowUp).values({ organizationId: c.orgId, patientId: e.patientId, kind: "mantenimiento", title: "Control", dueAt: new Date("2026-03-10T15:00:00Z") })

  const end = new Date("2026-10-01T05:00:00Z")
  // Los cuatro vinieron en los 18 meses antes del 1 de octubre (desde el 1 de abril de 2025).
  expect(await c.run((tx) => activePatientsMany(tx, c.orgId, { branch: null, timezone: "America/Lima" }, [end]))).toEqual([4])
  // De los que vinieron de octubre de 2024 a septiembre de 2025, solo «Volvió» vino otra vez en el último año.
  expect(await c.run((tx) => returnedMany(tx, c.orgId, { branch: null, timezone: "America/Lima" }, [end]))).toEqual([{ cohort: 3, returned: 1 }])
  const tab = await c.run((tx) => getReportPatients(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(tab.lapsed.count).toBe(1)
  const lapsed = await c.run((tx) => getPatientReportList(tx, c.orgId, { period: "2026-09", list: "lapsed" }, NOW))
  expect(lapsed.rows.map((row) => row.personName)).toEqual(["No volvió"])
  // Los controles que tocaban y no se hicieron: la lista dice los mismos que la cifra.
  const march = await c.run((tx) => getReportPatients(tx, c.orgId, { period: "2026-03" }, NOW))
  expect(march.controls.current).toMatchObject({ due: 1, came: 0 })
  const missed = await c.run((tx) => getPatientReportList(tx, c.orgId, { period: "2026-03", list: "controls_missed" }, NOW))
  expect(missed.total).toBe(1)
  // Con una sede elegida, lo que no es de una sede lo dice.
  const branchTab = await c.run((tx) => getReportPatients(tx, c.orgId, { period: "2026-09", branchId: c.branchId }, NOW))
  expect(branchTab.wholeClinic).toEqual(["funnel", "channels", "acceptance", "controls"])
})
