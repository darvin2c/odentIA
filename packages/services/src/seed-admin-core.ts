/**
 * Semilla demo del personal interno (AuthCore). Idempotente: por id fijo, solo
 * crea lo que falta. Cuentas INTERNAS separadas (jamás miembros de ORG_A/B,
 * sin tocar sus finanzas ni activar automatizaciones). Sin factor preconocido:
 * el segundo factor se enrola en la UI. Solo datos de demo identificables.
 */

import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { account, user } from "@odentia/db/schema/auth"
import { hashPassword } from "better-auth/crypto"
import { eq } from "drizzle-orm"
import { writeAdminAudit } from "./admin-core.js"

/** Ids fijos estables para semillas y referencias cruzadas demo. */
export const SEED_STAFF_ADMIN_ID = "seed-staff-admin"
export const SEED_STAFF_SUPPORT_ID = "seed-staff-support"

/** Solo semilla demo. Nunca en código ni 1Password real. */
const SEED_PASSWORD = "Demo1234"

const DEMO_STAFF = [
  {
    id: SEED_STAFF_ADMIN_ID,
    name: "Ada Administradora (demo)",
    firstName: "Ada",
    lastName: "Administradora",
    email: "admin@odentia.dev",
    role: "admin" as const,
  },
  {
    id: SEED_STAFF_SUPPORT_ID,
    name: "Sofía Soporte (demo)",
    firstName: "Sofía",
    lastName: "Soporte",
    email: "support@odentia.dev",
    role: "support" as const,
  },
]

export async function seedAdminCore(
  tx: Db,
): Promise<{ adminUserId: string; supportUserId: string }> {
  const passwordHash = await hashPassword(SEED_PASSWORD)
  for (const demo of DEMO_STAFF) {
    const [existingUser] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, demo.id))
      .limit(1)
    if (!existingUser) {
      await tx.insert(user).values({
        id: demo.id,
        name: demo.name,
        firstName: demo.firstName,
        lastName: demo.lastName,
        email: demo.email,
        emailVerified: true,
      })
      await tx.insert(account).values({
        id: randomUUID(),
        accountId: demo.id,
        providerId: "credential",
        userId: demo.id,
        password: passwordHash,
      })
    }
    const [existingStaff] = await tx
      .select({ userId: adminStaff.userId })
      .from(adminStaff)
      .where(eq(adminStaff.userId, demo.id))
      .limit(1)
    if (!existingStaff) {
      await tx.insert(adminStaff).values({ userId: demo.id, role: demo.role, active: true })
      await writeAdminAudit(tx, null, {
        action: "staff.bootstrap",
        entityId: demo.id,
        metadata: { email: demo.email, seed: true },
      })
    }
  }
  return { adminUserId: SEED_STAFF_ADMIN_ID, supportUserId: SEED_STAFF_SUPPORT_ID }
}
