import type { Db } from "@odentia/db"
import * as schema from "@odentia/db/schema/index"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

export function openFixtureDb(url: string): { db: Db; close(): Promise<void> } {
  const client = postgres(url, { max: 1 })
  return { db: drizzle(client, { schema }), close: () => client.end() }
}
