import type { Db } from "@odentia/db"
import {
  isSaasAccountExternalApp,
  type SaasAccountExternalApp,
  saasAccount,
} from "@odentia/db/schema/admin-accounts"
import { eq } from "drizzle-orm"

/**
 * La cuenta de una app que es otro sistema (ADR 0210 y 0211): la de una tienda de gestorIA, sin
 * organización. Lo que la app dijo de ella (nombre, país y dueño) es lo único que la
 * administración sabe; lo demás vive en la app.
 */
export interface ExternalAccount {
  id: string
  app: SaasAccountExternalApp
  externalRef: string
  name: string | null
  country: string | null
  ownerUserId: string | null
  syncedAt: Date | null
  createdAt: Date
}

/**
 * La cuenta de otra app con ese id, o null si es una clínica o no existe. Solo con la conexión
 * propietaria: el rol de la aplicación no lee las cuentas, y lo de una clínica nunca llega aquí.
 */
export async function externalAccountOf(
  tx: Db,
  accountId: string,
): Promise<ExternalAccount | null> {
  const [row] = await tx.select().from(saasAccount).where(eq(saasAccount.id, accountId)).limit(1)
  return row ? toExternalAccount(row) : null
}

export function toExternalAccount(row: typeof saasAccount.$inferSelect): ExternalAccount | null {
  if (row.organizationId !== null || !isSaasAccountExternalApp(row.app) || row.externalRef === null)
    return null
  return {
    id: row.id,
    app: row.app,
    externalRef: row.externalRef,
    name: row.name,
    country: row.country,
    ownerUserId: row.ownerUserId,
    syncedAt: row.syncedAt,
    createdAt: row.createdAt,
  }
}
