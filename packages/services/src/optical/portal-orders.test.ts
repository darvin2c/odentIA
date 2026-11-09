import { createHash, randomBytes, randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { portalLink } from "@odentia/db/schema/portal"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { clinicalFixture } from "../clinical-test-fixture.js"
import { advanceJobOrder, createJobOrderSale } from "../job-orders.js"
import { createPortalGrant } from "../portal-access.js"
import { upsertPortalPolicy } from "../portal-policy.js"
import { exchangePortalToken, listPortalOrders, requirePortalSession } from "../portal.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "../test-setup.js"

/**
 * «Tus pedidos» en el portal (entrega 5 de vistIA, ADR 0169): lo que se encargó,
 * si ya está listo y lo que falta pagar, con «Su cuenta»; quien no la ve no los ve.
 */
setupTestDb()
const ORG = "org_optica_portal"
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

beforeAll(async () => {
  await insertOrg(ownerDb, ORG, "optica-portal")
  await ownerDb.update(orgProfile).set({ product: "optical" }).where(eq(orgProfile.organizationId, ORG))
})

async function portalFor(account: boolean) {
  const f = await clinicalFixture(ORG)
  const [actor, patientId] = [f.args[1], f.args[2]]
  const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: `Sede ${randomUUID()}` }).returning({ id: branch.id })
  const { order } = await f.run((tx) =>
    createJobOrderSale(tx, ...f.args, {
      branchId: site!.id,
      requestId: randomUUID(),
      title: "Anteojos progresivos",
      maker: "Laboratorio Visión Andina",
      promisedOn: new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10),
      lines: [{ kind: "lunas", description: "Lunas progresivas", amountCents: 45_000 }],
    }),
  )
  await f.run((tx) => advanceJobOrder(tx, ORG, actor, order.id, { status: "listo" }))
  const raw = randomBytes(32).toString("base64url")
  await withOrgContext(appDb, ORG, async (tx) => {
    await upsertPortalPolicy(tx, ORG, actor, {
      enabled: true,
      allowedScope: { appointments: true, budgets: true, account, documents: true },
    })
    await createPortalGrant(tx, ORG, actor, {
      patientId,
      contactId: f.patient.personId,
      relationship: "self",
      scope: { budgets: true, account },
      verifiedMethod: "presencial_documento",
      evidenceNote: "Documento revisado en recepción.",
    })
    await tx.insert(portalLink).values({
      organizationId: ORG,
      patientId,
      contactId: f.patient.personId,
      scope: { appointments: false, budgets: true, account, documents: [] },
      tokenHash: hash(raw),
      pinHash: hash("123456"),
      status: "pendiente",
      expiresAt: new Date(Date.now() + 3600_000),
      createdBy: actor,
    })
  })
  const opened = await withOrgContext(appDb, ORG, (tx) => exchangePortalToken(tx, ORG, raw, { pin: "123456" }))
  return { order, list: () => withOrgContext(appDb, ORG, async (tx) => listPortalOrders(tx, await requirePortalSession(tx, ORG, opened.sessionToken))) }
}

it("el portal dice el pedido listo para recoger y lo que falta pagar", async () => {
  const { order, list } = await portalFor(true)
  const { items } = await list()
  expect(items).toEqual([
    expect.objectContaining({ id: order.id, title: "Anteojos progresivos", ready: true, statusLabel: "Listo", dueCents: 45_000, currency: "PEN" }),
  ])
  expect(JSON.stringify(items)).not.toContain("prescription")
})

it("quien no ve su cuenta en el portal no ve sus pedidos", async () => {
  const { list } = await portalFor(false)
  await expect(list()).rejects.toThrow()
})
