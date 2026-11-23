import { accountCopy, contractRequestReceipt, type Db, store, storeMember } from "@gestoria/db"
import { type AdminRequest, type AdminRequestResult, adminRequest } from "@odentia/contract"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import type { ContractConfig } from "./acuerdo.js"
import { verifyMessage } from "./firma.js"
import { receiveSupportRequest } from "./soporte.js"
import { isCurrency, openStoreIn, removeMemberIn, StoreError } from "./tiendas.js"

/**
 * Lo que la administración le pide a gestorIA por el acuerdo (ADR 0213, tablero 3 del lienzo A):
 * abrir la tienda de un cliente con su plan, dejar entrar a soporte y quitar a una persona. Lo
 * de cada app se queda en la app: aquí se decide cómo, con las reglas de la tienda.
 *
 * Llega firmado con el secreto del acuerdo (`GESTORIA_CONTRACT_SECRET`); sin él no existe. La
 * clave (`webhook-id`) y su efecto van juntos (`contract_request_receipt`): repetido, la misma
 * respuesta sin hacer nada otra vez. Responde «hecho» o «falló» con su motivo; si algo se cae a
 * mitad, no queda nada y la administración reintenta con la misma clave.
 */

export interface RequestReceipt {
  status: 200 | 400 | 401 | 404
  body: AdminRequestResult | { message: string }
}

type Result = { status: "hecho" | "fallo"; message: string }

/** Abre la tienda de un cliente con el id que eligió la administración, a nombre de su dueño. */
async function openStore(
  tx: Db,
  data: Extract<AdminRequest, { type: "cuenta.abrir" }>["data"],
): Promise<Result> {
  const [existing] = await tx.select({ id: store.id }).from(store).where(eq(store.id, data.account))
  if (existing) return { status: "hecho", message: "La tienda ya estaba abierta." }
  if (!isCurrency(data.currency))
    return { status: "fallo", message: `gestorIA no vende en ${data.currency}: elige otra moneda.` }
  // La copia de su cuenta: la de la administración hasta que entre (cada token la pone al día).
  await tx
    .insert(accountCopy)
    .values({ userId: data.owner.userId, name: data.owner.name, email: data.owner.email })
    .onConflictDoNothing()
  const [copy] = await tx
    .select({ state: accountCopy.state })
    .from(accountCopy)
    .where(eq(accountCopy.userId, data.owner.userId))
  if (copy?.state !== "activa")
    return { status: "fallo", message: "La cuenta de esa persona está cerrada o bloqueada." }
  await openStoreIn(tx, {
    id: data.account,
    name: data.name,
    currency: data.currency,
    country: data.country,
    ownerId: data.owner.userId,
    actorUserId: null,
    detail: {
      por: "administracion",
      name: data.name,
      currency: data.currency,
      country: data.country,
    },
  })
  return { status: "hecho", message: "Tienda abierta: su dueño ya puede entrar." }
}

/** Quita a una persona de la tienda, con el motivo. La tienda nunca se queda sin Dueño. */
async function removePerson(
  tx: Db,
  data: Extract<AdminRequest, { type: "equipo.quitar" }>["data"],
): Promise<Result> {
  const storeId = data.account
  const [shop] = await tx.select({ id: store.id }).from(store).where(eq(store.id, storeId))
  if (!shop) return { status: "fallo", message: "Esa tienda no existe en gestorIA." }
  const [target] = await tx
    .select({ role: storeMember.role })
    .from(storeMember)
    .where(and(eq(storeMember.storeId, storeId), eq(storeMember.userId, data.userId)))
  if (!target) return { status: "hecho", message: "Esa persona ya no estaba en la tienda." }
  try {
    // Con su propio punto de vuelta: si dejaría la tienda sin Dueño, no queda nada hecho.
    await tx.transaction((inner) =>
      removeMemberIn(inner as unknown as Db, storeId, data.userId, null, {
        por: "administracion",
        motivo: data.reason,
      }),
    )
  } catch (error) {
    if (error instanceof StoreError && error.code === "LAST_OWNER")
      return {
        status: "fallo",
        message: "Es el único Dueño de la tienda: antes, la tienda tiene que tener otro Dueño.",
      }
    throw error
  }
  return { status: "hecho", message: "Quitada de la tienda." }
}

/** Recibe un pedido firmado de la administración y lo aplica una sola vez. */
export async function receiveAdminRequest(
  ownerDb: Db,
  config: Pick<ContractConfig, "secret">,
  request: { headers: Headers; body: string },
  now = new Date(),
): Promise<RequestReceipt> {
  if (!config.secret) return { status: 404, body: { message: "Recurso no encontrado" } }
  const id = verifyMessage({
    secret: config.secret,
    headers: request.headers,
    body: request.body,
    now,
  })
  if (!id) return { status: 401, body: { message: "Firma inválida" } }
  let parsed: AdminRequest
  try {
    parsed = adminRequest.parse(JSON.parse(request.body))
  } catch {
    return { status: 400, body: { message: "Pedido ilegible" } }
  }
  const body = await ownerDb.transaction(async (tx) => {
    // Dos entregas del mismo pedido a la vez: una espera a la otra y lee su respuesta.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pedido:${id}`}, 0))`)
    const [seen] = await tx
      .select()
      .from(contractRequestReceipt)
      .where(eq(contractRequestReceipt.webhookId, id))
    if (seen) return { status: seen.status, message: seen.message }
    const result =
      parsed.type === "cuenta.abrir"
        ? await openStore(tx, parsed.data)
        : parsed.type === "equipo.quitar"
          ? await removePerson(tx, parsed.data)
          : await receiveSupportRequest(tx, parsed.data, now)
    await tx.insert(contractRequestReceipt).values({
      webhookId: id,
      type: parsed.type,
      storeId: z.uuid().safeParse(parsed.data.account).success ? parsed.data.account : null,
      status: result.status,
      message: result.message,
      receivedAt: now,
    })
    return result
  })
  return { status: 200, body }
}
