/**
 * La clínica de examen con dólares: soles de moneda del negocio y USD de otra, con lo
 * que une a Reportes y Argos: una deuda en dos monedas, un pago cruzado, un billete con
 * vuelto, una anulación, una devolución parcial, un gasto en dólares, una comisión y
 * una compra en dólares. La arma una prueba (`reports-two-currencies.test.ts`) y, para
 * correr `eval:argos-cifras --org=examen-dolares` sobre ella, `seed:examen-dolares`.
 * No es la demo: no la importa la semilla ni corre en producción.
 */
import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import {
  encounter,
  encounterProcedure,
  patientCharge,
  serviceCatalog,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentBudgetOption,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { expense } from "@odentia/db/schema/finance"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { createExpense, payPurchaseOrder, setCommissionRate } from "./finance.js"
import {
  confirmPurchaseOrder,
  createProduct,
  createPurchaseOrder,
  createSupplier,
  createWarehouse,
  receivePurchaseOrder,
} from "./inventory.js"
import { setOrgExchangeRate } from "./organization-profile.js"
import { createPaymentMethod } from "./payment-methods.js"
import { nextPatientNumber } from "./patients.js"
import {
  collectCharge,
  createCharge,
  getTicketReturnable,
  returnFromTicket,
  voidTicket,
} from "./payments.js"
import { insertTestPatients } from "./test-patient.js"

export interface TwoCurrencyClinicInput {
  orgId?: string
  /** El cambio de hoy; `null` deja una clínica de una moneda. */
  rate?: string | null
  currency?: string
  country?: string
  locale?: string
}

/** Lo mínimo: la clínica, quien cobra y atiende, una sede y sus medios de pago. */
export async function twoCurrencyClinic(
  ownerDb: Db,
  appDb: Db,
  input: TwoCurrencyClinicInput = {},
) {
  const orgId = input.orgId ?? `examen-${randomUUID()}`
  const currency = input.currency ?? "PEN"
  await ownerDb.execute(sql`
    insert into "organization" ("id", "name", "slug", "created_at") values (${orgId}, ${`Clínica ${orgId}`}, ${orgId}, now())`)
  await ownerDb.execute(sql`
    insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
    values (${orgId}, ${`Clínica ${orgId}`}, ${input.country ?? "PE"}, ${currency}, 'America/Lima', ${input.locale ?? "es-PE"})`)
  const actor = randomUUID()
  await ownerDb
    .insert(user)
    .values({ id: actor, name: "Dra. Rosa Examen", email: `${actor}@examen.test` })
  await ownerDb.insert(member).values({
    id: randomUUID(),
    organizationId: orgId,
    userId: actor,
    role: "owner",
    createdAt: new Date(),
  })
  const run = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const rate = input.rate === undefined ? "3.75" : input.rate
  if (rate)
    await run((tx) =>
      setOrgExchangeRate(tx, orgId, actor, { secondCurrency: "USD", exchangeRate: rate }),
    )
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: orgId, name: "Miraflores" })
    .returning()
  const branchId = site!.id
  const cash = await run((tx) =>
    createPaymentMethod(tx, orgId, actor, { name: "Efectivo", typeCode: "10" }),
  )
  const card = await run((tx) =>
    createPaymentMethod(tx, orgId, actor, { name: "Tarjeta", typeCode: "48" }),
  )
  await run((tx) =>
    setCommissionRate(tx, orgId, actor, { professionalUserId: actor, rateBps: 3000 }),
  )

  const person = async (displayName: string) => {
    const [row] = await insertTestPatients(ownerDb, {
      organizationId: orgId,
      displayName,
      patientNumber: await nextPatientNumber(ownerDb, orgId),
    })
    return row!.id
  }
  /** Una atención firmada con sus procedimientos y sus cargos, en la moneda de cada uno. */
  const attended = async (
    patientId: string,
    lines: Array<{ description: string; priceCents: number; currency: string }>,
  ) => {
    const [session] = await ownerDb
      .insert(encounter)
      .values({
        organizationId: orgId,
        patientId,
        professionalUserId: actor,
        branchId,
        reason: "Consulta",
      })
      .returning()
    const services = await Promise.all(
      [...new Set(lines.map((line) => line.description))].map(async (name) => {
        const [service] = await ownerDb
          .insert(serviceCatalog)
          .values({
            organizationId: orgId,
            name: `${name} ${randomUUID().slice(0, 8)}`,
            priceCents: 1,
            currency,
          })
          .returning()
        return [name, service!] as const
      }),
    )
    const serviceOf = new Map(services)
    const procedures = await ownerDb
      .insert(encounterProcedure)
      .values(
        lines.map((line) => ({
          organizationId: orgId,
          encounterId: session!.id,
          serviceId: serviceOf.get(line.description)!.id,
          description: line.description,
          priceCents: line.priceCents,
          currency: line.currency,
          createdBy: actor,
        })),
      )
      .returning()
    await ownerDb
      .update(encounter)
      .set({
        status: "finalizada",
        finalizedAt: new Date(),
        signerName: "Dra. Rosa Examen",
        signerRegistration: "12345",
      })
      .where(eq(encounter.id, session!.id))
    const charges = []
    for (const procedure of procedures)
      charges.push(
        await run((tx) =>
          createCharge(tx, orgId, actor, patientId, {
            encounterProcedureId: procedure.id,
            branchId,
          }),
        ),
      )
    return charges
  }
  const collect = (
    patientId: string,
    body: Omit<Parameters<typeof collectCharge>[4], "branchId" | "requestId">,
  ) =>
    run((tx) =>
      collectCharge(tx, orgId, actor, patientId, { branchId, requestId: randomUUID(), ...body }),
    )
  return { orgId, actor, branchId, cash, card, run, person, attended, collect }
}

