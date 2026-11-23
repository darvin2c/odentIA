import {
  accountCopy,
  contractRequestReceipt,
  type Db,
  store,
  storeEvent,
  storeMember,
} from "@gestoria/db"
import { type AdminRequest, type AdminRequestResult, adminRequest } from "@odentia/contract"
import { and, count, eq, sql } from "drizzle-orm"
import { type ContractConfig, noteStoreAccount } from "./acuerdo.js"
import { verifyMessage } from "./firma.js"
import { receiveSupportRequest } from "./soporte.js"
import { isCurrency } from "./tiendas.js"

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
  now: Date,
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
  await tx.insert(store).values({
    id: data.account,
    name: data.name,
    currency: data.currency,
    country: data.country,
    createdBy: data.owner.userId,
  })
  await tx
    .insert(storeMember)
    .values({ storeId: data.account, userId: data.owner.userId, role: "owner" })
  await tx.insert(storeEvent).values({
    storeId: data.account,
    actorUserId: null,
    action: "tienda.creada",
    subject: data.owner.userId,
    detail: {
      por: "administracion",
      name: data.name,
      currency: data.currency,
      country: data.country,
    },
  })
  // La administración ya la tiene: este aviso solo la pone al día con lo que quedó.
  await noteStoreAccount(tx, data.account, now)
  return { status: "hecho", message: "Tienda abierta: su dueño ya puede entrar." }
}

/** Quita a una persona de la tienda, con el motivo. La tienda nunca se queda sin Dueño. */
async function removePerson(
  tx: Db,
  data: Extract<AdminRequest, { type: "equipo.quitar" }>["data"],
  now: Date,
): Promise<Result> {
  const storeId = data.account
  const [shop] = await tx.select({ id: store.id }).from(store).where(eq(store.id, storeId))
  if (!shop) return { status: "fallo", message: "Esa tienda no existe en gestorIA." }
  // Se toma la fila de cada dueño antes de contar, como al quitar desde la tienda.
  await tx
    .select()
    .from(storeMember)
    .where(and(eq(storeMember.storeId, storeId), eq(storeMember.role, "owner")))
    .for("update")
  const [target] = await tx
    .select({ role: storeMember.role })
    .from(storeMember)
    .where(and(eq(storeMember.storeId, storeId), eq(storeMember.userId, data.userId)))
  if (!target) return { status: "hecho", message: "Esa persona ya no estaba en la tienda." }
  if (target.role === "owner") {
    const [{ value }] = (await tx
      .select({ value: count() })
      .from(storeMember)
      .where(and(eq(storeMember.storeId, storeId), eq(storeMember.role, "owner")))) as [
      { value: number },
    ]
    if (value <= 1)
      return {
        status: "fallo",
        message: "Es el único Dueño de la tienda: antes, la tienda tiene que tener otro Dueño.",
      }
  }
  await tx
    .delete(storeMember)
    .where(and(eq(storeMember.storeId, storeId), eq(storeMember.userId, data.userId)))
  await tx.insert(storeEvent).values({
    storeId,
    actorUserId: null,
    action: "equipo.quitado",
    subject: data.userId,
    detail: { role: target.role, por: "administracion", motivo: data.reason },
  })
  if (target.role === "owner") await noteStoreAccount(tx, storeId, now)
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
        ? await openStore(tx, parsed.data, now)
        : parsed.type === "equipo.quitar"
          ? await removePerson(tx, parsed.data, now)
          : await receiveSupportRequest(tx, parsed.data, now)
    await tx.insert(contractRequestReceipt).values({
      webhookId: id,
      type: parsed.type,
      storeId: /^[0-9a-f-]{36}$/i.test(parsed.data.account) ? parsed.data.account : null,
      status: result.status,
      message: result.message,
      receivedAt: now,
    })
    return result
  })
  return { status: 200, body }
}
