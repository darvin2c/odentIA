import { sql } from "drizzle-orm"
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import postgres, { type Sql } from "postgres"
import * as schema from "./schema.js"

export * from "./schema.js"

/** La base de gestorIA, con Drizzle sobre postgres.js. */
export type Db = PostgresJsDatabase<typeof schema>

const connection = { jit: "off" }

/**
 * El dueño de la base (`GESTORIA_DATABASE_URL`): migraciones, la copia de las cuentas y lo que
 * hace el sistema por su cuenta (avisos y revisión de la cuenta). No pasa por las reglas de cada
 * tienda: nunca atiende un pedido de una persona.
 */
export function createOwnerDb(url: string, options: { max?: number } = {}): Db {
  return drizzle(postgres(url, { connection, max: options.max ?? 5 }), { schema })
}

/**
 * El rol de la aplicación (`GESTORIA_APP_DATABASE_URL`, `gestoria_app`): todo pedido de una
 * persona. Sujeto a las reglas de cada tienda: solo lee dentro de `withPerson`.
 */
export function createAppDb(url: string, options: { max?: number } = {}): Db {
  return drizzle(postgres(url, { connection, max: options.max ?? 10 }), { schema })
}

/** Quién pide y en qué tienda: lo verificó el servidor (el token de la cuenta y su equipo). */
export interface PersonContext {
  userId: string
  /** El correo verificado de su cuenta, en minúsculas: con él ve sus invitaciones. */
  email: string
  /** La tienda en la que trabaja; sin ella solo ve sus tiendas y sus invitaciones. */
  storeId?: string
}

/**
 * Corre `fn` en una transacción con quién pide (`app.user_id`, `app.user_email`) y su tienda
 * (`app.store_id`). Las reglas de cada tienda leen esos valores: sin ellos, cero filas. Nunca
 * llegan crudos del navegador: la persona sale del token y la tienda de su equipo.
 */
export async function withPerson<T>(
  db: Db,
  person: PersonContext,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.user_id', ${person.userId}, true),
      set_config('app.user_email', ${person.email.toLowerCase()}, true),
      set_config('app.store_id', ${person.storeId ?? ""}, true)`)
    return fn(tx as unknown as Db)
  })
}

/** Cambia la tienda dentro de la misma transacción (crear una tienda, aceptar una invitación). */
export async function enterStore(tx: Db, storeId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.store_id', ${storeId}, true)`)
}

/**
 * Corre `fn` si nadie más tiene el candado `key` (candado de sesión en una conexión reservada):
 * un trabajo que espera a otro servidor no deja una transacción abierta. Null si estaba tomado.
 * Solo con una conexión de `createOwnerDb` o `createAppDb`, nunca dentro de una transacción.
 */
export async function withSessionLock<T>(
  db: Db,
  key: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const client = (db as unknown as { $client: Sql }).$client
  const reserved = await client.reserve()
  try {
    const [lock] = await reserved<
      { ok: boolean }[]
    >`select pg_try_advisory_lock(hashtext(${key})) as ok`
    if (!lock?.ok) return null
    try {
      return await fn()
    } finally {
      await reserved`select pg_advisory_unlock(hashtext(${key}))`
    }
  } finally {
    reserved.release()
  }
}
