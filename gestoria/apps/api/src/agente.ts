import { type Db, withPerson } from "@gestoria/db"
import { z } from "zod"
import { StoreError } from "./tiendas.js"

/**
 * Sofi y Argos en la base (paso B5): entran con el rol de la aplicación y un remitente propio,
 * nunca con el dueño de la base. Así pasan por las mismas reglas de cada tienda que una persona
 * (solo ven la suya) y la base les niega lo que nunca hacen: confirmar un pago, mover el stock
 * o cambiar la configuración (`drizzle/0007_reglas_sofi.sql`). Ninguna cuenta tiene un id que
 * empiece con «agente:».
 */
export const SOFI_ACTOR = "agente:sofi"
export const ARGOS_ACTOR = "agente:argos"
export type AgentActor = typeof SOFI_ACTOR | typeof ARGOS_ACTOR

/** Si quien pide es un agente (Sofi o Argos): las reglas de la base lo reconocen igual. */
export const isAgent = (actorUserId: string) => actorUserId.startsWith("agente:")

/** El nombre con que se ve en la historia de un pedido o de una conversación. */
export function agentName(actorUserId: string | null): string | null {
  if (actorUserId === SOFI_ACTOR) return "Sofi"
  if (actorUserId === ARGOS_ACTOR) return "Argos"
  return null
}

/** Corre `fn` en la tienda como el agente: una transacción con sus reglas. */
export async function withAgent<T>(
  appDb: Db,
  actor: AgentActor,
  storeId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  if (!z.uuid().safeParse(storeId).success)
    throw new StoreError(404, "NOT_FOUND", "No encontramos esa tienda")
  return withPerson(appDb, { userId: actor, email: "", storeId }, fn)
}
