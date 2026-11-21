// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver rls.test.ts).
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { randomUUID } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { saasAction, saasSubscription } from "@odentia/db/schema/saas-billing"
import { eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { getSaasConsumption } from "./saas-actions.js"
import {
  assignSaasSeller,
  confirmSaasPayment,
  createSaasCharge,
  createSaasPlan,
  getOrganizationBillingSummary,
  getSaasSubscription,
  listSaasCharges,
  listSaasPayments,
  outstandingByCurrency,
  refundSaasPayment,
  registerManualSaasPayment,
  rejectSaasReceipt,
  reverseSaasPayment,
  settleSaasCommissions,
  startSaasTrial,
  submitSaasReceipt,
  upsertSaasPaymentMethod,
  upsertSaasSeller,
} from "./saas-billing.js"
import { closeSaasPeriods, listSaasChargeLines } from "./saas-invoicing.js"
import { insertOrg } from "./test-setup.js"

/**
 * Cada clínica es una cuenta (migración 0152, ADR 0210). La base se migra hasta la 0151 con
 * clínicas como las de producción y sus cobros de punta a punta (dos monedas, Fundadores, el
 * cobro por mensajes de Informa, pagos parciales, rechazados, reversados y devueltos, el saldo
 * de prueba, una demo y soporte); después se despliega la 0152. Para cada clínica, sus cargos,
 * sus pagos y sus saldos tienen que dar exactamente lo mismo antes y después, leídos por los
 * mismos servicios que usan la clínica y la administración.
 */

const IMAGE = "dentalagent-postgres:18.6"
const FOLDER = "../db/drizzle"
const MIGRATION = "_cada_clinica_es_una_cuenta"
const NOW = new Date("2026-11-20T15:00:00Z")
const DAY = 86_400_000

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db
let before: string

const ADMIN = "cuenta-admin"
const PEN = "cta-soles"
const MONEDAS = "cta-dos-monedas"
const FUNDADORES = "cta-fundadores"
const INFORMA = "cta-informa"
const PRUEBA = "cta-prueba"
const DEMO = "cta-demo"
const CLINICS = [PEN, MONEDAS, FUNDADORES, INFORMA, PRUEBA, DEMO]
let sellerId: string

function migrationsBefore(suffix: string): string {
  const journal = JSON.parse(readFileSync(join(FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[]
  }
  const position = journal.entries.findIndex((entry) => entry.tag.endsWith(suffix))
  if (position < 0) throw new Error(`falta la migración «${suffix}» en el journal`)
  const entries = journal.entries.slice(0, position)
  const dir = mkdtempSync(join(tmpdir(), "odentia-cuenta-"))
  mkdirSync(join(dir, "meta"))
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }))
  for (const entry of entries)
    cpSync(join(FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  return dir
}

const storage = {
  putAttachment: async ({
    orgId,
    conversationId,
    bytes,
    contentType,
  }: {
    orgId: string
    conversationId: string
    bytes: Uint8Array
    contentType: string
  }) => ({
    objectKey: `${orgId}/${conversationId}/comprobante.png`,
    mimeType: contentType,
    filename: "comprobante.png",
    size: bytes.byteLength,
  }),
}

/** PNG 1x1 real: la verificación por bytes lo acepta. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)
const receipt = (amountCents: number) => ({
  methodCode: "transferencia",
  amountCents,
  receipt: { bytes: new Uint8Array(PNG), contentType: "image/png", filename: "comprobante.png" },
  idempotencyKey: randomUUID(),
})

const asClinic = <T>(orgId: string, fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)

async function clinic(orgId: string): Promise<string> {
  await insertOrg(ownerDb, orgId, orgId)
  const owner = `${orgId}-owner`
  await ownerDb
    .insert(user)
    .values({ id: owner, name: "Propietaria", email: `${owner}@cuenta.test` })
  await ownerDb
    .insert(member)
    .values({
      id: randomUUID(),
      organizationId: orgId,
      userId: owner,
      role: "owner",
      createdAt: new Date(),
    })
  return owner
}

async function charge(orgId: string, planCode: string, month: number) {
  return createSaasCharge(ownerDb, orgId, ADMIN, {
    planCode,
    periodStart: new Date(Date.UTC(2026, month - 1, 1)),
    periodEnd: new Date(Date.UTC(2026, month, 1)),
  })
}

/** La clínica paga y la administración confirma (o lo registra la administración). */
async function pay(orgId: string, owner: string, chargeId: string, cents: number) {
  const payment = await asClinic(orgId, (tx) =>
    submitSaasReceipt(tx, { storage }, orgId, owner, { chargeId, ...receipt(cents) }),
  )
  await confirmSaasPayment(ownerDb, orgId, ADMIN, payment.id)
  return payment.id
}

async function informaAction(
  orgId: string,
  at: Date,
  tier: "informa" | "gestiona",
  priceMicros: number,
) {
  await ownerDb.insert(saasAction).values({
    organizationId: orgId,
    kind: "conversacion",
    tier,
    occurredAt: at,
    contactId: randomUUID(),
    detail: "Atendió una conversación por WhatsApp",
    currency: "USD",
    basePriceMicros: tier === "informa" ? 200_000 : 500_000,
    priceMicros,
    discountBps: tier === "informa" && priceMicros === 100_000 ? 5000 : 0,
    dedupeKey: randomUUID(),
  })
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ownerDb.execute(query)) as unknown as T[]
}

/** Lo que la clínica y la administración leen de su dinero, más los totales en la base. */
async function money(orgId: string) {
  const charges = await listSaasCharges(ownerDb, orgId)
  return {
    subscription: await getSaasSubscription(ownerDb, orgId),
    summary: await getOrganizationBillingSummary(ownerDb, orgId, NOW),
    charges,
    lines: await listSaasChargeLines(
      ownerDb,
      orgId,
      charges.map((row) => row.id),
    ),
    payments: await listSaasPayments(ownerDb, orgId, 200),
    outstanding: await outstandingByCurrency(ownerDb, orgId),
    consumption: await getSaasConsumption(ownerDb, orgId, NOW),
    // Lo que ve la clínica con su sesión (RLS), no la administración.
    clinicSees: await asClinic(orgId, async (tx) => ({
      charges: await listSaasCharges(tx, orgId),
      outstanding: await outstandingByCurrency(tx, orgId),
    })),
    totals: await rows(sql`
      select c.currency,
        sum(c.amount_cents)::int as charged, sum(c.paid_cents)::int as paid,
        count(*) filter (where c.status = 'parcial')::int as partial,
        (select coalesce(sum(p.amount_cents), 0)::int from saas_payment p where p.organization_id = ${orgId} and p.currency = c.currency and p.status = 'confirmado') as confirmed,
        (select count(*)::int from saas_payment p where p.organization_id = ${orgId} and p.currency = c.currency) as payments,
        (select coalesce(sum(l.amount_cents), 0)::int from saas_charge_line l join saas_charge lc on lc.id = l.charge_id where l.organization_id = ${orgId} and lc.currency = c.currency) as lines
      from saas_charge c where c.organization_id = ${orgId}
      group by c.currency order by c.currency`),
    commissions: await rows(sql`
      select (select coalesce(sum(commission_cents), 0)::int from saas_seller_commission where organization_id = ${orgId}) as commission,
        (select coalesce(sum(amount_cents), 0)::int from saas_commission_adjustment where organization_id = ${orgId}) as adjustment,
        (select coalesce(sum(amount_cents), 0)::int from saas_commission_settlement_line where organization_id = ${orgId}) as settled,
        (select coalesce(sum(price_micros), 0)::bigint::text from saas_action where organization_id = ${orgId}) as actions,
        (select count(*)::int from support_case where organization_id = ${orgId}) as cases`),
  }
}

const everything = async () =>
  Object.fromEntries(await Promise.all(CLINICS.map(async (id) => [id, await money(id)] as const)))

let moneyBefore: Record<string, unknown>

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: "dentalagent",
      POSTGRES_USER: "dentalagent",
      POSTGRES_PASSWORD: "dentalagent",
      POSTGRES_APP_PASSWORD: "dentalagent_app",
    })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withCommand([
      "postgres",
      "-c",
      "shared_preload_libraries=pg_cron",
      "-c",
      "cron.database_name=dentalagent",
    ])
    .start()
  const host = `${container.getHost()}:${container.getMappedPort(5432)}`
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${host}/dentalagent`)
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}/dentalagent`)
  before = migrationsBefore(MIGRATION)
  await migrate(ownerDb, { migrationsFolder: before })

  // Lo de la administración: un plan en soles, uno en dólares con Informa, su forma de pago y un vendedor.
  await ownerDb
    .insert(user)
    .values({ id: ADMIN, name: "Administración", email: "admin@cuenta.test" })
  await createSaasPlan(ownerDb, ADMIN, {
    code: "soles",
    name: "Plan en soles",
    currency: "PEN",
    priceCents: 10000,
  })
  await createSaasPlan(ownerDb, ADMIN, {
    code: "dolares",
    name: "Plan odentIA",
    currency: "USD",
    priceCents: 2900,
    creditCents: 2900,
    conversationMicros: 500_000,
    conversationInformMicros: 200_000,
    fixedPriceTiers: ["informa"],
    trialCreditCents: 5000,
    trialMaxCreditCents: 13000,
  })
  await upsertSaasPaymentMethod(ownerDb, ADMIN, { code: "transferencia", name: "Transferencia" })
  sellerId = (await upsertSaasSeller(ownerDb, ADMIN, { displayName: "Vendedora", rateBps: 1000 }))
    .id

  // En soles: un comprobante rechazado, un pago parcial confirmado y otro pendiente.
  const penOwner = await clinic(PEN)
  await startSaasTrial(ownerDb, PEN, { planCode: "soles" })
  const penCharge = await charge(PEN, "soles", 10)
  const rejected = await asClinic(PEN, (tx) =>
    submitSaasReceipt(tx, { storage }, PEN, penOwner, { chargeId: penCharge.id, ...receipt(3000) }),
  )
  await rejectSaasReceipt(ownerDb, PEN, ADMIN, rejected.id, "No se ve el monto")
  await pay(PEN, penOwner, penCharge.id, 4000)
  await asClinic(PEN, (tx) =>
    submitSaasReceipt(tx, { storage }, PEN, penOwner, { chargeId: penCharge.id, ...receipt(2000) }),
  )
  // Un caso de soporte de la clínica.
  await ownerDb.execute(sql`
    insert into support_case (organization_id, question, dedupe_key, opened_by, kind)
    values (${PEN}, '¿Cómo pago?', ${randomUUID()}, ${penOwner}, 'pregunta')`)

  // Dos monedas: lo de soles a medias, registrado por la administración; lo de dólares sin pagar.
  const monedasOwner = await clinic(MONEDAS)
  await startSaasTrial(ownerDb, MONEDAS, { planCode: "soles" })
  const solesCharge = await charge(MONEDAS, "soles", 9)
  await registerManualSaasPayment(ownerDb, { storage }, MONEDAS, ADMIN, {
    chargeId: solesCharge.id,
    ...receipt(5000),
  })
  const fullCharge = await charge(MONEDAS, "soles", 10)
  await pay(MONEDAS, monedasOwner, fullCharge.id, 10000)
  await charge(MONEDAS, "dolares", 11)

  // Fundadores: condiciones garantizadas y descuento, con vendedora; liquidada y luego reversada, y una devolución.
  const fundOwner = await clinic(FUNDADORES)
  await startSaasTrial(ownerDb, FUNDADORES, { planCode: "dolares", sellerId })
  await assignSaasSeller(ownerDb, FUNDADORES, ADMIN, sellerId)
  await ownerDb
    .update(saasSubscription)
    .set({ discountBps: 5000, guaranteedUntil: new Date("2027-11-01T00:00:00Z") })
    .where(eq(saasSubscription.organizationId, FUNDADORES))
  const fundCharge = await charge(FUNDADORES, "dolares", 10)
  const settledPayment = await pay(FUNDADORES, fundOwner, fundCharge.id, 2900)
  await settleSaasCommissions(ownerDb, ADMIN, {
    sellerId,
    year: new Date().getUTCFullYear(),
    month: new Date().getUTCMonth() + 1,
    currency: "USD",
  })
  await reverseSaasPayment(ownerDb, FUNDADORES, ADMIN, settledPayment, "Cobro duplicado")
  const fundCharge2 = await charge(FUNDADORES, "dolares", 11)
  const refunded = await pay(FUNDADORES, fundOwner, fundCharge2.id, 2900)
  await refundSaasPayment(ownerDb, FUNDADORES, ADMIN, refunded, "Devuelto a pedido de la clínica")

  // Cobro por mensajes de Informa: el tramo cerrado con su cargo por líneas, al precio de Fundadores.
  const informaOwner = await clinic(INFORMA)
  const start = new Date("2026-09-10T15:00:00Z")
  const end = new Date("2026-10-10T15:00:00Z")
  await ownerDb
    .update(saasSubscription)
    .set({
      status: "activa",
      planId: (await rows<{ id: string }>(sql`select id from saas_plan where code = 'dolares'`))[0]!
        .id,
      activatedAt: start,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      discountBps: 5000,
      trialEndsAt: null,
    })
    .where(eq(saasSubscription.organizationId, INFORMA))
  for (let index = 0; index < 40; index++)
    await informaAction(
      INFORMA,
      new Date(start.getTime() + (index + 1) * 3_600_000),
      index % 4 === 0 ? "gestiona" : "informa",
      index % 4 === 0 ? 500_000 : 100_000,
    )
  for (let index = 0; index < 60; index++)
    await informaAction(
      INFORMA,
      new Date(start.getTime() + (index + 41) * 3_600_000),
      "gestiona",
      500_000,
    )
  await closeSaasPeriods(ownerDb, new Date("2026-10-10T16:00:00Z"))
  // Lo del tramo nuevo, todavía sin cobrar.
  await informaAction(INFORMA, new Date(end.getTime() + DAY), "informa", 100_000)
  const informaCharges = await listSaasCharges(ownerDb, INFORMA)
  expect(informaCharges).toHaveLength(1)
  await pay(INFORMA, informaOwner, informaCharges[0]!.id, 1000)

  // Saldo de prueba a favor: lo gastado en la prueba sale del regalo, nada se debe.
  await clinic(PRUEBA)
  await startSaasTrial(ownerDb, PRUEBA, { planCode: "dolares" }, new Date(NOW.getTime() - 5 * DAY))
  for (let index = 0; index < 3; index++)
    await informaAction(PRUEBA, new Date(NOW.getTime() - (index + 1) * DAY), "gestiona", 500_000)

  // La demo: exenta de cobro.
  await clinic(DEMO)
  await startSaasTrial(ownerDb, DEMO, { planCode: "soles", isDemo: true })

  // Un caso personal, sin clínica.
  await ownerDb.execute(sql`
    insert into support_case (organization_id, question, dedupe_key, opened_by, kind)
    values (null, 'No puedo entrar', ${randomUUID()}, ${penOwner}, 'acceso')`)

  moneyBefore = await everything()
  await migrate(ownerDb, { migrationsFolder: FOLDER })
}, 300_000)

