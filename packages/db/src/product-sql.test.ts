// En la base, lo que decide por producto también tiene que nombrarlos a todos
// (ADR 0079): una vista, una función o una restricción que nombra un producto y
// no otro lo deja caer en silencio en su ELSE, o lo rechaza. Así, al agregar un
// producto, esta prueba señala cada objeto de la base que tiene que decir algo
// de él, como el compilador señala los mapas del código.
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { CLINICAL_PRODUCTS, type ClinicalProduct } from "@odentia/clinical"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createOwnerDb, type Db } from "./client.js"

const IMAGE = "dentalagent-postgres:18.6"

/**
 * Los productos que un objeto no nombra a propósito, con su motivo: los cubre su
 * ELSE (la regla de odentIA es la de siempre y la de latidIA, la excepción) o el
 * código. Un producto nuevo no entra aquí solo: quien lo agrega decide en cada
 * objeto si tiene su rama o le sirve lo que ya hace.
 */
const UNNAMED_ON_PURPOSE: Record<string, readonly ClinicalProduct[]> = {
  // «¿Pagó?» del embudo: lo dental pide el presupuesto aceptado (0001).
  "vista argos.embudo": ["dental"],
  // El área de quien atiende: «odontología» fuera de latidIA (0036).
  "vista argos.equipo": ["dental"],
  // Las condiciones de pago que nacen con un consultorio de latidIA (0025).
  "función public.org_profile_budget_terms": ["dental"],
  // La prueba que abre la clínica al nacer usa el plan de odentIA: aún no sabe su
  // producto, y `startSaasTrial` la corrige para los demás (ADR 0093).
  "función public.saas_trial_on_org_create": ["medical"],
}

let container: StartedTestContainer
let ownerDb: Db

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
    .withCommand(["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=dentalagent"])
    .start()
  ownerDb = createOwnerDb(
    `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  )
  await migrate(ownerDb, { migrationsFolder: "./drizzle" })
})

afterAll(async () => {
  await container?.stop()
})

describe("lo que la base decide por producto nombra a todos los productos", () => {
  it("ninguna vista, función o restricción deja un producto en el ELSE sin decirlo", async () => {
    const rows = (await ownerDb.execute(sql`
      select 'vista ' || schemaname || '.' || viewname as object, definition as body
        from pg_views where schemaname not in ('pg_catalog', 'information_schema')
      union all
      select 'vista ' || schemaname || '.' || matviewname, definition
        from pg_matviews where schemaname not in ('pg_catalog', 'information_schema')
      union all
      select 'función ' || n.nspname || '.' || p.proname, p.prosrc
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname not in ('pg_catalog', 'information_schema') and p.prokind in ('f', 'p')
      union all
      select 'restricción ' || c.conrelid::regclass::text || '.' || c.conname, pg_get_constraintdef(c.oid)
        from pg_constraint c where c.contype = 'c'
    `)) as unknown as { object: string; body: string | null }[]

    const named = rows
      .map(({ object, body }) => ({
        object,
        products: CLINICAL_PRODUCTS.filter((product) => body?.includes(`'${product}'`)),
      }))
      .filter((row) => row.products.length > 0)

    const missing = named.flatMap(({ object, products }) => {
      const absent = CLINICAL_PRODUCTS.filter(
        (product) => !products.includes(product) && !UNNAMED_ON_PURPOSE[object]?.includes(product),
      )
      return absent.length > 0 ? [`${object}: no dice qué pasa en ${absent.join(", ")}`] : []
    })
    expect(missing, "Agrega su rama o decláralo en UNNAMED_ON_PURPOSE con su motivo").toEqual([])
    // La lista de excepciones no guarda objetos que ya no existen o que ya no nombran productos.
    expect(Object.keys(UNNAMED_ON_PURPOSE).filter((object) => !named.some((row) => row.object === object))).toEqual([])
  })
})