/** La clínica de examen entera. Devuelve lo que hace falta para consultarla. */
export async function buildTwoCurrencyExam(ownerDb: Db, appDb: Db, orgId = "examen-dolares") {
  const c = await twoCurrencyClinic(ownerDb, appDb, { orgId })
  const { actor, branchId, cash, card, run } = c

  const lucia = await c.person("Lucía Ramos")
  const [implant, crown, resin, cleaning] = await c.attended(lucia, [
    { description: "Implante", priceCents: 100_000, currency: "USD" },
    { description: "Corona", priceCents: 20_000, currency: "USD" },
    { description: "Resina", priceCents: 30_000, currency: "PEN" },
    { description: "Limpieza", priceCents: 5_000, currency: "USD" },
  ])
  // Debe USD 1,000 y paga S/ 3,750: pago cruzado.
  const crossed = await c.collect(lucia, {
    chargeIds: [implant!.id],
    tenderCurrency: "PEN",
    exchangeRate: "3.75",
    payments: [{ paymentMethodId: cash.id, amountCents: 375_000 }],
  })
  // Debe USD 200 y paga en dólares, con otro cambio: vale solo para este cobro.
  await c.collect(lucia, {
    chargeIds: [crown!.id],
    exchangeRate: "3.8",
    payments: [{ paymentMethodId: card.id, amountCents: 20_000 }],
  })
  // Debe S/ 300 y da un billete de USD 100: entran USD 80, y S/ 75 de vuelto.
  await c.collect(lucia, {
    chargeIds: [resin!.id],
    tenderCurrency: "USD",
    exchangeRate: "3.75",
    changeCurrency: "PEN",
    cashReceivedCents: 10_000,
    payments: [{ paymentMethodId: cash.id, amountCents: 8_000 }],
  })
  // Se anula un cobro: resta su valor entero y vuelve a deberse.
  const voided = await c.collect(lucia, {
    chargeIds: [cleaning!.id],
    exchangeRate: "3.75",
    payments: [{ paymentMethodId: card.id, amountCents: 5_000 }],
  })
  await run((tx) =>
    voidTicket(tx, c.orgId, actor, lucia, voided.ticket.id, {
      reason: "Se cobró por error",
      allowPostClose: false,
    }),
  )
  // Se devuelve USD 100 del pago cruzado: salen S/ 375, sin cambio nuevo.
  const returnable = await run((tx) => getTicketReturnable(tx, c.orgId, lucia, crossed.ticket.id))
  await run((tx) =>
    returnFromTicket(tx, c.orgId, actor, lucia, crossed.ticket.id, {
      branchId,
      lines: [{ chargeId: returnable.lines[0]!.chargeId, amountCents: 10_000 }],
      paymentMethodId: cash.id,
      reason: "Parte no realizada",
      requestId: randomUUID(),
    }),
  )

  // Debe en dos monedas: es una sola persona.
  const bruno = await c.person("Bruno Díaz")
  await run((tx) =>
    createCharge(tx, c.orgId, actor, bruno, {
      description: "Ortodoncia",
      amountCents: 30_000,
      currency: "USD",
      branchId,
    }),
  )
  await run((tx) =>
    createCharge(tx, c.orgId, actor, bruno, {
      description: "Control",
      amountCents: 15_000,
      currency: "PEN",
      branchId,
    }),
  )
  // Debe desde hace 45 días: deuda vencida.
  const carla = await c.person("Carla Soto")
  await ownerDb.insert(patientCharge).values({
    organizationId: c.orgId,
    patientId: carla,
    branchId,
    description: "Concepto antiguo",
    amountCents: 20_000,
    currency: "USD",
    createdAt: new Date(Date.now() - 45 * 86_400_000),
  })

  // Un gasto en soles y otro en dólares, con su valor congelado.
  await run((tx) =>
    createExpense(tx, c.orgId, actor, {
      branchId,
      category: "Materiales",
      concept: "Guantes",
      amountCents: 50_000,
    }),
  )
  await ownerDb.insert(expense).values({
    organizationId: c.orgId,
    branchId,
    concept: "Laboratorio en Lima",
    category: "Laboratorio",
    amountCents: 10_000,
    currency: "USD",
    exchangeRate: "3.7",
    businessCents: 37_000,
    spentAt: new Date(),
    receiptKind: "ninguno",
    createdBy: actor,
  })

  // Una compra en dólares, recibida y pagada en parte.
  const store = await run((tx) =>
    createWarehouse(tx, c.orgId, actor, { branchId, name: "Almacén" }),
  )
  const seller = await run((tx) => createSupplier(tx, c.orgId, actor, { name: "Dental Import" }))
  const item = await run((tx) =>
    createProduct(tx, c.orgId, actor, {
      sku: "IMP-1",
      name: "Implante de titanio",
      unit: "unidad",
    }),
  )
  const order = await run((tx) =>
    createPurchaseOrder(tx, c.orgId, actor, {
      supplierId: seller.id,
      warehouseId: store.id,
      currency: "USD",
      lines: [{ productId: item.id, quantity: 2, unitCostCents: 15_000 }],
    }),
  )
  await run((tx) => confirmPurchaseOrder(tx, c.orgId, actor, order.id))
  await run((tx) =>
    receivePurchaseOrder(
      tx,
      c.orgId,
      actor,
      order.id,
      [{ productId: item.id, quantity: 2 }],
      randomUUID(),
    ),
  )
  await run((tx) =>
    payPurchaseOrder(tx, c.orgId, actor, { orderId: order.id, amountCents: 10_000 }),
  )

  // Un presupuesto aceptado con líneas en cada moneda: lo que viene, al cambio de hoy.
  const dana = await c.person("Dana Vega")
  const [plan] = await ownerDb
    .insert(treatmentPlan)
    .values({ organizationId: c.orgId, patientId: dana, title: "Plan" })
    .returning()
  const [budget] = await ownerDb
    .insert(treatmentBudget)
    .values({
      organizationId: c.orgId,
      patientId: dana,
      planId: plan!.id,
      budgetNumber: 1,
      title: "Rehabilitación",
      status: "borrador",
      createdBy: actor,
    })
    .returning()
  const optionId = randomUUID()
  await ownerDb.insert(treatmentBudgetOption).values({
    id: optionId,
    organizationId: c.orgId,
    patientId: dana,
    budgetId: budget!.id,
    position: 1,
  })
  for (const line of [
    { title: "Implante", priceCents: 50_000, currency: "USD" },
    { title: "Limpieza", priceCents: 10_000, currency: "PEN" },
  ]) {
    const person = { organizationId: c.orgId, patientId: dana, planId: plan!.id, ...line }
    const [planned] = await ownerDb
      .insert(treatmentPlanItem)
      .values({ ...person, status: "pendiente", decisionStatus: "aceptado" })
      .returning()
    await ownerDb.insert(treatmentBudgetItem).values({
      ...person,
      budgetId: budget!.id,
      optionId,
      planItemId: planned!.id,
      decision: "aceptado",
    })
  }
  await ownerDb
    .update(treatmentBudget)
    .set({ status: "aceptado", presentedAt: new Date(), decidedAt: new Date() })
    .where(eq(treatmentBudget.id, budget!.id))
  return { ...c, lucia, bruno, carla, dana, orderId: order.id }
}