afterAll(async () => {
  if (before) rmSync(before, { recursive: true, force: true })
  await container?.stop()
})

describe("cada clínica es una cuenta", () => {
  it("antes y después dan igual los cargos, los pagos y los saldos de cada clínica", async () => {
    // Lo sembrado cubre los casos de borde: si no, la comparación no diría nada.
    const seen = moneyBefore as Record<string, Awaited<ReturnType<typeof money>>>
    expect(seen[MONEDAS]!.outstanding.map((entry) => entry.currency).sort()).toEqual(["PEN", "USD"])
    expect(seen[PEN]!.payments.map((payment) => payment.status).sort()).toEqual([
      "confirmado",
      "pendiente",
      "rechazado",
    ])
    expect(seen[PEN]!.charges[0]!.status).toBe("parcial")
    expect(seen[FUNDADORES]!.payments.map((payment) => payment.status).sort()).toEqual([
      "devuelto",
      "reversado",
    ])
    expect(seen[FUNDADORES]!.commissions[0]).toMatchObject({
      commission: 290,
      adjustment: 290,
      settled: 290,
    })
    expect(seen[INFORMA]!.lines.map((line) => line.kind)).toContain("conversacion")
    expect(seen[INFORMA]!.charges[0]!.status).toBe("parcial")
    expect(seen[PRUEBA]!.summary.status).toBe("prueba")
    expect(seen[DEMO]!.subscription?.isDemo).toBe(true)

    expect(await everything()).toEqual(moneyBefore)
  })

  it("cada clínica tiene una sola cuenta, con su mismo id, y volver a migrar no cambia nada", async () => {
    const accounts = await rows<{ orgs: number; accounts: number; same: number }>(sql`
      select (select count(*)::int from organization) as orgs,
        (select count(*)::int from saas_account) as accounts,
        (select count(*)::int from saas_account a join organization o on o.id = a.id and o.id = a.organization_id
          where a.app is null and a.external_ref is null) as same`)
    expect(accounts[0]!.accounts).toBe(accounts[0]!.orgs)
    expect(accounts[0]!.same).toBe(accounts[0]!.orgs)
    // La copia de la migración, tal como está en su archivo, corrida otra vez.
    const backfill = readFileSync(join(FOLDER, "0152_cada_clinica_es_una_cuenta.sql"), "utf8")
      .split("--> statement-breakpoint")
      .find((statement) => statement.includes('SELECT "id", "id" FROM "organization"'))
    expect(backfill).toBeDefined()
    const again = await rows(sql.raw(`${backfill!.replace(/;\s*$/, "")} RETURNING id`))
    expect(again).toEqual([])
    expect(await everything()).toEqual(moneyBefore)
  })

  it("una clínica nueva nace con su cuenta y su prueba, también si la crea el rol de la aplicación", async () => {
    await insertOrg(ownerDb, "cta-nueva", "cta-nueva")
    await appDb.execute(
      sql`insert into organization (id, name, slug, created_at) values ('cta-nueva-app', 'Desde la app', 'cta-nueva-app', now())`,
    )
    for (const id of ["cta-nueva", "cta-nueva-app"]) {
      const [row] = await rows<{ account: string | null; status: string | null }>(sql`
        select a.id as account, s.status from organization o
          left join saas_account a on a.organization_id = o.id
          left join saas_subscription s on s.organization_id = o.id
        where o.id = ${id}`)
      expect(row).toEqual({ account: id, status: "prueba" })
    }
  })

  it("lo que ya se cobra sigue funcionando sobre la cuenta: pagar, confirmar y cerrar el tramo", async () => {
    const owner = `${PEN}-owner`
    const [penCharge] = await listSaasCharges(ownerDb, PEN)
    const pending = (await listSaasPayments(ownerDb, PEN)).find(
      (payment) => payment.status === "pendiente",
    )!
    await confirmSaasPayment(ownerDb, PEN, ADMIN, pending.id)
    const extra = await asClinic(PEN, (tx) =>
      submitSaasReceipt(tx, { storage }, PEN, owner, { chargeId: penCharge!.id, ...receipt(4000) }),
    )
    await confirmSaasPayment(ownerDb, PEN, ADMIN, extra.id)
    expect((await listSaasCharges(ownerDb, PEN))[0]).toMatchObject({
      status: "pagada",
      paidCents: 10000,
    })
    expect(await outstandingByCurrency(ownerDb, PEN)).toEqual([])

    await closeSaasPeriods(ownerDb, new Date("2026-11-10T16:00:00Z"))
    const informa = await listSaasCharges(ownerDb, INFORMA)
    expect(informa).toHaveLength(2)
    expect((await listSaasChargeLines(ownerDb, INFORMA, [informa[0]!.id])).length).toBeGreaterThan(
      0,
    )
  })

  it("una cuenta de otra app no tiene clínica y ninguna clínica la ve", async () => {
    const id = randomUUID()
    await ownerDb.execute(
      sql`insert into admin.saas_account (id, app, external_ref) values (${id}, 'gestoria', 'tienda-calzados')`,
    )
    const [plan] = await rows<{ id: string }>(sql`select id from saas_plan where code = 'dolares'`)
    await ownerDb.execute(
      sql`insert into saas_subscription (organization_id, plan_id, status) values (${id}, ${plan!.id}, 'activa')`,
    )
    await ownerDb.execute(sql`
      insert into saas_charge (organization_id, plan_code, plan_name, period_start, period_end, amount_cents, currency)
      values (${id}, 'dolares', 'Plan odentIA', '2026-11-01', '2026-12-01', 2900, 'USD')`)
    await ownerDb.execute(sql`
      insert into support_case (organization_id, question, dedupe_key, opened_by, kind)
      values (${id}, '¿Cómo cobro?', ${randomUUID()}, ${ADMIN}, 'pregunta')`)
    expect(await outstandingByCurrency(ownerDb, id)).toEqual([{ currency: "USD", cents: 2900 }])
    for (const org of [PEN, INFORMA]) {
      const seen = await asClinic(org, async (tx) => ({
        subs: await tx.execute(
          sql`select organization_id from saas_subscription where organization_id <> ${org}`,
        ),
        charges: await tx.execute(sql`select id from saas_charge where organization_id = ${id}`),
        cases: await tx.execute(sql`select id from support_case where organization_id = ${id}`),
      }))
      expect(seen).toEqual({ subs: [], charges: [], cases: [] })
    }
    // Lo de las clínicas no cambió por tener al lado una cuenta de otra app.
    expect((await money(FUNDADORES)).outstanding).toEqual(
      (moneyBefore[FUNDADORES] as Awaited<ReturnType<typeof money>>).outstanding,
    )
  })

  it("una cuenta nunca se hace pasar por una clínica, ni al revés", async () => {
    const fails = (query: ReturnType<typeof sql>) =>
      expect(ownerDb.execute(query)).rejects.toThrow()
    // El id de una clínica ya es su cuenta.
    await fails(
      sql`insert into admin.saas_account (id, app, external_ref) values (${PEN}, 'gestoria', 'otra')`,
    )
    // Una clínica nueva no toma el id de una cuenta que ya existe.
    const taken = randomUUID()
    await ownerDb.execute(
      sql`insert into admin.saas_account (id, app, external_ref) values (${taken}, 'gestoria', 'tienda-tomada')`,
    )
    await fails(
      sql`insert into organization (id, name, slug, created_at) values (${taken}, 'Intrusa', 'intrusa', now())`,
    )
    // La de una clínica no lleva app ni referencia; la de otra app, siempre, y una por tienda.
    await fails(sql`update admin.saas_account set app = 'gestoria' where id = ${PEN}`)
    await fails(sql`insert into admin.saas_account (id, app) values (${randomUUID()}, 'gestoria')`)
    await fails(
      sql`insert into admin.saas_account (id, app, external_ref) values (${randomUUID()}, 'gestoria', 'tienda-tomada')`,
    )
    await fails(
      sql`insert into admin.saas_account (id, app, external_ref) values (${randomUUID()}, 'otra-app', 'x')`,
    )
    // Una cuenta de odentIA, latidIA o vistIA siempre es una clínica.
    await fails(
      sql`insert into admin.saas_account (id, app, external_ref) values (${randomUUID()}, 'odentia', 'sin-clinica')`,
    )
    // Nada del cobro cuelga de alguien que no es una cuenta.
    await fails(
      sql`insert into saas_subscription (organization_id, status) values ('nadie', 'prueba')`,
    )
    // El rol de la aplicación no lee ni escribe las cuentas.
    await expect(appDb.execute(sql`select id from admin.saas_account limit 1`)).rejects.toThrow()
  })

  it("borrar una clínica se lleva su cuenta y su cobro, como antes", async () => {
    await insertOrg(ownerDb, "cta-borrada", "cta-borrada")
    await ownerDb.execute(sql`
      insert into saas_charge (organization_id, plan_code, plan_name, period_start, period_end, amount_cents, currency)
      values ('cta-borrada', 'soles', 'Plan en soles', '2026-11-01', '2026-12-01', 10000, 'PEN')`)
    await ownerDb.execute(sql`delete from org_profile where organization_id = 'cta-borrada'`)
    await ownerDb.execute(sql`delete from organization where id = 'cta-borrada'`)
    const left = await rows(sql`
      select 'cuenta' from saas_account where id = 'cta-borrada'
      union all select 'suscripción' from saas_subscription where organization_id = 'cta-borrada'
      union all select 'cargo' from saas_charge where organization_id = 'cta-borrada'`)
    expect(left).toEqual([])
  })
})
