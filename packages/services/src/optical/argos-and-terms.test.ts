import { member, user } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { runArgosQuery } from "../argos-query.js"
import { appDb, ownerDb, setupTestDb } from "../test-setup.js"

setupTestDb()

/**
 * Lo que la base decide para una óptica (migración 0069): Argos dice
 * «optometría» del área de quien atiende, y la óptica nace con las condiciones
 * de pago por atención, como un consultorio.
 */
describe("la base con una óptica de vistIA", () => {
  it("nace con las condiciones de pago por atención y Argos dice «optometría»", async () => {
    const orgId = "org_optica_argos"
    await ownerDb.execute(
      sql`insert into "organization" ("id", "name", "slug", "created_at") values (${orgId}, 'Óptica Argos', 'optica-argos', now())`,
    )
    await ownerDb.execute(
      sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale", "product")
          values (${orgId}, 'Óptica Argos S.A.C.', 'PE', 'PEN', 'America/Lima', 'es-PE', 'optical')`,
    )
    const [profile] = await ownerDb
      .select({ terms: orgProfile.budgetPaymentTerms })
      .from(orgProfile)
      .where(eq(orgProfile.organizationId, orgId))
    expect(profile?.terms).toBe(
      "Cada atención se paga cuando se realiza. Puede dejar un adelanto, que se descuenta de lo siguiente que deba.",
    )

    await ownerDb.insert(user).values({ id: "optometra-argos", name: "Lic. Rosa Vega", email: "rosa@optica-argos.test" })
    await ownerDb
      .insert(member)
      .values({ id: "m-optometra-argos", userId: "optometra-argos", organizationId: orgId, role: "clinician", createdAt: new Date() })
    const result = await runArgosQuery(appDb, {
      orgId,
      memberRole: "owner",
      query: "select rol from equipo where profesional = 'Lic. Rosa Vega'",
    })
    expect(result.rows).toEqual([{ rol: "optometría" }])
  })
})
