process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, Wait } from "testcontainers"
import { expect, it } from "vitest"
import { createOwnerDb } from "./client.js"

const exec = promisify(execFile)

it("el importador real concilia, es idempotente y no reactiva una edición retirada", async () => {
  const container = await new GenericContainer("dentalagent-postgres:18.6")
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
  const url = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  const db = createOwnerDb(url)
  const seed = () =>
    exec(process.execPath, ["--import", "tsx", "src/seed-procedure-codes.ts"], {
      env: { ...process.env, DATABASE_URL: url },
    })
  const snapshot = async () =>
    JSON.stringify(
      await db.execute(sql`
    select 'release' as kind, row_to_json(r)::text as value from procedure_catalog_release r
    union all select 'code', row_to_json(c)::text from procedure_code c
    union all select 'template', row_to_json(t)::text from treatment_template t
    union all select 'mapping', row_to_json(m)::text from treatment_template_code m
    order by kind, value`),
    )
  try {
    await migrate(db, { migrationsFolder: "./drizzle" })
    await seed()
    const first = await snapshot()
    await seed()
    expect(await snapshot()).toBe(first)
    const [coverage] = await db.execute<{
      expected: number
      available: number
      exact: boolean
    }>(sql`
      select r.expected_count as expected, count(t.id)::int as available,
        bool_and(t.name=c.display) as exact
      from procedure_catalog_release r
      join procedure_code c on c.system_key=r.system_key and c.version=r.version
      join treatment_template_code m on m.system_key=c.system_key and m.code=c.code and m.version=c.version
      join treatment_template t on t.id=m.template_id
      where r.is_current and c.is_active and t.is_active group by r.expected_count`)
    expect(coverage).toEqual({ expected: 505, available: 505, exact: true })
    // Simula una actualización posterior: la edición instalada pasa a histórica.
    await db.transaction(async (tx) => {
      await tx.execute(sql`update procedure_catalog_release set is_current=false`)
      await tx.execute(sql`insert into procedure_catalog_release
        (system_key,version,scope,source_url,source_sha256,expected_count,is_current)
        select system_key,'edicion-posterior-prueba',scope,source_url,source_sha256,expected_count,true
        from procedure_catalog_release where version='RM-550-2023-MINSA'`)
      await tx.execute(sql`update procedure_code set is_active=false`)
      await tx.execute(sql`update treatment_template set is_active=false`)
    })
    const retired = await snapshot()
    await expect(seed()).rejects.toMatchObject({ code: 1 })
    expect(await snapshot()).toBe(retired)
    // Los vínculos exactos retirados siguen resolubles para lectura histórica.
    const [preserved] = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from treatment_template_code`,
    )
    expect(preserved?.count).toBe(505)
  } finally {
    await Reflect.get(db, "$client").end()
    await container.stop()
  }
}, 180_000)
