import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { saasCharge, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { branchAddressWriter, createBranch, getBranchDirections } from "./branches.js"
import { getClinicNotices } from "./clinic-notices.js"
import { saasTaxOf } from "./saas-actions.js"
import { createSaasPlan, listClinicPlans } from "./saas-billing.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * El desacople de Perú se demuestra aquí y no en la semilla (que sigue siendo
 * peruana, pedido del 2026-10-11): una clínica de Colombia, en pesos y es-CO,
 * con su sede, «Cómo llegar», su plan y sus avisos, sin nada de un país ajeno.
 */
setupTestDb()

const DAY = 86_400_000

async function colombianClinic(): Promise<{ orgId: string; run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> }> {
  const orgId = `co-${randomUUID().slice(0, 8)}`
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values (${orgId}, 'Sonrisa Andina', ${orgId}, now())`)
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "trade_name", "country_code", "currency", "timezone", "locale")
        values (${orgId}, 'Sonrisa Andina S.A.S.', 'Sonrisa Andina', 'CO', 'COP', 'America/Bogota', 'es-CO')`,
  )
  return { orgId, run: (fn) => withOrgContext(appDb, orgId, fn) }
}

it("una clínica de Colombia tiene su sede, su «Cómo llegar», su plan y sus avisos sin nada de Perú (issue 36)", async () => {
  const { orgId, run } = await colombianClinic()

  // La sede: la región se escribe (Colombia aún no tiene lista en su perfil) y hay código postal.
  const sede = await run((tx) =>
    createBranch(tx, orgId, "config-test", {
      name: "Sede Chapinero",
      addressLine1: "Calle 93 # 11-26",
      city: "Bogotá",
      region: "Bogotá D. C.",
      postalCode: "110221",
    }),
  )
  expect(sede).toMatchObject({ country: "CO", region: "Bogotá D. C.", slug: "chapinero" })
  const line = await run(async (tx) => (await branchAddressWriter(tx, orgId))({ line: sede.addressLine1, city: sede.city, region: sede.region, postalCode: sede.postalCode, country: sede.country }))
  expect(line).toBe("Calle 93 # 11-26 · Bogotá, Bogotá D. C. · 110221")
  const { url } = await run((tx) => getBranchDirections(tx, orgId, "chapinero"))
  expect(decodeURIComponent(url.replaceAll("+", " "))).toContain("Sonrisa Andina, Calle 93 # 11-26, Bogotá, Bogotá D. C., Colombia")

  // Sin perfil fiscal de Colombia, la factura de odentIA no suma un impuesto ajeno (nada de IGV).
  expect(await run((tx) => saasTaxOf(tx, orgId))).toBeNull()

  // El plan es en dólares para todas (ADR 0031): a una clínica en pesos se le ofrece igual.
  await ownerDb.insert(user).values({ id: `${orgId}-admin`, name: "Administración", email: `${orgId}@admin.test` })
  await ownerDb.update(saasPlan).set({ isDefault: false })
  const plan = await createSaasPlan(ownerDb, `${orgId}-admin`, { code: `${orgId}-lista`, name: "Plan odentIA", currency: "USD", priceCents: 2900, isDefault: true })
  expect((await run((tx) => listClinicPlans(tx, orgId))).map((row) => row.currency)).toEqual(["USD"])

  // El aviso del cargo habla como en Colombia: «USD 32,76», no «USD 32.76».
  const owner = randomUUID()
  await ownerDb.insert(user).values({ id: owner, name: "Camila Rojas", email: `${owner}@sonrisa.test` })
  await ownerDb.insert(member).values({ id: randomUUID(), userId: owner, organizationId: orgId, role: "owner", createdAt: new Date() })
  const values = {
    status: "activa" as const,
    planId: plan.id,
    trialEndsAt: null,
    currentPeriodStart: new Date(Date.now() - 10 * DAY),
    currentPeriodEnd: new Date(Date.now() + 20 * DAY),
  }
  await ownerDb
    .insert(saasSubscription)
    .values({ organizationId: orgId, ...values })
    .onConflictDoUpdate({ target: saasSubscription.organizationId, set: values })
  await ownerDb.insert(saasCharge).values({
    organizationId: orgId,
    planId: plan.id,
    planCode: plan.code,
    planName: plan.name,
    periodStart: new Date(Date.UTC(2026, 9, 1)),
    periodEnd: new Date(Date.UTC(2026, 10, 1)),
    amountCents: 3276,
    currency: "USD",
    dueAt: new Date(Date.now() + 6 * DAY),
    dedupeKey: randomUUID(),
  })
  const notices = await run((tx) => getClinicNotices(tx, orgId, { userId: owner, role: "owner" }))
  // Intl separa el código con un espacio que no se parte (U+00A0).
  expect(notices[0]?.message).toMatch(/USD\s32,76/)
})
