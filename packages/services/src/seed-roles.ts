import type { Db } from "@odentia/db"
import { LEGAL } from "@odentia/auth/legal"
import { account, member, user } from "@odentia/db/schema/auth"
import { hashPassword } from "better-auth/crypto"
import { and, eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"

/**
 * Usuarios operativos de demostración para ORG_A: recepción, odontólogo y
 * caja con la misma clave demo del seed principal (`Demo1234`). Idempotente:
 * crea lo que falta y fija el rol operativo si la membresía ya existe.
 *
 * Purge seguro (padre, antes de parents): member de estos usuarios en la org
 * → account credential de estos usuarios → user. Sin tablas nuevas.
 */
const SEED_PASSWORD = "Demo1234"

const ROLE_USERS = [
  {
    id: "seed-user-recepcion",
    email: "recepcion@odentia.dev",
    name: "Recepción Demo",
    firstName: "Recepción",
    lastName: "Demo",
    role: "reception",
  },
  {
    id: "seed-user-dentista",
    email: "dentista@odentia.dev",
    name: "Dr. Demo Odontólogo",
    firstName: "Demo",
    lastName: "Odontólogo",
    role: "clinician",
  },
  {
    id: "seed-user-caja",
    email: "caja@odentia.dev",
    name: "Caja Demo",
    firstName: "Caja",
    lastName: "Demo",
    role: "cashier",
  },
] as const

export async function seedRoles(
  tx: Db,
  input: { orgId: string; ownerUserId: string; branchId: string; patientId: string; contactId: string },
): Promise<void> {
  const passwordHash = await hashPassword(SEED_PASSWORD)
  for (const seed of ROLE_USERS) {
    const existingUser = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, seed.id))
      .limit(1)
    if (existingUser.length === 0) {
      await tx.insert(user).values({
        id: seed.id,
        name: seed.name,
        firstName: seed.firstName,
        lastName: seed.lastName,
        email: seed.email,
        emailVerified: true,
        // Ya aceptaron los documentos vigentes: entrar no pasa por «Un paso antes de seguir».
        termsVersion: LEGAL.terms.version,
        termsAcceptedAt: new Date(),
      })
    }
    const existingAccount = await tx
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, seed.id), eq(account.providerId, "credential")))
      .limit(1)
    if (existingAccount.length === 0) {
      await tx.insert(account).values({
        id: randomUUID(),
        accountId: seed.id,
        providerId: "credential",
        userId: seed.id,
        password: passwordHash,
      })
    }
    const existingMember = await tx
      .select({ id: member.id, role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, input.orgId), eq(member.userId, seed.id)))
      .limit(1)
    if (existingMember.length === 0) {
      await tx.insert(member).values({
        id: randomUUID(),
        organizationId: input.orgId,
        userId: seed.id,
        role: seed.role,
        createdAt: new Date(),
      })
    } else if (existingMember[0]?.role !== seed.role && existingMember[0]) {
      await tx.update(member).set({ role: seed.role }).where(eq(member.id, existingMember[0].id))
    }
  }
}
