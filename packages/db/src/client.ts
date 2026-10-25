import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema/index.js"

/** Handle Drizzle sobre postgres.js. */
export type Db = PostgresJsDatabase<typeof schema>

/**
 * Sin compilación JIT: las consultas de la aplicación son cortas y el JIT de
 * PostgreSQL solo se paga en ellas. Una con subconsultas por fila pasa su
 * umbral de costo (`jit_above_cost`) y compilar le suma ~80 ms a lo que tarda
 * 25 ms (deudas de Inicio). Se fija en la conexión, no en la configuración del
 * servidor, para que valga igual en desarrollo, pruebas y producción.
 */
const connection = { jit: "off" }

/**
 * Rol owner (superuser en dev): migraciones. Bypasea RLS.
 */
export function createOwnerDb(url: string): Db {
  return drizzle(postgres(url, { connection }), { schema })
}

/**
 * Rol dentalagent_app: runtime. Sujeto a RLS — toda lectura de tablas de
 * dominio debe ir dentro de withOrgContext (ver src/context.ts).
 */
export function createAppDb(url: string): Db {
  return drizzle(postgres(url, { connection }), { schema })
}
