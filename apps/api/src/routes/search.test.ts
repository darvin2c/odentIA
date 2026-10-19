// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver rls.test.ts).
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { type SearchEmbedder, type Storage, secretsKeyFromEnv } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createSearchRoute } from "./search.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))
const ORG = "org_buscar_api"
const USER = "api-buscar-actor"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db
let patientId = ""

const storageStub = {} as Storage

function buildApp(role: string, embedder?: SearchEmbedder): Hono {
  const app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    c.set("orgId", ORG)
    c.set("userId", USER)
    c.set("memberRole", role)
    await next()
  })
  app.route(
    "/search",
    createSearchRoute({
      db: appDb,
      secretsKey: KEY,
      storage: storageStub,
      validateExternal: false,
      webhookBaseUrl: "https://api.example.com",
      embedder,
    }),
  )
  return app
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
  const host = `${container.getHost()}:${container.getMappedPort(5432)}`
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${host}/dentalagent`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}/dentalagent`)
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values (${ORG}, 'Clínica Buscar', 'buscar-api', now())`,
  )
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values (${USER}, 'Equipo Buscar', 'buscar@example.test')`,
  )
  const [paciente] = await ownerDb.execute<{ id: string }>(sql`
    with pp as (insert into "contact" ("organization_id", "display_name") values (${ORG}, 'María Luisa Paz') returning "id")
    insert into "patient" ("organization_id", "person_id", "patient_number") select ${ORG}, pp."id", 22 from pp returning "id"`)
  patientId = paciente!.id
  await ownerDb.execute(sql`insert into "clinical_note" ("organization_id", "patient_id", "author_user_id", "note")
    values (${ORG}, ${patientId}, ${USER}, 'Bruxismo nocturno: se indica placa de descarga')`)
  await ownerDb.execute(sql`insert into "service_catalog" ("organization_id", "name", "source", "price_cents", "currency", "duration_min")
    values (${ORG}, 'Urgencia dental', 'custom', 8000, 'PEN', 30)`)
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

const accessRows = async () =>
  (await ownerDb.execute<{ resource: string; hits: number }>(
    sql`select resource, hits from clinical_access_log where organization_id = ${ORG} and patient_id = ${patientId}`,
  )) as unknown as Array<{ resource: string; hits: number }>

it("sin texto suficiente responde 400; con texto, cada resultado con su dueño", async () => {
  expect((await buildApp("reception").request("/search?q=m")).status).toBe(400)
  const response = await buildApp("reception").request("/search?q=maria")
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    data: { owners: Array<{ title: string; kind: string }> }
  }
  expect(body.data.owners.map((owner) => owner.title)).toContain("María Luisa Paz")
})

it("lo clínico que se mostró queda en el registro de accesos; recepción no lo ve ni deja traza", async () => {
  const reception = await buildApp("reception").request("/search?q=bruxismo")
  expect(((await reception.json()) as { data: { owners: unknown[] } }).data.owners).toEqual([])
  expect(await accessRows()).toEqual([])

  const dentist = await buildApp("dentist").request("/search?q=bruxismo")
  const body = (await dentist.json()) as {
    data: { owners: Array<{ items: Array<{ kind: string }> }> }
  }
  expect(body.data.owners[0]?.items[0]?.kind).toBe("nota")
  expect(await accessRows()).toEqual([{ resource: "notas", hits: 1 }])
})

it("el filtro rechaza un tipo inventado", async () => {
  expect((await buildApp("owner").request("/search?q=maria&tipos=persona,otra")).status).toBe(400)
})

it("un nombre o algo de la historia nunca va al proveedor de vectores; un servicio sí", async () => {
  const sent: string[][] = []
  const counting: SearchEmbedder = {
    model: "contado",
    embed: async (texts) => {
      sent.push(texts)
      return texts.map(() => [0.1, 0.2, 0.3])
    },
  }
  await buildApp("owner", counting).request("/search?q=maria luisa")
  await buildApp("dentist", counting).request("/search?q=bruxismo")
  expect(sent).toEqual([])
  await buildApp("owner", counting).request("/search?q=me duele una muela")
  expect(sent).toEqual([["me duele una muela"]])
  // La misma frase no se paga dos veces.
  await buildApp("owner", counting).request("/search?q=me duele una muela")
  expect(sent).toHaveLength(1)
})

it("sin vectores, o si no llegan a tiempo, quedan los resultados por letras", async () => {
  const slow: SearchEmbedder = { model: "lento", embed: () => new Promise(() => {}) }
  const started = Date.now()
  const response = await buildApp("owner", slow).request("/search?q=urgencia")
  expect(response.status).toBe(200)
  expect(Date.now() - started).toBeLessThan(5_000)
  const body = (await response.json()) as {
    data: { owners: Array<{ title: string }>; meaning: unknown[] }
  }
  expect(body.data.owners.map((owner) => owner.title)).toContain("Urgencia dental")
  expect(body.data.meaning).toEqual([])
})
