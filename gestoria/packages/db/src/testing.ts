import { fileURLToPath } from "node:url"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { createAppDb, createOwnerDb, type Db } from "./index.js"
import { MIGRATIONS_FOLDER } from "./migrate.js"

/**
 * Una base de gestorIA para las pruebas, preparada como en producción: PostgreSQL de la misma
 * versión, `gestoria/infra/crear-base.sh` corrido con el superusuario (así se prueba también el
 * script) y las migraciones con su dueño, que no es superusuario. Solo para pruebas: nunca se
 * importa desde lo que corre en producción.
 */
const IMAGE = process.env.GESTORIA_TEST_PG_IMAGE ?? "postgres:18.6-bookworm"
const SCRIPT = fileURLToPath(new URL("../../../infra/crear-base.sh", import.meta.url))
const OWNER_PASSWORD = "gestoria"
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
    // La base de las clínicas de mentira: el script le quita el permiso de conectarse a gestorIA.
    .withEnvironment({
      POSTGRES_DB: "dentalagent",
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
    })
    .withCopyFilesToContainer([{ source: SCRIPT, target: "/tmp/crear-base.sh" }])
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start()
  const prepared = await container.exec(["bash", "/tmp/crear-base.sh"], {
    env: {
      POSTGRES_URL: "postgres://postgres:postgres@localhost/postgres",
      GESTORIA_OWNER_PASSWORD: OWNER_PASSWORD,
      GESTORIA_APP_PASSWORD: TEST_APP_PASSWORD,
      CLINICS_DB: "dentalagent",
    },
  })
  if (prepared.exitCode !== 0) throw new Error(`crear-base.sh falló: ${prepared.output}`)
  const at = `${container.getHost()}:${container.getMappedPort(5432)}/gestoria`
  const ownerUrl = `postgres://gestoria:${OWNER_PASSWORD}@${at}`
  const ownerDb = createOwnerDb(ownerUrl, { max: 3 })
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
