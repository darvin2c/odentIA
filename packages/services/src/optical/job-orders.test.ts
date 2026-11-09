import { randomUUID } from "node:crypto"
import { encounter, patientCharge, patientPaymentApplication } from "@odentia/db/schema/clinical"
import { product, stockMovement } from "@odentia/db/schema/inventory"
import { jobOrder, jobOrderEvent } from "@odentia/db/schema/orders"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { and, eq, inArray, isNull, or } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { clinicalFixture } from "../clinical-test-fixture.js"
import { advanceJobOrder, createJobOrderSale, getJobOrder, listJobOrders, remakeJobOrder, saleReferencesOf, voidJobOrder } from "../job-orders.js"
import { issueLensPrescription } from "./lens-prescriptions.js"
import { createPaymentMethod } from "../payment-methods.js"
import { getTicketReturnable, returnFromTicket } from "../payments.js"
import { insertOrg, ownerDb, setupTestDb } from "../test-setup.js"

setupTestDb()

const OPTICA = "org_optica_pedidos"

beforeAll(async () => {
  await insertOrg(ownerDb, OPTICA, "optica-pedidos")
  await ownerDb.update(orgProfile).set({ product: "optical" }).where(eq(orgProfile.organizationId, OPTICA))
})

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Una persona de la óptica examinada, con su receta de anteojos, una sede, la caja y una montura en venta. */
async function store(orgId = OPTICA) {
  const f = await clinicalFixture(orgId)
  await ownerDb
    .update(encounter)
    .set({ examination: { refraccion: { od: { esfera: -2, cilindro: -0.5, eje: 180 }, oi: { esfera: -1.75 } }, dp: { od: 31, oi: 32 } } })
    .where(eq(encounter.id, f.encounter.id))
  const prescription =
    orgId === OPTICA ? await f.run((tx) => issueLensPrescription(tx, ...f.args, { encounterId: f.encounter.id, kind: "anteojos" })) : null
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: `Sede ${randomUUID()}` }).returning()
  const cash = await f.run((tx) => createPaymentMethod(tx, orgId, f.actor, { name: "Efectivo", typeCode: "10" }))
  const [frame] = await ownerDb
    .insert(product)
    .values({
      organizationId: orgId,
      sku: `MON-${randomUUID().slice(0, 8)}`,
      name: "Montura Ray-Ban RB5154",
      unit: "unidad",
      usedInCare: false,
      forSale: true,
      salePriceCents: 35_000,
      saleCurrency: "PEN",
    })
    .returning()
  return { f, prescription, branchId: site!.id, cashId: cash.id, frameId: frame!.id }
}

function inDays(days: number) {
  const date = new Date(Date.now() + days * 86_400_000)
  return date.toISOString().slice(0, 10)
}

async function sell(s: Awaited<ReturnType<typeof store>>, extra: Partial<Parameters<typeof createJobOrderSale>[4]> = {}) {
  return s.f.run((tx) =>
    createJobOrderSale(tx, ...s.f.args, {
      branchId: s.branchId,
      requestId: randomUUID(),
      title: "Lentes monofocales con antirreflejo",
      maker: "Laboratorio Visión Andina",
      promisedOn: inDays(7),
      lines: [
        { kind: "montura", productId: s.frameId },
        { kind: "lunas", description: "Lunas monofocales con antirreflejo", amountCents: 25_000 },
      ],
      ...(s.prescription ? { referenceId: s.prescription.id } : {}),
      fitting: { alturaOd: 18, alturaOi: 18.5 },
      payments: [{ paymentMethodId: s.cashId, amountCents: 30_000 }],
      cashReceivedCents: 30_000,
      ...extra,
    }),
  )
}

