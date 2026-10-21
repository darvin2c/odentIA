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
  const short = await suggestAddresses(run, orgId, provider, "paciente", { text: "Av", session: randomUUID() })
  expect(short).toEqual({ available: true, attribution: "Mapa de prueba", suggestions: [] })
  expect(asked).toEqual([])

  const found = await suggestAddresses(run, orgId, provider, "paciente", { text: "Av. José Larco 3", session: randomUUID() })
  expect(found.available).toBe(true)
  // «Provincia de Lima» es Lima Metropolitana en la lista ISO 3166-2 de Perú.
  expect(found.suggestions[0]?.address).toMatchObject({ line: "Av. José Larco 345", city: "Miraflores", region: "PE-LMA", country: "PE" })
  expect(found.suggestions[1]?.address).toBeNull()
  const picked = await resolveAddress(run, orgId, provider, "sede", { id: "b", session: randomUUID() })
  expect(picked).toMatchObject({ region: "PE-LMA", placeId: "ChIJ-larco" })
  expect(await addressSearchesToday(ownerDb, "paciente")).toBeGreaterThanOrEqual(1)
})

it("sin proveedor, sin respuesta o pasado el tope del día, no hay sugerencias: los campos de siempre", async () => {
  const { orgId, run } = await clinic()
  const session = randomUUID()
  expect(await suggestAddresses(run, orgId, null, "sede", { text: "Av. Larco", session })).toEqual({
    available: false,
    attribution: null,
    suggestions: [],
  })
  const failing = fakeProvider({
    async suggest() {
      throw new Error("HTTP 503")
    },
  })
  expect((await suggestAddresses(run, orgId, failing.provider, "sede", { text: "Av. Larco", session })).available).toBe(false)

  // La clínica ya gastó las búsquedas de hoy: ni se le pregunta al proveedor.
  await ownerDb
    .insert(addressLookupDay)
    .values({ organizationId: orgId, day: sql`current_date`, purpose: "paciente", searches: ADDRESS_DAILY_LIMIT.paciente })
  const { provider, asked } = fakeProvider()
  expect((await suggestAddresses(run, orgId, provider, "paciente", { text: "Av. Larco", session })).available).toBe(false)
  expect(asked).toEqual([])
  // El tope es de cada clínica y de cada uso: la sede de esta misma clínica sigue.
  expect((await suggestAddresses(run, orgId, provider, "sede", { text: "Av. Larco", session })).available).toBe(true)
})

it("el proveedor responde fuera de la transacción: mientras tanto, el contador del día no queda bloqueado", async () => {
  const { orgId, run } = await clinic()
  let locked: boolean | null = null
  const { provider } = fakeProvider({
    async suggest() {
      // Otra búsqueda de la misma clínica mientras el proveedor responde: no espera al contador.
      locked = await ownerDb
        .execute(sql`select searches from address_lookup_day where organization_id = ${orgId} for update nowait`)
        .then(
          () => false,
          () => true,
        )
      return []
    },
  })
  await suggestAddresses(run, orgId, provider, "sede", { text: "Av. Larco", session: randomUUID() })
  expect(locked).toBe(false)
})
