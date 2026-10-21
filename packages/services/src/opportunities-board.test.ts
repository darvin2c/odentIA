import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { expect, it } from "vitest"
import { createContact } from "./contacts.js"
import { createOpportunity, closeOpportunity, getOpportunitySummary, listOpportunities, moveOpportunity } from "./opportunities.js"
import { ensureDefaultPipeline } from "./pipelines.js"
import { appDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const TAG = randomUUID().slice(0, 8)

async function contactNamed(name: string) {
  return withOrgContext(appDb, "org_a", (tx) => createContact(tx, "org_a", { displayName: `${name} ${TAG}` }))
}

it("tablero: el resumen separa ganadas y perdidas por paso, y suma el valor de lo ganado", async () => {
  const c = await contactNamed("Resumen ganadas")
  const pipe = await withOrgContext(appDb, "org_a", (tx) => ensureDefaultPipeline(tx, "org_a"))
  const decided = pipe.stages.find((st) => st.moment === "decidio")!
  const won = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: c.id, title: `Ganada ${TAG}`, amountCents: 80000 }),
  )
  await withOrgContext(appDb, "org_a", (tx) => closeOpportunity(tx, "org_a", won.id, { outcome: "won", reason: "acepto" }))
  const lost = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: c.id, title: `Perdida ${TAG}`, amountCents: 30000 }),
  )
  await withOrgContext(appDb, "org_a", (tx) => closeOpportunity(tx, "org_a", lost.id, { outcome: "lost", reason: "no_lo_necesita" }))
  await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: c.id, title: `Abierta ${TAG}`, amountCents: 10000 }),
  )

  const summary = await withOrgContext(appDb, "org_a", (tx) => getOpportunitySummary(tx, "org_a", { contactId: c.id, recent: true }))
  expect(summary.won).toBe(1)
  expect(summary.lost).toBe(1)
  const stage = summary.stages.find((entry) => entry.stageId === decided.id)!
  expect(stage.won).toBe(1)
  expect(stage.lost).toBe(1)
  // Lo ganado suma en su moneda; lo perdido no suma valor.
  const wonCents = stage.wonAmounts.reduce((total, entry) => total + BigInt(entry.amountCents), 0n)
  expect(wonCents).toBe(80000n)
  // Lo abierto sigue sumando solo lo abierto.
  expect(summary.openAmounts.reduce((total, entry) => total + BigInt(entry.amountCents), 0n)).toBe(10000n)
})

it("tablero: «Movidas por el agente» muestra solo lo que el agente creó o movió", async () => {
  const c = await contactNamed("Movidas por el agente")
  const pipe = await withOrgContext(appDb, "org_a", (tx) => ensureDefaultPipeline(tx, "org_a"))
  const second = pipe.stages.find((st) => st.moment === "evaluacion_agendada")!
  const byAgent = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: c.id, title: `Del agente ${TAG}` }, { userId: null, origin: "agente" }),
  )
  const byHand = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: c.id, title: `De la clínica ${TAG}` }),
  )
  await withOrgContext(appDb, "org_a", (tx) => moveOpportunity(tx, "org_a", byHand.id, second.id, { userId: null, origin: "automatico" }))

  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    listOpportunities(tx, "org_a", { contactId: c.id, byAgent: true }),
  )
  expect(rows.items.map((item) => item.id)).toEqual([byAgent.id])
  expect(rows.items[0]?.lastOrigin).toBe("agente")
})

it("tablero: lo que movió el agente con una cita se dice con su nombre y su fecha", async () => {
  const c = await contactNamed("Cita del agente")
  const pipe = await withOrgContext(appDb, "org_a", (tx) => ensureDefaultPipeline(tx, "org_a"))
  const second = pipe.stages.find((st) => st.moment === "evaluacion_agendada")!
  const opp = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: c.id, title: `Evaluación ${TAG}` }, { userId: null, origin: "agente" }),
  )
  const startsAt = new Date(Date.now() + 24 * 3600_000)
  await withOrgContext(appDb, "org_a", (tx) =>
    moveOpportunity(tx, "org_a", opp.id, second.id, { userId: null, origin: "agente", cause: "cita_agendada", causeAt: startsAt }),
  )
  const [item] = (await withOrgContext(appDb, "org_a", (tx) => listOpportunities(tx, "org_a", { contactId: c.id }))).items
  expect(item?.lastOrigin).toBe("agente")
  expect(item?.why).toMatch(/^Sofi le agendó la evaluación para /)
})

it("tablero: «Pasó sola» dice quién agendó la cita: la persona desde su enlace o el equipo", async () => {
  const c = await contactNamed("Quién agendó")
  const pipe = await withOrgContext(appDb, "org_a", (tx) => ensureDefaultPipeline(tx, "org_a"))
  const second = pipe.stages.find((st) => st.moment === "evaluacion_agendada")!
  const startsAt = new Date(Date.now() + 48 * 3600_000)
  const viaLink = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: c.id, title: `Por enlace ${TAG}` }),
  )
  const viaDesk = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: c.id, title: `Por recepción ${TAG}` }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    moveOpportunity(tx, "org_a", viaLink.id, second.id, { userId: null, origin: "automatico", cause: "cita_enlace", causeAt: startsAt }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    moveOpportunity(tx, "org_a", viaDesk.id, second.id, { userId: null, origin: "automatico", cause: "cita_recepcion", causeAt: startsAt }),
  )
  const { items } = await withOrgContext(appDb, "org_a", (tx) => listOpportunities(tx, "org_a", { contactId: c.id }))
  expect(items.find((item) => item.id === viaLink.id)?.why).toMatch(/^Pasó sola: la agendó desde su enlace para /)
  expect(items.find((item) => item.id === viaDesk.id)?.why).toMatch(/^Pasó sola: el equipo le agendó la evaluación para /)
})

it("tablero: lo que presentó el agente se dice con su nombre, como en el historial", async () => {
  const c = await contactNamed("Presupuesto del agente")
  const pipe = await withOrgContext(appDb, "org_a", (tx) => ensureDefaultPipeline(tx, "org_a"))
  const budgetStage = pipe.stages.find((st) => st.moment === "presupuesto_enviado")!
  const opp = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: c.id, title: `Presupuesto ${TAG}` }, { userId: null, origin: "agente" }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    moveOpportunity(tx, "org_a", opp.id, budgetStage.id, { userId: null, origin: "agente", cause: "presupuesto_presentado" }),
  )
  const { items } = await withOrgContext(appDb, "org_a", (tx) => listOpportunities(tx, "org_a", { contactId: c.id }))
  expect(items[0]?.why).toMatch(/^Sofi le presentó el presupuesto (hoy|ayer|mañana|el )/)
})
