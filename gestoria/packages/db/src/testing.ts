import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { createAppDb, createOwnerDb, type Db } from "./index.js"
import { MIGRATIONS_FOLDER } from "./migrate.js"

/**
 * Una base de gestorIA para las pruebas: PostgreSQL de la misma versión que producción, con el
 * dueño y el rol de la aplicación como en `gestoria/infra/crear-base.sql`, y las migraciones.
 * Solo para pruebas: nunca se importa desde lo que corre en producción.
 */
const IMAGE = process.env.GESTORIA_TEST_PG_IMAGE ?? "postgres:18.6-bookworm"
export const TEST_APP_PASSWORD = "gestoria_app"

export interface TestDb {
  container: StartedTestContainer
  ownerDb: Db
  appDb: Db
  ownerUrl: string
  stop: () => Promise<void>
}

export async function startTestDb(): Promise<TestDb> {
  const container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: "gestoria",
      POSTGRES_USER: "gestoria",
      POSTGRES_PASSWORD: "gestoria",
    })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start()
  const at = `${container.getHost()}:${container.getMappedPort(5432)}/gestoria`
  const ownerUrl = `postgres://gestoria:gestoria@${at}`
  const ownerDb = createOwnerDb(ownerUrl, { max: 3 })
  await ownerDb.execute(sql.raw(`CREATE ROLE gestoria_app LOGIN PASSWORD '${TEST_APP_PASSWORD}'`))
  await migrate(ownerDb, { migrationsFolder: MIGRATIONS_FOLDER })
  const appDb = createAppDb(`postgres://gestoria_app:${TEST_APP_PASSWORD}@${at}`, { max: 3 })
  return {
    container,
    ownerDb,
    appDb,
    ownerUrl,
    stop: async () => {
      await container.stop()
    },
  }
}
