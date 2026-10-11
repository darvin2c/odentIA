import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { organizationPaymentMethod } from "@odentia/db/schema/org-payments"
import { expect, it } from "vitest"
import { updateOrgRegion } from "./organization-profile.js"
import { ensureDefaultPaymentMethods, listPaymentMethods, requirePaymentMethod, updatePaymentMethod } from "./payment-methods.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

it("inicializa medios una sola vez y no reactiva el que la clínica apagó", async () => {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, orgId)
  const initialize = () => withOrgContext(appDb, orgId, (tx) => ensureDefaultPaymentMethods(tx, orgId, "config-test", "PE"))
  const [first, concurrent] = await Promise.all([initialize(), initialize()])
  expect(first.map((method) => method.id).sort()).toEqual(concurrent.map((method) => method.id).sort())
  expect(first.map((method) => method.name)).toEqual(["Efectivo", "Yape", "Plin", "Tarjeta", "Transferencia"])
  const transfer = first.find((method) => method.typeCode === "30")!
  await withOrgContext(appDb, orgId, (tx) => updatePaymentMethod(tx, orgId, "config-test", transfer.id, { isActive: false }))
  await initialize()
  const active = await withOrgContext(appDb, orgId, (tx) => listPaymentMethods(tx, orgId, { activeOnly: true }))
  expect(active.some((method) => method.id === transfer.id)).toBe(false)
  const all = await withOrgContext(appDb, orgId, (tx) => listPaymentMethods(tx, orgId, { activeOnly: false }))
  expect(all.find((method) => method.id === transfer.id)?.isActive).toBe(false)
  await expect(withOrgContext(appDb, orgId, (tx) => requirePaymentMethod(tx, orgId, transfer.id))).rejects.toMatchObject({ status: 400 })
})

it("un perfil chileno no hereda moneda, formato ni billeteras peruanas", async () => {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, orgId)
  const profile = await withOrgContext(appDb, orgId, (tx) => updateOrgRegion(tx, orgId, "config-test", { countryCode: "CL", applyCountryPreset: true }))
  expect(profile).toMatchObject({ countryCode: "CL", currency: "CLP", locale: "es-CL", timezone: "America/Santiago" })
  const methods = await withOrgContext(appDb, orgId, (tx) => listPaymentMethods(tx, orgId))
  expect(methods.map((method) => method.typeCode)).toEqual(["10", "48", "30"])
  expect(methods.some((method) => method.name === "Yape" || method.name === "Plin")).toBe(false)
})

it("no permite leer ni escribir medios de otra organización aunque se conozca su identificador", async () => {
  const orgId = randomUUID()
  const other = randomUUID()
  await insertOrg(ownerDb, orgId, orgId)
  await insertOrg(ownerDb, other, other)
  const methods = await withOrgContext(appDb, orgId, (tx) => ensureDefaultPaymentMethods(tx, orgId, "config-test", "PE"))
  await expect(withOrgContext(appDb, other, (tx) => requirePaymentMethod(tx, other, methods[0]!.id))).rejects.toMatchObject({ status: 404 })
  await expect(withOrgContext(appDb, other, (tx) => tx.insert(organizationPaymentMethod).values({ organizationId: orgId, name: "Cruce indebido", typeCode: "10" }))).rejects.toThrow()
})