describe("el pedido de lentes (entrega 4)", () => {
  it("la venta crea los cargos, el pedido con la copia de la receta y cobra el adelanto", async () => {
    const s = await store()
    const sale = await sell(s)
    expect(sale.ticketId).not.toBeNull()
    expect(sale.order).toMatchObject({
      status: "por_enviar",
      statusLabel: "Por enviar",
      title: "Lentes monofocales con antirreflejo",
      maker: "Laboratorio Visión Andina",
      overdue: false,
      fitting: { alturaOd: 18, alturaOi: 18.5 },
      // 350 + 250 − 300 de adelanto.
      dueCents: 30_000,
      prescription: {
        id: s.prescription!.id,
        kind: "anteojos",
        lenses: { od: { esfera: -2, cilindro: -0.5, eje: 180 }, oi: { esfera: -1.75 } },
        pupillaryDistance: { od: 31, oi: 32 },
        verified: true,
      },
    })
    expect(sale.order.lines.map((line) => [line.kind, line.description, line.amountCents])).toEqual([
      ["montura", "Montura Ray-Ban RB5154", 35_000],
      ["lunas", "Lunas monofocales con antirreflejo", 25_000],
    ])
    expect(sale.order.events).toEqual([expect.objectContaining({ status: "por_enviar", actorName: expect.any(String) })])
  })

  it("un reintento de la misma venta devuelve el mismo pedido y el mismo ticket, sin cobrar otra vez", async () => {
    const s = await store()
    const requestId = randomUUID()
    const first = await sell(s, { requestId })
    const again = await sell(s, { requestId })
    expect(again.order.id).toBe(first.order.id)
    expect(again.ticketId).toBe(first.ticketId)
    const orders = await ownerDb.select().from(jobOrder).where(and(eq(jobOrder.organizationId, OPTICA), eq(jobOrder.patientId, s.f.patient.id)))
    expect(orders).toHaveLength(1)
    expect(again.order.dueCents).toBe(30_000)
  })

  it("sin adelanto también se vende: la entrega no lo exige", async () => {
    const s = await store()
    const sale = await sell(s, { payments: [], cashReceivedCents: undefined })
    expect(sale.ticketId).toBeNull()
    expect(sale.order.dueCents).toBe(60_000)
  })

  it("avanza hacia adelante, se puede saltar un paso, y dice quién marcó cada uno", async () => {
    const s = await store()
    const { order } = await sell(s)
    await s.f.run((tx) => advanceJobOrder(tx, OPTICA, s.f.actor, order.id, { status: "en_laboratorio" }))
    // El taller propio no pasa por «Por revisar»: de laboratorio a listo.
    await s.f.run((tx) => advanceJobOrder(tx, OPTICA, s.f.actor, order.id, { status: "listo", note: "Revisado en el frontofocómetro" }))
    await expect(s.f.run((tx) => advanceJobOrder(tx, OPTICA, s.f.actor, order.id, { status: "en_laboratorio" }))).rejects.toMatchObject({
      status: 409,
      code: "JOB_ORDER_BACKWARDS",
    })
    const delivered = await s.f.run((tx) => advanceJobOrder(tx, OPTICA, s.f.actor, order.id, { status: "entregado" }))
    expect(delivered.status).toBe("entregado")
    expect(delivered.events.map((event) => [event.status, event.note])).toEqual([
      ["por_enviar", null],
      ["en_laboratorio", null],
      ["listo", "Revisado en el frontofocómetro"],
      ["entregado", null],
    ])
    const [row] = await ownerDb.select().from(jobOrder).where(eq(jobOrder.id, order.id))
    expect(row?.deliveredAt).not.toBeNull()
    await expect(s.f.run((tx) => voidJobOrder(tx, OPTICA, s.f.actor, order.id, { reason: "x" }))).rejects.toMatchObject({
      code: "JOB_ORDER_DELIVERED",
    })
  })

  it("rehacer crea otro pedido unido al original, con sus mismos cargos: no se cobra otra vez y lo que falta sigue a la vista", async () => {
    const s = await store()
    const { order } = await sell(s)
    const requestId = randomUUID()
    const remake = () =>
      s.f.run((tx) =>
        remakeJobOrder(tx, OPTICA, s.f.actor, order.id, { reason: "No ve bien de lejos con el OD", promisedOn: inDays(5), requestId }),
      )
    const remade = await remake()
    expect(remade).toMatchObject({
      remakeOf: order.id,
      remakeOfOrder: { id: order.id, orderNumber: order.orderNumber },
      remakeReason: "No ve bien de lejos con el OD",
      status: "por_enviar",
      // Lo que faltaba pagar de la venta sigue en el nuevo: quien lo entrega lo ve.
      dueCents: 30_000,
      prescription: { id: s.prescription!.id },
    })
    expect(remade.orderNumber).toBeGreaterThan(order.orderNumber)
    expect(remade.lines.map((line) => line.chargeId)).toEqual(order.lines.map((line) => line.chargeId))
    // Un reintento devuelve el mismo.
    expect((await remake()).id).toBe(remade.id)
    // El original queda reemplazado: sale de lo que se trabaja y ya no avanza ni se anula.
    const open = await s.f.run((tx) => listJobOrders(tx, OPTICA, { status: "abiertos", patientId: s.f.patient.id, withMoney: true }))
    expect(open.map((row) => row.id)).toEqual([remade.id])
    const original = await s.f.run((tx) => getJobOrder(tx, OPTICA, order.id))
    expect(original.remadeAs).toEqual({ id: remade.id, orderNumber: remade.orderNumber })
    await expect(s.f.run((tx) => advanceJobOrder(tx, OPTICA, s.f.actor, order.id, { status: "listo" }))).rejects.toMatchObject({
      code: "JOB_ORDER_REMADE",
    })
    await expect(s.f.run((tx) => voidJobOrder(tx, OPTICA, s.f.actor, order.id, { reason: "Se rehízo" }))).rejects.toMatchObject({
      code: "JOB_ORDER_REMADE",
    })
    // Anular el rehecho no anula los cargos que comparte con el original, que vuelve a la lista.
    await s.f.run((tx) => voidJobOrder(tx, OPTICA, s.f.actor, remade.id, { reason: "Se rehízo por error" }))
    const charges = await ownerDb
      .select({ voidedAt: patientCharge.voidedAt })
      .from(patientCharge)
      .where(inArray(patientCharge.id, order.lines.map((line) => line.chargeId!)))
    expect(charges.every((charge) => charge.voidedAt === null)).toBe(true)
    const back = await s.f.run((tx) => listJobOrders(tx, OPTICA, { status: "abiertos", patientId: s.f.patient.id, withMoney: true }))
    expect(back.map((row) => row.id)).toEqual([order.id])
  })

  it("una devolución parcial en la caja la sigue el pedido: lo que falta es lo que dice la caja", async () => {
    const s = await store()
    const { order, ticketId } = await sell(s, {
      lines: [{ kind: "lunas", description: "Lunas progresivas", amountCents: 50_000 }],
      payments: [{ paymentMethodId: s.cashId, amountCents: 10_000 }],
      cashReceivedCents: 10_000,
    })
    const { lines } = await s.f.run((tx) => getTicketReturnable(tx, OPTICA, s.f.patient.id, ticketId!))
    await s.f.run((tx) =>
      returnFromTicket(tx, ...s.f.args, ticketId!, {
        branchId: s.branchId,
        lines: [{ chargeId: lines[0]!.chargeId, amountCents: 5_000 }],
        paymentMethodId: s.cashId,
        reason: "Reclamo",
        requestId: randomUUID(),
      }),
    )
    const root = order.lines[0]!.chargeId!
    const [live] = await ownerDb
      .select({ id: patientCharge.id, amountCents: patientCharge.amountCents })
      .from(patientCharge)
      .where(and(eq(patientCharge.organizationId, OPTICA), isNull(patientCharge.voidedAt), or(eq(patientCharge.id, root), eq(patientCharge.originalChargeId, root))))
    const applied = await ownerDb
      .select({ amountCents: patientPaymentApplication.amountCents })
      .from(patientPaymentApplication)
      .where(and(eq(patientPaymentApplication.chargeId, live!.id), isNull(patientPaymentApplication.voidedAt)))
    const expected = live!.amountCents - applied.reduce((sum, row) => sum + row.amountCents, 0)
    const detail = await s.f.run((tx) => getJobOrder(tx, OPTICA, order.id))
    expect(detail.lines[0]?.amountCents).toBe(live!.amountCents)
    expect(detail.dueCents).toBe(expected)
    expect(detail.dueCents).toBeGreaterThan(0)
  })

  it("la misma clave con otra venta es un conflicto, y el reintento vale también al día siguiente", async () => {
    const s = await store()
    const requestId = randomUUID()
    const first = await sell(s, { requestId })
    await expect(sell(s, { requestId, title: "Otra cosa" })).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" })
    // La fecha prometida ya pasó cuando vuelve el reintento: devuelve la misma venta.
    await ownerDb.update(jobOrder).set({ promisedOn: inDays(-3) }).where(eq(jobOrder.id, first.order.id))
    const again = await s.f.run((tx) =>
      createJobOrderSale(tx, ...s.f.args, {
        branchId: s.branchId,
        requestId,
        title: "Lentes monofocales con antirreflejo",
        maker: "Laboratorio Visión Andina",
        promisedOn: inDays(7),
        lines: [
          { kind: "montura", productId: s.frameId },
          { kind: "lunas", description: "Lunas monofocales con antirreflejo", amountCents: 25_000 },
        ],
        referenceId: s.prescription!.id,
        fitting: { alturaOd: 18, alturaOi: 18.5 },
        payments: [{ paymentMethodId: s.cashId, amountCents: 30_000 }],
        cashReceivedCents: 30_000,
      }),
    )
    expect(again.order.id).toBe(first.order.id)
  })

  it("a precio libre no hay cantidad: el precio es el de todo", async () => {
    const s = await store()
    await expect(sell(s, { lines: [{ kind: "lunas", description: "Lunas", amountCents: 10_000, quantity: 2 }] })).rejects.toMatchObject({
      fields: { "lines[0].quantity": expect.any(String) },
    })
  })

  it("anular pide el motivo, y anulado ya no avanza", async () => {
    const s = await store()
    const { order } = await sell(s)
    await expect(s.f.run((tx) => voidJobOrder(tx, OPTICA, s.f.actor, order.id, { reason: " " }))).rejects.toMatchObject({ status: 400 })
    const voided = await s.f.run((tx) => voidJobOrder(tx, OPTICA, s.f.actor, order.id, { reason: "Se arrepintió antes de enviarlo" }))
    expect(voided).toMatchObject({ status: "anulado", voidReason: "Se arrepintió antes de enviarlo" })
    await expect(s.f.run((tx) => advanceJobOrder(tx, OPTICA, s.f.actor, order.id, { status: "listo" }))).rejects.toMatchObject({
      code: "JOB_ORDER_VOIDED",
    })
  })

  it("anular anula en la caja lo que no se cobró, devuelve la montura al inventario y deja lo cobrado en su cuenta", async () => {
    const s = await store()
    // 300 de adelanto: la caja lo aplica a un cargo (el más antiguo); el otro queda sin cobrar.
    const { order } = await sell(s)
    const voided = await s.f.run((tx) => voidJobOrder(tx, OPTICA, s.f.actor, order.id, { reason: "Cambió de idea" }))
    const charges = await ownerDb
      .select({ id: patientCharge.id, amountCents: patientCharge.amountCents, voidedAt: patientCharge.voidedAt, voidReason: patientCharge.voidReason })
      .from(patientCharge)
      .where(inArray(patientCharge.id, order.lines.map((line) => line.chargeId!)))
    const paid = new Set(
      (
        await ownerDb
          .select({ chargeId: patientPaymentApplication.chargeId })
          .from(patientPaymentApplication)
          .where(inArray(patientPaymentApplication.chargeId, charges.map((charge) => charge.id)))
      ).map((row) => row.chargeId),
    )
    expect(paid.size).toBe(1)
    for (const charge of charges) {
      if (paid.has(charge.id)) {
        // Lo que tiene algo cobrado queda en su cuenta, y la clínica decide.
        expect(charge.voidedAt).toBeNull()
        expect(voided.dueCents).toBe(charge.amountCents - 30_000)
      } else {
        expect(charge.voidedAt).not.toBeNull()
        expect(charge.voidReason).toMatch(/^Pedido N\.º \d+ anulado: Cambió de idea$/)
      }
    }
    // Sin nada cobrado, la montura vuelve al inventario con su devolución.
    const t = await store()
    const unpaid = await sell(t, { payments: [], cashReceivedCents: undefined })
    await t.f.run((tx) => voidJobOrder(tx, OPTICA, t.f.actor, unpaid.order.id, { reason: "Duplicado" }))
    const returned = await ownerDb
      .select({ kind: stockMovement.kind })
      .from(stockMovement)
      .where(and(eq(stockMovement.organizationId, OPTICA), eq(stockMovement.productId, t.frameId)))
    expect(returned.map((row) => row.kind).sort()).toEqual(["devolucion", "venta"])
  })

  it("la lista dice los atrasados, y lo que falta pagar solo a quien ve la caja", async () => {
    const s = await store()
    const { order } = await sell(s)
    await ownerDb.update(jobOrder).set({ promisedOn: inDays(-2) }).where(eq(jobOrder.id, order.id))
    const late = await s.f.run((tx) => listJobOrders(tx, OPTICA, { status: "atrasados", patientId: s.f.patient.id, withMoney: false }))
    expect(late).toEqual([expect.objectContaining({ id: order.id, overdue: true, dueCents: null, patientName: expect.any(String) })])
    const withMoney = await s.f.run((tx) => listJobOrders(tx, OPTICA, { patientId: s.f.patient.id, withMoney: true }))
    expect(withMoney[0]?.dueCents).toBe(30_000)
    const detail = await s.f.run((tx) => getJobOrder(tx, OPTICA, order.id, { withMoney: false }))
    expect(detail.lines.every((line) => line.amountCents === null)).toBe(true)
  })

  it("la venta ofrece las recetas vigentes, y la de otra persona no se copia", async () => {
    const s = await store()
    const references = await s.f.run((tx) => saleReferencesOf(tx, OPTICA, s.f.patient.id))
    expect(references).toEqual([
      expect.objectContaining({ id: s.prescription!.id, label: expect.stringMatching(/^Receta de anteojos · /), lines: ["OD −2,00 −0,50 × 180°", "OI −1,75"] }),
    ])
    const other = await store()
    await expect(sell(other, { referenceId: s.prescription!.id })).rejects.toMatchObject({ fields: { referenceId: expect.any(String) } })
  })

  it("una fecha prometida pasada o sin nada que lleve no se vende", async () => {
    const s = await store()
    await expect(sell(s, { promisedOn: inDays(-3) })).rejects.toMatchObject({ fields: { promisedOn: expect.any(String) } })
    await expect(sell(s, { lines: [] })).rejects.toMatchObject({ fields: { lines: expect.any(String) } })
  })

  it("es común: una clínica de odentIA también encarga, sin receta de lentes", async () => {
    const s = await store("org_a")
    const sale = await sell(s, { title: "Corona de zirconio 1.6", maker: "Laboratorio Dental Sur" })
    expect(sale.order).toMatchObject({ status: "por_enviar", prescription: null })
    await expect(sell(s, { referenceId: randomUUID() })).rejects.toMatchObject({ fields: { referenceId: expect.any(String) } })
    const events = await ownerDb.select().from(jobOrderEvent).where(eq(jobOrderEvent.jobOrderId, sale.order.id))
    expect(events).toHaveLength(1)
  })
})

export type { Fixture }
