import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

/** Handle Drizzle sobre postgres.js. */
export type Db = PostgresJsDatabase<typeof schema>;

/**
 * Rol owner (superuser en dev): migraciones. Bypasea RLS.
 */
export function createOwnerDb(url: string): Db {
  return drizzle(postgres(url), { schema });
}

/**
 * Rol dentalagent_app: runtime. Sujeto a RLS — toda lectura de tablas de
 * dominio debe ir dentro de withOrgContext (ver src/context.ts).
 */
export function createAppDb(url: string): Db {
  return drizzle(postgres(url), { schema });
}
