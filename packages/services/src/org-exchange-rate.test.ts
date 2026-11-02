/**
 * La segunda moneda de la clínica: una sola operación la activa y escribe el
 * «Cambio de hoy», la moneda del negocio queda quieta mientras esté activa y el
 * precio de un servicio se elige entre las dos, sin conservar el número.
 */
import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { product } from "@odentia/db/schema/inventory"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  assertNoForeignCurrencyHistory,
  exchangeRateAuthor,
  getCurrencyUsage,
  setOrgExchangeRate,
  updateOrgRegion,
} from "./organization-profile.js"
import { createService, updateService } from "./service-catalog.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

async function clinic(
  region: { countryCode: string; currency: string; timezone: string; locale: string } = {
    countryCode: "PE",
    currency: "PEN",
    timezone: "America/Lima",
    locale: "es-PE",
  },
) {
  const orgId = `org-${randomUUID()}`
  await insertOrg(ownerDb, orgId, orgId)
  await ownerDb.update(orgProfile).set(region).where(eq(orgProfile.organizationId, orgId))
  const actor = randomUUID()
  await ownerDb
    .insert(user)
    .values({ id: actor, name: "Rosa Caja", email: `${actor}@example.test` })
  const run = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  return { orgId, actor, run }
}

const profileOf = async (orgId: string) => {
  const [row] = await ownerDb.select().from(orgProfile).where(eq(orgProfile.organizationId, orgId))
  return row!
}

const auditsOf = (orgId: string) =>
  ownerDb
    .select()
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.organizationId, orgId),
        eq(auditEvent.action, "settings.exchange_rate_updated"),
      ),
    )

const ownService = (orgId: string, currency = "PEN") =>
  ownerDb
    .insert(serviceCatalog)
    .values({
      organizationId: orgId,
      name: `Servicio ${randomUUID()}`,
      scope: "general",
      source: "custom",
      priceCents: 10000,
      currency,
    })
    .returning()

