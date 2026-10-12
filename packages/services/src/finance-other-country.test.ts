/**
 * Nada atado a un país: el recorrido cobro → ticket → anulación → cierre con
 * una clínica que la propia prueba arma en otro país, con otra moneda y sin
 * decimales. La semilla de desarrollo (peruana) no participa.
 */
import { randomUUID } from "node:crypto"
import { formatMoney } from "@odentia/clinical"
import { type Db, withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { patient } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { closeCashWindow, createExpense, getCashState, getClosureSheet, getDayMovements } from "./finance.js"
import { buildTicketSnapshot, renderTicketPdf } from "./financial-document-pdf.js"
import { updateOrgRegion } from "./organization-profile.js"
import { listPaymentMethods } from "./payment-methods.js"
import { nextPatientNumber } from "./patients.js"
import { collectCharge, createCharge, getAccountSummary, type TicketFrozen, voidTicket } from "./payments.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
setupTestDb()

/** Todo lo que delataría a Perú en un documento de otra clínica. */
const PERUVIAN = /\bPEN\b|es-PE|America\/Lima|S\/|Yape|Plin|\bsoles\b|centavos/

async function chileanClinic() {
  const orgId = `cl-${randomUUID()}`
  await insertOrg(ownerDb, orgId, orgId)
  const actor = randomUUID()
  const owner = randomUUID()
  for (const [id, name] of [[actor, "Camila Rojas"], [owner, "Dueña"]] as const)
    await ownerDb.insert(user).values({ id, name, email: `${id}@example.test` })
  await ownerDb
    .insert(member)
    .values({ id: randomUUID(), organizationId: orgId, userId: owner, role: "owner", createdAt: new Date() })
  const run = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const profile = await run((tx) =>
    updateOrgRegion(tx, orgId, actor, { countryCode: "CL", applyCountryPreset: true }),
  )
  const [sede] = await ownerDb
    .insert(branch)
    .values({ organizationId: orgId, name: "Sede Providencia", timezone: "America/Santiago" })
    .returning()
  const [person] = await ownerDb
    .insert(patient)
    .values({
      organizationId: orgId,
      displayName: "Matías Fuentes",
      patientNumber: await nextPatientNumber(ownerDb, orgId),
    })
    .returning()
  const methods = await run((tx) => listPaymentMethods(tx, orgId, { activeOnly: true }))
  return {
    orgId,
    actor,
    owner,
    profile,
    branchId: sede!.id,
    patientId: person!.id,
    run,
    cash: methods.find((method) => method.typeCode === "10")!,
    card: methods.find((method) => method.typeCode === "48")!,
    methods,
    args: [orgId, actor, person!.id] as const,
  }
}

it("otra clínica, otro país: cobra, emite el ticket, anula y cierra sin nada peruano", async () => {
  const c = await chileanClinic()
  expect(c.profile).toMatchObject({ countryCode: "CL", currency: "CLP", locale: "es-CL", timezone: "America/Santiago" })
  expect(c.methods.map((method) => method.name).join(" ")).not.toMatch(PERUVIAN)

  // El peso chileno no tiene decimales: 45 000 son 45000 unidades menores, no 450,00.
  const charge = await c.run((tx) =>
    createCharge(tx, ...c.args, { description: "Limpieza dental", amountCents: 45000, branchId: c.branchId }),
  )
  expect(charge.currency).toBe("CLP")

  const paid = await c.run((tx) =>
    collectCharge(tx, ...c.args, {
      branchId: c.branchId,
      payments: [
        { paymentMethodId: c.cash.id, amountCents: 20000 },
        { paymentMethodId: c.card.id, amountCents: 25000, reference: "7781" },
      ],
      cashReceivedCents: 20000,
      requestId: randomUUID(),
    }),
  )
  expect(paid.ticket).toMatchObject({ currency: "CLP", totalCents: 45000 })
  expect(paid.remainingCents).toBe(0)
  const frozen = paid.ticket.snapshot as TicketFrozen
  expect(frozen.clinic).toMatchObject({ currency: "CLP", locale: "es-CL", timezone: "America/Santiago" })
  expect(JSON.stringify(frozen)).not.toMatch(PERUVIAN)

  // El ticket se arma con el formato de la clínica: «$45.000», sin decimales.
  const ticket = await c.run((tx) => buildTicketSnapshot(tx, c.orgId, c.patientId, paid.ticket.id))
  expect(ticket.org).toMatchObject({ currency: "CLP", locale: "es-CL", timezone: "America/Santiago" })
  expect(ticket.lines).toEqual([
    { description: "Limpieza dental", amountCents: 45000, ofCents: null, promotion: null },
  ])
  expect(ticket.methods.map((method) => method.amountCents)).toEqual([20000, 25000])
  expect(ticket.issuerName).toBe("Camila Rojas")
  const shown = formatMoney(ticket.totalCents, ticket.currency, ticket.org.locale)
  expect(shown).toMatch(/45\.000/)
  expect(shown).not.toMatch(/[.,]00\b|450/)
  expect(JSON.stringify(ticket)).not.toMatch(PERUVIAN)
  const pdf = await renderTicketPdf(ticket)
  expect(Buffer.from(pdf.slice(0, 5)).toString("latin1")).toBe("%PDF-")
  // También en hoja Carta.
  expect((await renderTicketPdf(ticket, "Letter")).length).toBeGreaterThan(1000)

  // Caja del día en la zona de la sede.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date())
  const day = await c.run((tx) => getDayMovements(tx, c.orgId, { branchId: c.branchId, day: today }))
  expect(day.timezone).toBe("America/Santiago")
  expect(day.movements).toHaveLength(2)

  await c.run((tx) =>
    createExpense(tx, c.orgId, c.actor, {
      branchId: c.branchId,
      concept: "Guantes",
      amountCents: 5000,
      category: "Materiales",
      fromCash: true,
    }),
  )
  const state = await c.run((tx) => getCashState(tx, c.orgId, { branchId: c.branchId }))
  expect(state).toMatchObject({ currency: "CLP", cashOnHandCents: 15000, tickets: 1 })

  // Cierre con faltante: el aviso al dueño lleva el importe en pesos chilenos.
  const closed = await c.run((tx) =>
    closeCashWindow(tx, c.orgId, c.actor, {
      branchId: c.branchId,
      shiftId: state.shiftId,
      countedCents: 14000,
      retainedCents: 4000,
      deliveredCents: 10000,
    }),
  )
  expect(closed).toMatchObject({ currency: "CLP", expectedCents: 15000, differenceCents: -1000 })
  const sheet = await c.run((tx) => getClosureSheet(tx, c.orgId, closed.id))
  // La hoja es la del cierre nuevo, no la de un turno histórico sin detalle.
  expect(sheet.legacy).toBe(false)
  expect(sheet.closure).toMatchObject({ cashCollectedCents: 20000, expenseCashCents: 5000, retainedCents: 4000 })
  expect(JSON.stringify({ closure: sheet.closure, totals: sheet.totalsByMethod })).not.toMatch(PERUVIAN)
  const [notice] = await ownerDb
    .select()
    .from(workspaceNotification)
    .where(eq(workspaceNotification.dedupeKey, `cash-shift-diff:${closed.id}`))
  expect(notice?.userId).toBe(c.owner)
  expect(notice?.body).toMatch(/faltaron/)
  expect(notice?.body).toMatch(/1\.000/)
  expect(notice?.body).not.toMatch(PERUVIAN)

  // Anular después del cierre (administración): el ticket anulado conserva
  // conceptos y medios, y solo la parte en efectivo sale de la caja de hoy.
  await c.run((tx) =>
    voidTicket(tx, ...c.args, paid.ticket.id, { reason: "Cobro a la persona equivocada", allowPostClose: true }),
  )
  const voided = await c.run((tx) => buildTicketSnapshot(tx, c.orgId, c.patientId, paid.ticket.id))
  expect(voided.status).toBe("anulado")
  expect(voided.lines).toHaveLength(1)
  expect(voided.methods).toHaveLength(2)
  expect((await renderTicketPdf(voided)).length).toBeGreaterThan(1000)
  const after = await c.run((tx) => getCashState(tx, c.orgId, { branchId: c.branchId }))
  // Quedaron 4 000 del cierre; salen los 20 000 que se cobraron en efectivo.
  expect(after.cashOnHandCents).toBe(4000 - 20000)
  const account = await c.run((tx) => getAccountSummary(tx, c.orgId, c.patientId))
  expect(account.byCurrency).toEqual([{ currency: "CLP", porCobrar: 45000, pagado: 0, aFavor: 0 }])
})

it("el ticket impreso no cambia aunque después cambien la clínica o su frase al pie", async () => {
  const c = await chileanClinic()
  await c.run((tx) =>
    createCharge(tx, ...c.args, { description: "Control", amountCents: 30000, branchId: c.branchId }),
  )
  const paid = await c.run((tx) =>
    collectCharge(tx, ...c.args, {
      branchId: c.branchId,
      payments: [{ paymentMethodId: c.cash.id, amountCents: 10000 }],
      requestId: randomUUID(),
    }),
  )
  const before = await c.run((tx) => buildTicketSnapshot(tx, c.orgId, c.patientId, paid.ticket.id))
  // Cobro parcial: el ticket dice cuánto se pagó, de cuánto, y cuánto queda.
  expect(before.lines).toEqual([
    { description: "Control", amountCents: 10000, ofCents: 30000, promotion: null },
  ])
  expect(before.remainingCents).toBe(20000)

  await c.run((tx) =>
    updateOrgRegion(tx, c.orgId, c.actor, { ticketFooter: "Gracias por su visita." }),
  )
  await ownerDb.execute(
    // Solo la prueba cambia el nombre por fuera del servicio.
    `update "org_profile" set "legal_name" = 'Otra razón social' where "organization_id" = '${c.orgId}'`,
  )
  const after = await c.run((tx) => buildTicketSnapshot(tx, c.orgId, c.patientId, paid.ticket.id))
  expect(after.org.ticketFooter).toBe(before.org.ticketFooter)
  expect(after.org.legalName).toBe(before.org.legalName)
  expect(after.lines).toEqual(before.lines)
})
