process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createOwnerDb, type Db } from "@odentia/db"
import { kairosWeekly } from "@odentia/db/schema/admin-arm"
import { ServiceError } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { type Context, Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { errorBody } from "../lib/error.js"
import { createAdminReportsRoute } from "./admin-reports.js"

/**
 * Reportes del ARM contra Postgres real: solo Administración (llevan
 * importes), cada cifra con cómo se calcula, y el resumen de la semana que
 * escribió Kairós en su tabla, que la app de las clínicas no alcanza.
 */

const IMAGE = "dentalagent-postgres:18.6"
let container: StartedTestContainer
let ownerDb: Db
let app: Hono

/** El cuerpo de una respuesta de prueba: su forma la comprueba cada `expect`. */
// biome-ignore lint/suspicious/noExplicitAny: el cuerpo de una respuesta de prueba se lee suelto
async function read(response: Response): Promise<any> {
  return response.json()
}

function call(path: string, role: "admin" | "support") {
  return app.request(`/api/admin/reports${path}`, {
    headers: { "x-test-user": `rp-${role}`, "x-test-role": role },
  })
}

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
  const url = `${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${url}`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  // El guard real lo prueba admin-core; aquí el actor llega ya resuelto, como lo deja el guard.
  app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    c.set("adminActor", { userId: c.req.header("x-test-user"), role: c.req.header("x-test-role") })
    await next()
  })
  app.onError((err, c) => {
    if (err instanceof ServiceError)
      return c.json(errorBody(c, err.code, err.message, err.fields), err.status)
    console.error(err)
    return c.json(errorBody(c, "INTERNAL", "Error interno"), 500)
  })
  app.route("/api/admin/reports", createAdminReportsRoute({ ownerDb }))
})

afterAll(async () => {
  await container?.stop()
})

describe("reportes", () => {
  it("Soporte no ve ningún reporte", async () => {
    for (const path of ["/funnel", "/revenue", "/forecast", "/weekly"]) {
      const res = await call(path, "support")
      expect(res.status, path).toBe(403)
      expect(await read(res)).toMatchObject({ error: { code: "FORBIDDEN" } })
    }
  })

  it("Administración ve el embudo, los ingresos y la previsión, cada cifra con cómo se calcula", async () => {
    const funnel = await read(await call("/funnel?months=3", "admin"))
    expect(funnel.data).toMatchObject({
      months: 3,
      clients: { value: 0, words: expect.any(String), howCalculated: expect.any(String) },
      conversion: { words: "Sin casos" },
    })
    const revenue = await read(await call("/revenue", "admin"))
    expect(revenue.data).toMatchObject({
      paying: { value: 0, howCalculated: expect.any(String) },
      collected: { amounts: [], howCalculated: expect.any(String) },
    })
    const forecast = await read(await call("/forecast", "admin"))
    expect(forecast.data).toMatchObject({ proposals: { value: 0 }, rows: [] })
  })

  it("rechaza meses fuera de rango, con su campo", async () => {
    const res = await call("/funnel?months=99", "admin")
    expect(res.status).toBe(400)
    expect(await read(res)).toMatchObject({
      error: { code: "VALIDATION", fields: { months: expect.any(String) } },
    })
    expect((await call("/revenue?months=0", "admin")).status).toBe(400)
  })

  it("la semana: nada hasta que Kairós la escribe; después, la última con las cifras que citó", async () => {
    expect(await read(await call("/weekly", "admin"))).toEqual({ data: null })
    await ownerDb.insert(kairosWeekly).values([
      { weekStart: "2026-11-02", text: "La semana anterior", figures: [] },
      {
        weekStart: "2026-11-09",
        text: "Entraron 2 clínicas.",
        figures: [{ label: "Clínicas que pagan", words: "2 clínicas" }],
      },
    ])
    const body = await read(await call("/weekly", "admin"))
    expect(body.data).toMatchObject({
      weekStart: "2026-11-09",
      text: "Entraron 2 clínicas.",
      figures: [{ label: "Clínicas que pagan", words: "2 clínicas" }],
    })
  })

  it("la app de las clínicas no alcanza la tabla de la semana", async () => {
    const [row] = [
      ...(await ownerDb.execute<{ reach: boolean }>(
        sql`select has_table_privilege('dentalagent_app', 'admin.kairos_weekly', 'select, insert, update, delete') as reach`,
      )),
    ]
    expect(row?.reach).toBe(false)
  })
})
