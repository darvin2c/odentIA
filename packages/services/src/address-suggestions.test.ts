import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { addressLookupDay } from "@odentia/db/schema/org"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  ADDRESS_DAILY_LIMIT,
  type AddressProvider,
  addressSearchesToday,
  type MapAddress,
  resolveAddress,
  suggestAddresses,
} from "./address-suggestions.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const larco: MapAddress = {
  line: "Av. José Larco 345",
  city: "Miraflores",
  district: "Provincia de Lima",
  regionName: "Provincia de Lima",
  regionCode: null,
  postalCode: "15074",
  country: "PE",
  placeId: "ChIJ-larco",
}

/** Un proveedor de mentira: cuenta lo que se le pidió y nunca sale a internet. */
function fakeProvider(overrides: Partial<AddressProvider> = {}) {
  const asked: string[] = []
  const provider: AddressProvider = {
    attribution: "Mapa de prueba",
    async suggest({ text }) {
      asked.push(text)
      return [
        { id: "a", main: "Av. José Larco 345", secondary: "Miraflores, Perú", isPlace: false, address: larco },
        { id: "b", main: "Dental Smile Miraflores", secondary: "Av. José Larco 345, Miraflores", isPlace: true, address: null },
      ]
    },
    async resolve() {
      return larco
    },
    ...overrides,
  }
  return { provider, asked }
}

async function clinic(): Promise<{ orgId: string; run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> }> {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, orgId)
  return { orgId, run: (fn) => withOrgContext(appDb, orgId, fn) }
}

it("sugiere desde la tercera letra y lleva la región a la lista del país (issue 36)", async () => {
  const { orgId, run } = await clinic()
  const { provider, asked } = fakeProvider()
  const short = await run((tx) => suggestAddresses(tx, orgId, provider, "paciente", { text: "Av", session: randomUUID() }))
  expect(short).toEqual({ available: true, attribution: "Mapa de prueba", suggestions: [] })
  expect(asked).toEqual([])

  const found = await run((tx) => suggestAddresses(tx, orgId, provider, "paciente", { text: "Av. José Larco 3", session: randomUUID() }))
  expect(found.available).toBe(true)
  // «Provincia de Lima» es Lima Metropolitana en la lista ISO 3166-2 de Perú.
  expect(found.suggestions[0]?.address).toMatchObject({ line: "Av. José Larco 345", city: "Miraflores", region: "PE-LMA", country: "PE" })
  expect(found.suggestions[1]?.address).toBeNull()
  const picked = await run((tx) => resolveAddress(tx, orgId, provider, "sede", { id: "b", session: randomUUID() }))
  expect(picked).toMatchObject({ region: "PE-LMA", placeId: "ChIJ-larco" })
  expect(await addressSearchesToday(ownerDb, "paciente")).toBeGreaterThanOrEqual(1)
})

it("sin proveedor, sin respuesta o pasado el tope del día, no hay sugerencias: los campos de siempre", async () => {
  const { orgId, run } = await clinic()
  const session = randomUUID()
  expect(await run((tx) => suggestAddresses(tx, orgId, null, "sede", { text: "Av. Larco", session }))).toEqual({
    available: false,
    attribution: null,
    suggestions: [],
  })
  const failing = fakeProvider({
    async suggest() {
      throw new Error("HTTP 503")
    },
  })
  expect((await run((tx) => suggestAddresses(tx, orgId, failing.provider, "sede", { text: "Av. Larco", session }))).available).toBe(false)

  // La clínica ya gastó las búsquedas de hoy: ni se le pregunta al proveedor.
  await ownerDb
    .insert(addressLookupDay)
    .values({ organizationId: orgId, day: sql`current_date`, purpose: "paciente", searches: ADDRESS_DAILY_LIMIT.paciente })
  const { provider, asked } = fakeProvider()
  expect((await run((tx) => suggestAddresses(tx, orgId, provider, "paciente", { text: "Av. Larco", session }))).available).toBe(false)
  expect(asked).toEqual([])
  // El tope es de cada clínica y de cada uso: la sede de esta misma clínica sigue.
  expect((await run((tx) => suggestAddresses(tx, orgId, provider, "sede", { text: "Av. Larco", session }))).available).toBe(true)
})
