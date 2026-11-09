/**
 * Dental Smile también cobra en dólares: el «Cambio de hoy», el implante en dólares,
 * un presupuesto con una línea en cada moneda, una deuda en dólares, un pago cruzado,
 * un billete con vuelto en soles, un gasto y una compra en dólares. Todo con las
 * operaciones de verdad. Solo esta demo: Clínica Norte, latidIA y las clínicas de
 * examen siguen con una moneda (la de dólares se arma en `exam-two-currencies.ts`).
 */
import type { Db } from "@odentia/db"
import { createBudget, deliverBudget } from "../budgets.js"
import { createEncounter } from "../encounters.js"
import { createExpense, payPurchaseOrder } from "../finance.js"
import {
  confirmPurchaseOrder,
  createProduct,
  createPurchaseOrder,
  createSupplier,
  receivePurchaseOrder,
} from "../inventory.js"
import { setOrgExchangeRate } from "../organization-profile.js"
import { listPaymentMethods } from "../payment-methods.js"
import { createPatient } from "../patients.js"
import { collectCharge, createCharge } from "../payments.js"
import { addPlanItem, createTreatmentPlan } from "../plan.js"
import { updateService } from "../service-catalog.js"

export async function seedTwoCurrencies(
  tx: Db,
  input: {
    orgId: string
    ownerUserId: string
    branchId: string
    implantServiceId: string
    cleaningServiceId: string
  },
): Promise<void> {
  const { orgId, ownerUserId, branchId, implantServiceId, cleaningServiceId } = input
  await setOrgExchangeRate(tx, orgId, ownerUserId, { secondCurrency: "USD", exchangeRate: "3.75" })
  // El precio del implante se dice en dólares: Sofi dice «USD 1,000 (hoy, unos S/ 3,750)».
  await updateService(tx, orgId, ownerUserId, implantServiceId, {
    currency: "USD",
    priceCents: 100_000,
    priceDisclosure: "exacto",
  })

  const person = (displayName: string, givenNames: string, familyName: string, phone: string) =>
    createPatient(tx, orgId, ownerUserId, {
      displayName,
      givenNames,
      familyName,
      birthDate: "1984-03-22",
      phone,
      registeredBranchId: branchId,
    })

  // Un solo presupuesto, con una línea en cada moneda: dos totales que no se suman.
  const veronica = await person("Verónica Paredes", "Verónica", "Paredes", "+51987444101")
  const evaluation = await createEncounter(tx, orgId, ownerUserId, veronica.id, {
    reason: "Evaluación para implante",
  })
  const plan = await createTreatmentPlan(tx, orgId, ownerUserId, veronica.id, {
    title: "Rehabilitación con implante",
    originEncounterId: evaluation.id,
  })
  const implantLine = await addPlanItem(tx, orgId, ownerUserId, veronica.id, {
    serviceId: implantServiceId,
    planId: plan.id,
    sourceEncounterId: evaluation.id,
    toothNumber: 36,
    detail: "Implante pieza 36",
  })
  const cleaningLine = await addPlanItem(tx, orgId, ownerUserId, veronica.id, {
    serviceId: cleaningServiceId,
    planId: plan.id,
    sourceEncounterId: evaluation.id,
    detail: "Limpieza antes del implante",
  })
  const budget = await createBudget(tx, orgId, ownerUserId, veronica.id, {
    planId: plan.id,
    itemIds: [implantLine.id, cleaningLine.id],
    title: "Rehabilitación con implante",
  })
  await deliverBudget(tx, orgId, ownerUserId, veronica.id, budget.id)

  const cash = (await listPaymentMethods(tx, orgId, { activeOnly: true })).find(
    (method) => method.typeCode === "10",
  )
  if (!cash) throw new Error("Falta el efectivo de la clínica demo")
  const transfer = (await listPaymentMethods(tx, orgId, { activeOnly: true })).find((method) => method.typeCode === "30") ?? null

  // Debe USD 200 y paga con S/ 750: el pago cruzado, y le queda la deuda al día.
  const crown = await createCharge(tx, orgId, ownerUserId, veronica.id, {
    branchId,
    description: "Corona provisional",
    amountCents: 20_000,
    currency: "USD",
  })
  await collectCharge(tx, orgId, ownerUserId, veronica.id, {
    branchId,
    chargeIds: [crown.id],
    tenderCurrency: "PEN",
    exchangeRate: "3.75",
    payments: [{ paymentMethodId: cash.id, amountCents: 75_000 }],
    requestId: "50206011-0000-4000-8000-000000000001",
  })

  // Debe en las dos monedas: una persona con dos deudas, y la de dólares sigue en dólares.
  const mauricio = await person("Mauricio Prado", "Mauricio", "Prado", "+51987444102")
  await createCharge(tx, orgId, ownerUserId, mauricio.id, {
    branchId,
    description: "Implante pieza 46",
    amountCents: 100_000,
    currency: "USD",
  })
  await createCharge(tx, orgId, ownerUserId, mauricio.id, {
    branchId,
    description: "Control",
    amountCents: 15_000,
    currency: "PEN",
  })

  // Debe S/ 300 y da un billete de USD 100: entran USD 100 a la caja de dólares y
  // salen S/ 75 de la de soles. Así cada caja tiene algo que contar.
  const julia = await person("Julia Villanueva", "Julia", "Villanueva", "+51987444103")
  const filling = await createCharge(tx, orgId, ownerUserId, julia.id, {
    branchId,
    description: "Resina",
    amountCents: 30_000,
    currency: "PEN",
  })
  await collectCharge(tx, orgId, ownerUserId, julia.id, {
    branchId,
    chargeIds: [filling.id],
    tenderCurrency: "USD",
    exchangeRate: "3.75",
    changeCurrency: "PEN",
    cashReceivedCents: 10_000,
    payments: [{ paymentMethodId: cash.id, amountCents: 8_000 }],
    requestId: "50206011-0000-4000-8000-000000000002",
  })

  // Un gasto en dólares, con su valor en soles al cambio de ese día.
  await createExpense(tx, orgId, ownerUserId, {
    branchId,
    category: "Laboratorio",
    concept: "Guía quirúrgica para implante",
    amountCents: 12_000,
    currency: "USD",
    exchangeRate: "3.75",
    // Un laboratorio factura con su RUC y se le paga por transferencia (ADR 0167).
    paymentMethodId: transfer?.id ?? null,
    paymentReference: "771204",
    receiptType: "01",
    receiptNumber: "E001-318",
    supplierName: "Laboratorio Dental Andino S.A.C.",
    supplierTaxId: "20512345678",
  })

  // Una compra en dólares, recibida y pagada en parte con soles: el cambio sale de lo pagado.
  const seller = await createSupplier(tx, orgId, ownerUserId, {
    name: "Implantes del Pacífico S.A.C.",
    docType: "RUC",
    docNumber: "20601234567",
  })
  const implant = await createProduct(tx, orgId, ownerUserId, {
    sku: "IMP-TITANIO",
    name: "Implante de titanio",
    unit: "unidad",
  })
  const order = await createPurchaseOrder(tx, orgId, ownerUserId, {
    supplierId: seller.id,
    branchId,
    currency: "USD",
    notes: "Semilla: implantes en dólares",
    lines: [{ productId: implant.id, quantity: 4, unitCostCents: 15_000 }],
  })
  await confirmPurchaseOrder(tx, orgId, ownerUserId, order.id)
  await receivePurchaseOrder(
    tx,
    orgId,
    ownerUserId,
    order.id,
    [{ productId: implant.id, quantity: 4 }],
    `seed:recepcion-dolares:${orgId}`,
    { notify: false },
  )
  await payPurchaseOrder(tx, orgId, ownerUserId, {
    orderId: order.id,
    amountCents: 30_000,
    tenderCents: 112_800,
    tenderCurrency: "PEN",
    paymentMethodId: transfer?.id ?? null,
    paymentReference: "771355",
    receiptType: "01",
    receiptNumber: "F001-2077",
  })
}
