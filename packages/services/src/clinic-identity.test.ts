/**
 * Un solo nombre visible (decisión 19): el nombre comercial, en «Su enlace»,
 * en WhatsApp y en la cuenta. La razón social solo respalda datos viejos.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { findClinicName } from "./automation-routing.js"
import { clinicNameOf } from "./booking-links.js"
import { clinicDisplayName } from "./clinic-identity.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

it("«Su enlace», WhatsApp y la cuenta dicen el nombre comercial; vacío, la razón social", async () => {
  const orgId = `org_${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  await ownerDb
    .update(orgProfile)
    .set({ legalName: "Dental Sonrisa S.A.C.", tradeName: "Sonrisa" })
    .where(eq(orgProfile.organizationId, orgId))
  // La página que abre el botón del WhatsApp («Su enlace») y el WhatsApp dicen lo mismo.
  expect(await run((tx) => clinicNameOf(tx, orgId))).toBe("Sonrisa")
  expect(await run((tx) => findClinicName(tx, orgId))).toBe("Sonrisa")
  expect(await run((tx) => clinicDisplayName(tx, orgId))).toBe("Sonrisa")
  // La cuenta (chat web, registro, pantallas) lee la misma copia.
  const [account] = await ownerDb.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId))
  expect(account?.name).toBe("Sonrisa")
  // Sin nombre comercial (datos viejos), la base pone la razón social.
  await ownerDb.update(orgProfile).set({ tradeName: "  " }).where(eq(orgProfile.organizationId, orgId))
  expect(await run((tx) => clinicNameOf(tx, orgId))).toBe("Dental Sonrisa S.A.C.")
  const [after] = await ownerDb.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId))
  expect(after?.name).toBe("Dental Sonrisa S.A.C.")
})
