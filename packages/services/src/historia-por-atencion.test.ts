/**
 * La ficha legible (QA de la ficha del 8 nov, entrega 4): la Historia agrupada
 * por atención, el precio de lo indicado que es el del presupuesto y la cita
 * que nadie cerró en «Qué sigue».
 */
import { appointment } from "@odentia/db/schema/agenda"
import { appointmentPlanItem, encounter } from "@odentia/db/schema/clinical"
import { consentDocument, consentTemplate } from "@odentia/db/schema/clinical-forms"
import { branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createAppointment, createRoom } from "./appointments.js"
import { adjustBudgetLines, createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { createClinicalOrder } from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { namedDiagnosis } from "./diagnosis-codes.js"
import { getTimeline } from "./patient-history.js"
import { addPlanItem, listPlanItems } from "./plan.js"
import { getPlanNextStep, getPlanNextSteps } from "./plan-next.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const DAY = 86_400_000
const all = () => true
type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Firma la atención del fixture como la deja la app (sin pasar por el cierre). */
async function sign(f: Fixture) {
  const now = new Date()
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", endedAt: now, finalizedAt: now, finalizedBy: f.actor, signerName: "Ana Torres", signerTitle: "Cirujana dentista", signerRegistration: "12345" })
    .where(eq(encounter.id, f.encounter.id))
}

async function consent(f: Fixture, title: string, status: "firmado" | "revocado", encounterId: string | null) {
  const [template] = await ownerDb
    .insert(consentTemplate)
    .values({ organizationId: "org_a", key: `k-${title}`, title, body: "Texto", status: "publicado" })
    .returning()
  const [row] = await ownerDb
    .insert(consentDocument)
    .values({
      organizationId: "org_a",
      templateId: template!.id,
      templateVersion: 1,
      bodySnapshot: "Texto",
      titleSnapshot: title,
      patientId: f.patient.id,
      encounterId,
      signerName: "Ana Pérez",
      representativeRelation: "madre",
      status,
      signedAt: new Date(),
      ...(status === "revocado" ? { revokedAt: new Date(), revokeReason: "Lo pensó mejor" } : {}),
    })
    .returning()
  return row!
}

it("la Historia: lo nacido en una atención va dentro de su tarjeta, una vez; la revocación sigue a la vista", async () => {
  const f = await clinicalFixture()
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  await f.run((tx) =>
    createClinicalOrder(tx, "org_a", f.actor, {
      kind: "imagen",
      patientId: f.patient.id,
      encounterId: f.encounter.id,
      title: "Radiografía panorámica",
      recipient: "Centro de imágenes",
    }),
  )
  await consent(f, "Endodoncia", "firmado", f.encounter.id)
  const revoked = await consent(f, "Exodoncia", "revocado", f.encounter.id)
  await sign(f)

  const { data } = await f.run((tx) => getTimeline(tx, "org_a", f.patient.id))
  // Un solo hecho por atención: el tratamiento, el pedido y el consentimiento van dentro.
  expect(data.map((row) => row.type).sort()).toEqual(["consent", "encounter"])
  expect(data.find((row) => row.type === "consent")).toMatchObject({ id: revoked.id, title: "Revocó: Exodoncia" })
  const card = data.find((row) => row.type === "encounter")
  expect(card?.born).toMatchObject({
    indicated: [{ id: item.id, title: item.title, retired: false }],
    orders: [{ title: "Radiografía panorámica", state: "sin resultado" }],
    consents: [{ title: "Endodoncia", status: "firmado", signerName: "Ana Pérez", relation: "madre" }],
  })
  expect(card?.professionalName).toBe("Clínico")

  // Filtrando «Plan», el tratamiento sale suelto, con un solo estado en palabras.
  const plan = await f.run((tx) => getTimeline(tx, "org_a", f.patient.id, { types: ["plan", "budget", "follow_up"] }))
  const loose = plan.data.find((row) => row.id === item.id)
  expect(loose?.statusText).toBeTruthy()
  expect(loose?.detail ?? "").not.toMatch(/pendiente|en_curso|_/)
})

it("el diagnóstico con su nombre y su código; sin nombre en el catálogo, solo el código", () => {
  const titles = new Map([["ICD-11|DA09.0", "Pulpitis"]])
  expect(namedDiagnosis(titles, "ICD-11", "DA09.0")).toBe("Pulpitis (CIE-11 DA09.0)")
  expect(namedDiagnosis(titles, "ICD-11", "DA08.0")).toBe("CIE-11 · DA08.0")
})

it("lo indicado dice el precio de su presupuesto: el ajustado mientras decide y el acordado al aceptar", async () => {
  const f = await clinicalFixture()
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const before = (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))).find((row) => row.id === item.id)
  // Sin presupuesto, nada que decir: vale el de la indicación.
  expect(before).toMatchObject({ priceCents: 120000, agreedPriceCents: null, agreedCurrency: null })
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) =>
    adjustBudgetLines(tx, ...f.args, budget.id, { lines: [{ planItemId: item.id, priceCents: 90000, reason: "Paciente frecuente" }] }),
  )
  const offered = (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))).find((row) => row.id === item.id)
  expect(offered).toMatchObject({ priceCents: 120000, agreedPriceCents: 90000, agreedCurrency: "PEN" })
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  const agreed = (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))).find((row) => row.id === item.id)
  expect(agreed).toMatchObject({ agreedPriceCents: 90000 })
})

