import { AsyncLocalStorage } from "node:async_hooks"
import { sql } from "drizzle-orm"
import type { Db } from "./client.js"

/**
 * Los pedidos que solo pueden leer: soporte mirando una clínica con su permiso.
 * Toda transacción de `withOrgContext` abierta dentro de `runReadOnly` es de
 * solo lectura en la base: aunque una ruta intentara escribir, PostgreSQL lo
 * rechaza. La API lo usa además de rechazar todo lo que no es lectura.
 */
const readOnlyRequests = new AsyncLocalStorage<true>()

/** Corre `fn` (y todo lo que espere) con las transacciones de la clínica en solo lectura. */
export function runReadOnly<T>(fn: () => T): T {
  return readOnlyRequests.run(true, fn)
}

/** Corre `fn` fuera del solo lectura: lo que el sistema anota por su cuenta (la traza de lo leído). */
export function runOutsideReadOnly<T>(fn: () => T): T {
  return readOnlyRequests.exit(fn)
}

/** ¿Este pedido solo puede leer? */
export function isReadOnlyRequest(): boolean {
  return readOnlyRequests.getStore() === true
}

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
  const readOnly = isReadOnlyRequest()
  return db.transaction(async (tx) => {
    // Tiene que ser lo primero de la transacción.
    if (readOnly) await tx.execute(sql`set transaction read only`)
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`)
    return fn(tx as Db)
  })
}
