import { sql } from "drizzle-orm"
import type { Db } from "./client.js"

/**
 * Ejecuta fn dentro de una transacción con el GUC app.org_id fijado.
 * Las policies RLS (org_isolation) leen ese GUC; sin él, cero filas.
 * Invariante de tenancy: el orgId llega verificado desde el servidor
 * (membresía/subdominio), nunca de un id crudo del cliente.
 */
export async function withOrgContext<T>(
  db: Db,
  orgId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`)
    return fn(tx as Db)
  })
}