/** Una cita de la persona hace `daysAgo` días, fuera de horario. */
async function pastAppointment(f: Fixture, daysAgo: number, status: "programada" | "atendida", planItemId?: string) {
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede ${daysAgo}-${status}`, timezone: "America/Lima" })
    .returning()
  const room = await f.run((tx) => createRoom(tx, "org_a", { branchId: site!.id, name: "Unidad" }))
  const made = await f.run((tx) =>
    createAppointment(tx, "org_a", f.actor, {
      branchId: site!.id,
      roomId: room.id,
      professionalUserId: f.actor,
      patientId: f.patient.id,
      startsAt: new Date(Date.now() + 2 * DAY).toISOString(),
      durationMin: 30,
      outsideSchedule: true,
      notice: false,
    }),
  )
  const startsAt = new Date(Date.now() - daysAgo * DAY)
  await ownerDb
    .update(appointment)
    .set({ startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), status })
    .where(eq(appointment.id, made.id))
  if (planItemId)
    await ownerDb.insert(appointmentPlanItem).values({ organizationId: "org_a", patientId: f.patient.id, appointmentId: made.id, planItemId })
  return made
}

it("«Qué sigue»: la cita de otro día que nadie cerró va primero con «¿Vino?»; lo aceptado cuya cita se atendió sin registrarlo lo avisa sin frenarlo", async () => {
  const f = await clinicalFixture()
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  // Su cita de hace 5 días lo llevaba, se marcó atendida y nadie registró lo que se hizo.
  await pastAppointment(f, 5, "atendida", item.id)
  const { steps } = await f.run((tx) => getPlanNextSteps(tx, "org_a", f.patient.id, all))
  const schedule = steps.find((step) => step.kind === "agendar")
  // Sigue por reservar (la regla de «Por agendar» es una): la fila lo avisa.
  expect(schedule?.action?.planItemIds).toEqual([item.id])
  expect(schedule?.detail).toMatch(/Su cita del .* se atendió sin registrar .*; pregúntale a Clínico antes de reservar/)

  // Una cita de hace 2 días que nadie cerró: primero en la lista, con «¿Vino?».
  const unclosed = await pastAppointment(f, 2, "programada")
  const listed = await f.run((tx) => getPlanNextSteps(tx, "org_a", f.patient.id, all))
  expect(listed.steps[0]).toMatchObject({
    kind: "cerrar",
    text: expect.stringMatching(/^Su cita del .* quedó sin cerrar$/),
    action: { label: "¿Vino?", appointmentId: unclosed.id },
  })
  // La frase única (Pacientes, el agente) no la dice.
  expect((await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, all))).kind).not.toBe("cerrar")
  // Caja no ve la agenda: no recibe la fila.
  const cashier = (permission: string) => ["patients.read", "finance.read", "budgets.read"].includes(permission)
  const forCashier = await f.run((tx) => getPlanNextSteps(tx, "org_a", f.patient.id, cashier))
  expect(forCashier.steps.some((step) => step.kind === "cerrar")).toBe(false)
})