it("activar exige escribir el cambio y deja el cambio, el factor, quién y cuándo", async () => {
  const c = await clinic()
  await expect(
    c.run((tx) => setOrgExchangeRate(tx, c.orgId, c.actor, { secondCurrency: "USD" })),
  ).rejects.toMatchObject({
    code: "VALIDATION",
    fields: { exchangeRate: expect.stringContaining("USD") },
  })
  const before = new Date()
  const saved = await c.run((tx) =>
    setOrgExchangeRate(tx, c.orgId, c.actor, { secondCurrency: "USD", exchangeRate: "3.750" }),
  )
  expect(saved).toMatchObject({
    secondCurrency: "USD",
    exchangeRate: "3.75",
    exchangeFactor: "3.75",
    exchangeRateBy: c.actor,
  })
  expect(saved.exchangeRateAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
  expect(await auditsOf(c.orgId)).toHaveLength(1)
  expect(await c.run((tx) => exchangeRateAuthor(tx, saved))).toBe("Rosa Caja")
})

it("quien cobra cambia solo el cambio; el mismo cambio no dice que lo puso otra persona", async () => {
  const c = await clinic()
  const first = await c.run((tx) =>
    setOrgExchangeRate(tx, c.orgId, c.actor, { secondCurrency: "USD", exchangeRate: "3.75" }),
  )
  const other = randomUUID()
  await ownerDb.insert(user).values({ id: other, name: "Ana", email: `${other}@example.test` })
  const same = await c.run((tx) =>
    setOrgExchangeRate(tx, c.orgId, other, { exchangeRate: "3.7500" }),
  )
  expect(same).toMatchObject({ exchangeRateBy: c.actor })
  expect(same.exchangeRateAt).toEqual(first.exchangeRateAt)
  expect(await auditsOf(c.orgId)).toHaveLength(1)
  const next = await c.run((tx) => setOrgExchangeRate(tx, c.orgId, other, { exchangeRate: "3.8" }))
  expect(next).toMatchObject({
    secondCurrency: "USD",
    exchangeRate: "3.8",
    exchangeFactor: "3.8",
    exchangeRateBy: other,
  })
  expect(await auditsOf(c.orgId)).toHaveLength(2)
})

it("el factor es por unidad menor: una clínica en pesos sin decimales", async () => {
  const c = await clinic({
    countryCode: "CL",
    currency: "CLP",
    timezone: "America/Santiago",
    locale: "es-CL",
  })
  const saved = await c.run((tx) =>
    setOrgExchangeRate(tx, c.orgId, c.actor, { secondCurrency: "USD", exchangeRate: "950" }),
  )
  expect(saved).toMatchObject({ exchangeRate: "950", exchangeFactor: "9.5" })
})

it("lo que no vale se dice en su campo", async () => {
  const c = await clinic()
  const write = (input: Parameters<typeof setOrgExchangeRate>[3]) =>
    c.run((tx) => setOrgExchangeRate(tx, c.orgId, c.actor, input))
  await expect(write({ exchangeRate: "3.75" })).rejects.toMatchObject({
    fields: { exchangeRate: expect.any(String) },
  })
  await expect(write({ secondCurrency: "PEN", exchangeRate: "1" })).rejects.toMatchObject({
    fields: { secondCurrency: expect.any(String) },
  })
  await expect(write({ secondCurrency: "ZZZ", exchangeRate: "1" })).rejects.toMatchObject({
    fields: { secondCurrency: expect.any(String) },
  })
  for (const rate of ["0", "-1", "3,75", "abc"]) {
    await expect(write({ secondCurrency: "USD", exchangeRate: rate }), rate).rejects.toMatchObject({
      fields: { exchangeRate: expect.any(String) },
    })
  }
  expect(await profileOf(c.orgId)).toMatchObject({
    secondCurrency: null,
    exchangeRate: null,
    exchangeFactor: null,
  })
})

it("quitar la otra moneda borra el cambio; sin ella no hay nada que escribir", async () => {
  const c = await clinic()
  const untouched = await c.run((tx) =>
    setOrgExchangeRate(tx, c.orgId, c.actor, { secondCurrency: null }),
  )
  expect(untouched.secondCurrency).toBeNull()
  expect(await auditsOf(c.orgId)).toHaveLength(0)
  await c.run((tx) =>
    setOrgExchangeRate(tx, c.orgId, c.actor, { secondCurrency: "USD", exchangeRate: "3.75" }),
  )
  const removed = await c.run((tx) =>
    setOrgExchangeRate(tx, c.orgId, c.actor, { secondCurrency: null }),
  )
  expect(removed).toMatchObject({
    secondCurrency: null,
    exchangeRate: null,
    exchangeFactor: null,
    exchangeRateAt: null,
    exchangeRateBy: null,
  })
})

it("la moneda del negocio queda quieta con otra moneda activa", async () => {
  const c = await clinic()
  await c.run((tx) =>
    setOrgExchangeRate(tx, c.orgId, c.actor, { secondCurrency: "USD", exchangeRate: "3.75" }),
  )
  await expect(
    c.run((tx) => updateOrgRegion(tx, c.orgId, c.actor, { currency: "EUR" })),
  ).rejects.toMatchObject({
    code: "SECOND_CURRENCY_ACTIVE",
    fields: { currency: expect.stringContaining("USD") },
  })
  // Lo demás de la región se sigue guardando, y la misma moneda no es un cambio.
  const same = await c.run((tx) =>
    updateOrgRegion(tx, c.orgId, c.actor, { currency: "PEN", receiptWidth: "58" }),
  )
  expect(same.receiptWidth).toBe("58")
  await c.run((tx) => setOrgExchangeRate(tx, c.orgId, c.actor, { secondCurrency: null }))
  const moved = await c.run((tx) => updateOrgRegion(tx, c.orgId, c.actor, { currency: "EUR" }))
  expect(moved.currency).toBe("EUR")
})

it("dos monedas como máximo: con movimientos en una, no se activa otra", async () => {
  const c = await clinic()
  await ownService(c.orgId, "USD")
  await expect(
    c.run((tx) =>
      setOrgExchangeRate(tx, c.orgId, c.actor, { secondCurrency: "EUR", exchangeRate: "4" }),
    ),
  ).rejects.toMatchObject({
    code: "CURRENCY_HISTORY_EXISTS",
    fields: { secondCurrency: expect.stringContaining("USD") },
  })
  await c.run((tx) =>
    setOrgExchangeRate(tx, c.orgId, c.actor, { secondCurrency: "USD", exchangeRate: "3.75" }),
  )
  await c.run((tx) => setOrgExchangeRate(tx, c.orgId, c.actor, { secondCurrency: null }))
  await expect(
    c.run((tx) =>
      setOrgExchangeRate(tx, c.orgId, c.actor, { secondCurrency: "EUR", exchangeRate: "4" }),
    ),
  ).rejects.toMatchObject({ code: "CURRENCY_HISTORY_EXISTS" })
})

it("el bloqueo de la moneda también mira productos y lo demás, con el rol de la aplicación", async () => {
  const c = await clinic()
  // Sin nada, recorre todas las tablas sin fallar: el rol de la aplicación las lee todas.
  await c.run((tx) => assertNoForeignCurrencyHistory(tx, c.orgId, "EUR"))
  await ownerDb.insert(product).values({
    organizationId: c.orgId,
    name: "Cepillo",
    sku: randomUUID(),
    unit: "unidad",
    forSale: true,
    salePriceCents: 500,
    saleCurrency: "USD",
  })
  await expect(
    c.run((tx) => assertNoForeignCurrencyHistory(tx, c.orgId, "PEN")),
  ).rejects.toMatchObject({
    code: "CURRENCY_HISTORY_EXISTS",
    fields: { currency: expect.any(String) },
  })
  await expect(
    c.run((tx) => updateOrgRegion(tx, c.orgId, c.actor, { currency: "EUR" })),
  ).rejects.toMatchObject({
    code: "CURRENCY_HISTORY_EXISTS",
  })
})

it("dice lo que ya hay en otra moneda: por cobrar, servicios y efectivo en caja", async () => {
  const c = await clinic()
  expect(await c.run((tx) => getCurrencyUsage(tx, c.orgId, "USD"))).toEqual({
    currency: "USD",
    dueCents: 0,
    services: 0,
    cashCents: 0,
  })
  await ownService(c.orgId, "USD")
  await ownService(c.orgId, "PEN")
  expect(await c.run((tx) => getCurrencyUsage(tx, c.orgId, "USD"))).toMatchObject({ services: 1 })
})

it("con una sola moneda el precio va en ella y nada más cambia", async () => {
  const c = await clinic()
  await expect(
    c.run((tx) =>
      createService(tx, c.orgId, c.actor, {
        name: "Implante",
        scope: "general",
        priceCents: 5000,
        currency: "USD",
      }),
    ),
  ).rejects.toMatchObject({ fields: { currency: expect.stringContaining("PEN") } })
  const [row] = await ownService(c.orgId)
  await expect(
    c.run((tx) =>
      updateService(tx, c.orgId, c.actor, row!.id, { currency: "USD", priceCents: 100 }),
    ),
  ).rejects.toMatchObject({ fields: { currency: expect.stringContaining("PEN") } })
})

// Uruguay no exige código oficial en un servicio propio: lo que se mira aquí es la moneda.
const URUGUAY = {
  countryCode: "UY",
  currency: "UYU",
  timezone: "America/Montevideo",
  locale: "es-UY",
}

it("con segunda moneda, el servicio elige entre las dos y al cambiar exige precio nuevo", async () => {
  const c = await clinic(URUGUAY)
  await c.run((tx) =>
    setOrgExchangeRate(tx, c.orgId, c.actor, { secondCurrency: "USD", exchangeRate: "3.75" }),
  )
  const [row] = await ownService(c.orgId, "UYU")
  await expect(
    c.run((tx) => updateService(tx, c.orgId, c.actor, row!.id, { currency: "USD" })),
  ).rejects.toMatchObject({ fields: { priceCents: expect.stringContaining("USD") } })
  expect(
    await ownerDb
      .select({ currency: serviceCatalog.currency, priceCents: serviceCatalog.priceCents })
      .from(serviceCatalog)
      .where(eq(serviceCatalog.id, row!.id)),
  ).toEqual([{ currency: "UYU", priceCents: 10000 }])
  const moved = await c.run((tx) =>
    updateService(tx, c.orgId, c.actor, row!.id, { currency: "USD", priceCents: 100000 }),
  )
  expect(moved).toMatchObject({ currency: "USD", priceCents: 100000 })
  // Una tercera, no. Repetir la que tiene no pide precio.
  await expect(
    c.run((tx) =>
      updateService(tx, c.orgId, c.actor, row!.id, { currency: "EUR", priceCents: 100 }),
    ),
  ).rejects.toMatchObject({ fields: { currency: expect.stringContaining("USD") } })
  const kept = await c.run((tx) =>
    updateService(tx, c.orgId, c.actor, row!.id, { currency: "USD", name: "Implante unitario" }),
  )
  expect(kept).toMatchObject({ currency: "USD", priceCents: 100000, name: "Implante unitario" })
})

it("un servicio en dólares de antes vuelve a la moneda del negocio aunque ya no haya segunda", async () => {
  const c = await clinic(URUGUAY)
  const [row] = await ownService(c.orgId, "USD")
  const edited = await c.run((tx) =>
    updateService(tx, c.orgId, c.actor, row!.id, { name: "Sigue en dólares" }),
  )
  expect(edited.currency).toBe("USD")
  const moved = await c.run((tx) =>
    updateService(tx, c.orgId, c.actor, row!.id, { currency: "UYU", priceCents: 37500 }),
  )
  expect(moved).toMatchObject({ currency: "UYU", priceCents: 37500 })
})
