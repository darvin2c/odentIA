// Arranque Postgres de prueba (misma imagen/init que rls.test.ts).
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll } from "vitest"

const IMAGE = "dentalagent-postgres:18.6"

export let container: StartedTestContainer
export let ownerDb: Db
export let appDb: Db

export async function insertOrg(db: Db, id: string, slug: string): Promise<void> {
  await db.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at")
        values (${id}, ${"Clínica " + slug}, ${slug}, now())
        on conflict do nothing`,
  )
}

export function setupTestDb(): void {
  beforeAll(async () => {
    container = await new GenericContainer(IMAGE)
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_DB: "dentalagent",
        POSTGRES_USER: "dentalagent",
        POSTGRES_PASSWORD: "dentalagent",
        POSTGRES_APP_PASSWORD: "dentalagent_app",
      })
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .withCommand([
        "postgres",
        "-c",
        "shared_preload_libraries=pg_cron",
        "-c",
        "cron.database_name=dentalagent",
      ])
      .start()
    const uri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
    ownerDb = createOwnerDb(uri)
    await migrate(ownerDb, { migrationsFolder: "../db/drizzle" })
    appDb = createAppDb(
      `postgres://dentalagent_app:dentalagent_app@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
    )
    await insertOrg(ownerDb, "org_a", "norte")
    await insertOrg(ownerDb, "org_b", "sur")
  }, 180_000)
}
