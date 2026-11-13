// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver rls.test.ts).
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createOwnerDb, type Db } from "./client.js"

// El ARM de la administración (0106 y 0107): los clientes, su gente, su venta y sus envíos. La
// base se migra primero hasta antes de las reglas, con datos como los de producción
// (organizaciones, demos, solicitudes y su bitácora), para ver el traslado; después, las reglas.

const IMAGE = "dentalagent-postgres:18.6"
const APP_ROLE = "dentalagent_app"
const FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle")

let container: StartedTestContainer
let ownerDb: Db
let before: string

const ADA = "staff-ada"
const BETO = "staff-beto"

const ORG_ENTERED = "org_andes"
const ORG_ALONE = "org_sola"
const ORG_DEMO_SUB = "org_demo_suscripcion"
const ORG_DEMO_ROW = "org_demo_receta"

const PLAN = "b0000000-0000-4000-8000-000000000001"
const DEMO = "d0000000-0000-4000-8000-000000000001"

const ENTERED = "a0000000-0000-4000-8000-000000000001"
const OPEN = "a0000000-0000-4000-8000-000000000002"
const PAST_DATE = "a0000000-0000-4000-8000-000000000003"
const LAST_WITHOUT_DATE = "a0000000-0000-4000-8000-000000000004"
const DISCARDED = "a0000000-0000-4000-8000-000000000005"

const LONG_REASON = `Ya tiene un sistema y no quiere cambiar. ${"Mucho texto. ".repeat(50)}`

function migrationsBefore(suffix: string): string {
  const journal = JSON.parse(readFileSync(join(FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[]
  }
  const position = journal.entries.findIndex((entry) => entry.tag.endsWith(suffix))
  if (position < 0) throw new Error(`falta la migración «${suffix}» en el journal`)
  const entries = journal.entries.slice(0, position)
  const dir = mkdtempSync(join(tmpdir(), "odentia-arm-"))
  mkdirSync(join(dir, "meta"))
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }))
  for (const entry of entries)
    cpSync(join(FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  return dir
}

function rows<T>(result: unknown): T[] {
  return result as T[]
}

function violates(constraint: string) {
  return { cause: { code: "23514", constraint_name: constraint } }
}

async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  const [row] = rows<T>(await ownerDb.execute(query))
  if (row === undefined) throw new Error("La consulta no devolvió ninguna fila")
  return row
}

async function insertOrg(id: string, name: string, profile?: { product: string; country: string }) {
  await ownerDb.execute(sql`
    insert into "organization" ("id", "name", "slug", "created_at") values (${id}, ${name}, ${id.replaceAll("_", "-")}, '2026-10-01T12:00:00Z')`)
  if (profile)
    await ownerDb.execute(sql`
      insert into "org_profile" ("organization_id", "legal_name", "trade_name", "country_code", "currency", "timezone", "locale", "product")
      values (${id}, ${name}, ${name}, ${profile.country}, 'CLP', 'America/Santiago', 'es-CL', ${profile.product})`)
}

async function insertRequest(
  id: string,
  input: {
    status?: string
    email: string
    phone: string
    createdAt: string
    extra?: ReturnType<typeof sql>
  },
) {
  await ownerDb.execute(sql`
    insert into "saas_waitlist_request"
      ("id", "first_name", "last_name", "email", "phone", "clinic_name", "country_code", "city",
       "professionals", "current_tool", "product", "created_at", "updated_at")
    values (${id}::uuid, 'Lucía', 'Quispe', ${input.email}, ${input.phone}, ${`Clínica ${id.slice(-1)}`}, 'PE',
      ' Arequipa ', '2-3', 'cuaderno_excel', 'dental', ${input.createdAt}::timestamptz, ${input.createdAt}::timestamptz)`)
}

async function insertEntry(
  subject: { requestId?: string; organizationId?: string },
  followUpOn: string | null,
  at: string,
) {
  await ownerDb.execute(sql`
    insert into "saas_follow_up" ("request_id", "organization_id", "author_user_id", "body", "follow_up_on", "created_at")
    values (${subject.requestId ?? null}::uuid, ${subject.organizationId ?? null}, ${ADA}, 'Le escribí por WhatsApp',
      ${followUpOn}::date, ${at}::timestamptz)`)
}

async function clientOf(requestId: string): Promise<string> {
  const row = await one<{ client_id: string }>(
    sql`select "client_id" from "saas_waitlist_request" where "id" = ${requestId}::uuid`,
  )
  return row.client_id
}

async function newClient(name: string): Promise<string> {
  const row = await one<{ id: string }>(
    sql`insert into "saas_client" ("name", "product") values (${name}, 'dental') returning "id"`,
  )
  return row.id
}

async function newProposal(clientId: string, version: number): Promise<string> {
  const row = await one<{ id: string }>(sql`
    insert into "saas_proposal" ("client_id", "version", "plan_id", "list_price_cents", "currency", "valid_until")
    values (${clientId}::uuid, ${version}, ${PLAN}::uuid, 19900, 'PEN', '2026-12-31') returning "id"`)
  return row.id
}

async function newContact(clientId: string, name: string, primary = false): Promise<string> {
  const row = await one<{ id: string }>(sql`
    insert into "saas_client_contact" ("client_id", "name", "is_primary") values (${clientId}::uuid, ${name}, ${primary})
    returning "id"`)
  return row.id
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
  ownerDb = createOwnerDb(
    `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  )
  before = migrationsBefore("_arm_reglas")
  await migrate(ownerDb, { migrationsFolder: before })

  await ownerDb.execute(sql`
    insert into "user" ("id", "name", "email") values
      (${ADA}, 'Ada', 'ada@example.test'),
      (${BETO}, 'Beto', 'beto@example.test')`)
  await ownerDb.execute(sql`
    insert into "saas_plan" ("id", "code", "name", "currency", "price_cents", "product")
    values (${PLAN}::uuid, 'fundadores-arm', 'Fundadores', 'PEN', 19900, 'dental')`)

  // Organizaciones: una que entró por su solicitud (latidIA, en Chile), una sin solicitud ni
  // perfil y dos demos para presentar (marcada en su suscripción y con su receta).
  await insertOrg(ORG_ENTERED, "Consultorio Andes", { product: "medical", country: "CL" })
  await insertOrg(ORG_ALONE, "Dental Sola")
  await insertOrg(ORG_DEMO_SUB, "Demo marcada", { product: "dental", country: "PE" })
  await ownerDb.execute(
    sql`update "saas_subscription" set "is_demo" = true where "organization_id" = ${ORG_DEMO_SUB}`,
  )
  await insertOrg(ORG_DEMO_ROW, "Demo con receta")
  await ownerDb.execute(sql`
    insert into "saas_demo" ("id", "organization_id", "product", "kind", "size", "months", "country_code", "name", "slug",
      "presenter_user_id", "created_by", "seed", "status")
    values (${DEMO}::uuid, ${ORG_DEMO_ROW}, 'dental', 'general', 'pequeno', 6, 'PE', 'Demo con receta', 'demo-con-receta',
      ${ADA}, ${ADA}, 1, 'lista')`)

  // Solicitudes: la que entró, una viva con fecha para volver, otra cuya fecha ya pasó, otra
  // cuya última entrada no tiene fecha y una descartada con un motivo largo.
  await insertRequest(ENTERED, {
    email: "andes@example.test",
    phone: "+56 9 8765 4321",
    createdAt: "2026-09-15T12:00:00Z",
  })
  await ownerDb.execute(sql`
    update "saas_waitlist_request" set "status" = 'entro', "plan_id" = ${PLAN}::uuid, "organization_id" = ${ORG_ENTERED},
      "entered_at" = '2026-10-02T15:00:00Z' where "id" = ${ENTERED}::uuid`)
  await insertRequest(OPEN, {
    email: " Lucia@Example.Test ",
    phone: "+51 987-654-321",
    createdAt: "2026-11-01T12:00:00Z",
  })
  await insertRequest(PAST_DATE, {
    email: "pasada@example.test",
    phone: "987654321",
    createdAt: "2026-11-02T12:00:00Z",
  })
  await ownerDb.execute(sql`
    update "saas_waitlist_request" set "status" = 'invitada', "plan_id" = ${PLAN}::uuid, "token_hash" = 'huella',
      "invite_expires_at" = '2026-11-20T12:00:00Z' where "id" = ${PAST_DATE}::uuid`)
  await insertRequest(LAST_WITHOUT_DATE, {
    email: "sinfecha@example.test",
    phone: "+51987000111",
    createdAt: "2026-11-03T12:00:00Z",
  })
  await insertRequest(DISCARDED, {
    email: "descartada@example.test",
    phone: "+51987000222",
    createdAt: "2026-11-04T12:00:00Z",
  })
  await ownerDb.execute(sql`
    update "saas_waitlist_request" set "status" = 'descartada', "discard_reason" = ${LONG_REASON},
      "decided_by" = ${BETO}, "decided_at" = '2026-11-06T10:00:00Z' where "id" = ${DISCARDED}::uuid`)

  await insertEntry({ requestId: OPEN }, "2026-11-05", "2026-11-02T10:00:00Z")
  await insertEntry({ requestId: OPEN }, "2099-12-31", "2026-11-03T10:00:00Z")
  await insertEntry({ requestId: PAST_DATE }, "2026-01-05", "2026-11-03T11:00:00Z")
  await insertEntry({ requestId: LAST_WITHOUT_DATE }, "2099-12-30", "2026-11-03T12:00:00Z")
  await insertEntry({ requestId: LAST_WITHOUT_DATE }, null, "2026-11-04T12:00:00Z")
  await insertEntry({ requestId: DISCARDED }, "2099-12-29", "2026-11-05T12:00:00Z")
  await insertEntry({ organizationId: ORG_ALONE }, null, "2026-11-06T12:00:00Z")
  await insertEntry({ organizationId: ORG_DEMO_SUB }, null, "2026-11-07T12:00:00Z")

  // El resto de las migraciones, como en el despliegue.
  await migrate(ownerDb, { migrationsFolder: FOLDER })
})

afterAll(async () => {
  await container?.stop()
  if (before) rmSync(before, { recursive: true, force: true })
})

describe("al desplegar", () => {
  it("cada organización que no es demo es un cliente con cuenta; las demos no son clientes", async () => {
    const clients = rows<{
      organization_id: string
      name: string
      product: string
      country_code: string
      origin: string
    }>(
      await ownerDb.execute(sql`
        select "organization_id", "name", "product", "country_code", "origin"
        from "saas_client" where "organization_id" is not null order by "organization_id"`),
    )
    expect(clients).toEqual([
      {
        organization_id: ORG_ENTERED,
        name: "Consultorio Andes",
        product: "medical",
        country_code: "CL",
        origin: "web",
      },
      {
        organization_id: ORG_ALONE,
        name: "Dental Sola",
        product: "dental",
        country_code: "PE",
        origin: "otro",
      },
    ])
  })

  it("cada solicitud es un cliente, y la que entró comparte el de su organización con lo que contó en la web", async () => {
    const requests = rows<{ id: string; client_id: string | null; source: string }>(
      await ownerDb.execute(
        sql`select "id", "client_id", "source" from "saas_waitlist_request" order by "id"`,
      ),
    )
    expect(
      requests.every((request) => request.client_id !== null && request.source === "web"),
    ).toBe(true)
    expect(new Set(requests.map((request) => request.client_id)).size).toBe(requests.length)

    const entered = await one<{
      organization_id: string
      city: string
      professionals: string
      current_tool: string
      created_at: string
    }>(sql`
      select c."organization_id", c."city", c."professionals", c."current_tool",
        to_char(c."created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "created_at"
      from "saas_client" c where c."id" = ${await clientOf(ENTERED)}::uuid`)
    expect(entered).toEqual({
      organization_id: ORG_ENTERED,
      city: "Arequipa",
      professionals: "2-3",
      current_tool: "cuaderno_excel",
      created_at: "2026-09-15T12:00:00Z",
    })

    const open = await one<{
      name: string
      product: string
      country_code: string
      origin: string
      organization_id: string | null
      created_at: string
    }>(sql`
      select "name", "product", "country_code", "origin", "organization_id",
        to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "created_at"
      from "saas_client" where "id" = ${await clientOf(OPEN)}::uuid`)
    expect(open).toEqual({
      name: "Clínica 2",
      product: "dental",
      country_code: "PE",
      origin: "web",
      organization_id: null,
      created_at: "2026-11-01T12:00:00Z",
    })

    const total = await one<{ n: number }>(sql`select count(*)::int as "n" from "saas_client"`)
    // Dos organizaciones con cuenta y cuatro solicitudes sin cuenta.
    expect(total.n).toBe(6)
  })

  it("la persona de cada solicitud es el contacto principal, con sus papeles por confirmar", async () => {
    const contacts = rows<{
      client_id: string
      name: string
      phone: string | null
      email: string
      roles: string[]
      roles_confirmed: boolean
      is_primary: boolean
      user_id: string | null
    }>(
      await ownerDb.execute(sql`
        select "client_id", "name", "phone", "email", "roles", "roles_confirmed", "is_primary", "user_id"
        from "saas_client_contact"`),
    )
    expect(contacts).toHaveLength(5)
    const byClient = new Map(contacts.map((contact) => [contact.client_id, contact]))
    expect(byClient.get(await clientOf(OPEN))).toEqual({
      client_id: await clientOf(OPEN),
      name: "Lucía Quispe",
      phone: "+51987654321",
      email: "lucia@example.test",
      roles: [],
      roles_confirmed: false,
      is_primary: true,
      user_id: null,
    })
    expect(byClient.get(await clientOf(ENTERED))?.phone).toBe("+56987654321")
    // Sin prefijo de país no es E.164: no se completa.
    expect(byClient.get(await clientOf(PAST_DATE))?.phone).toBeNull()
  })

  it("cada entrada de la bitácora es de su cliente y pasó cuando se anotó; la de una demo queda sin cliente", async () => {
    const entries = rows<{
      request_id: string | null
      organization_id: string | null
      client_id: string | null
      same_time: boolean
      kind: string
    }>(
      await ownerDb.execute(sql`
        select "request_id", "organization_id", "client_id", "happened_at" = "created_at" as "same_time", "kind"
        from "saas_follow_up" order by "created_at"`),
    )
    expect(entries.every((entry) => entry.same_time && entry.kind === "nota")).toBe(true)
    for (const entry of entries)
      if (entry.request_id) expect(entry.client_id).toBe(await clientOf(entry.request_id))
    const alone = await one<{ id: string }>(
      sql`select "id" from "saas_client" where "organization_id" = ${ORG_ALONE}`,
    )
    expect(entries.find((entry) => entry.organization_id === ORG_ALONE)?.client_id).toBe(alone.id)
    expect(entries.find((entry) => entry.organization_id === ORG_DEMO_SUB)?.client_id).toBeNull()
  })

  it("la fecha vigente pasa a ser una tarea, también la vencida (para que no desaparezca de Hoy); ni la que la última entrada quitó, ni la de una descartada", async () => {
    const tasks = rows<{
      client_id: string
      kind: string
      title: string
      due_on: string
      assignee_user_id: string
      status: string
      by_kairos: boolean
    }>(
      await ownerDb.execute(sql`
        select "client_id", "kind", "title", to_char("due_on", 'YYYY-MM-DD') as "due_on", "assignee_user_id", "status", "by_kairos"
        from "saas_task" order by "due_on"`),
    )
    expect(tasks).toEqual([
      // Venció antes del traslado: queda abierta con su día, y Hoy la muestra como vencida.
      {
        client_id: await clientOf(PAST_DATE),
        kind: "llamar",
        title: "Volver a contactar",
        due_on: "2026-01-05",
        assignee_user_id: ADA,
        status: "abierta",
        by_kairos: false,
      },
      {
        client_id: await clientOf(OPEN),
        kind: "llamar",
        title: "Volver a contactar",
        due_on: "2099-12-31",
        assignee_user_id: ADA,
        status: "abierta",
        by_kairos: false,
      },
    ])
  })

  it("la venta de cada cliente: abierta sin cuenta, perdida si se descartó, entró con cuenta", async () => {
    const opportunities = rows<{
      client_id: string
      decision: string | null
      reason: string | null
      reason_detail: string | null
      decided_by: string | null
      decided_at: string | null
    }>(
      await ownerDb.execute(sql`
        select "client_id", "decision", "reason", "reason_detail", "decided_by",
          to_char("decided_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "decided_at"
        from "saas_opportunity"`),
    )
    expect(opportunities).toHaveLength(6)
    const of = new Map(opportunities.map((opportunity) => [opportunity.client_id, opportunity]))
    for (const id of [OPEN, PAST_DATE, LAST_WITHOUT_DATE])
      expect(of.get(await clientOf(id))).toMatchObject({
        decision: null,
        decided_at: null,
        reason: null,
      })
    expect(of.get(await clientOf(DISCARDED))).toEqual({
      client_id: await clientOf(DISCARDED),
      decision: "perdido",
      reason: "otro",
      reason_detail: LONG_REASON.trim().slice(0, 500),
      decided_by: BETO,
      decided_at: "2026-11-06T10:00:00Z",
    })
    expect(of.get(await clientOf(ENTERED))).toMatchObject({
      decision: "entro",
      reason: null,
      decided_at: "2026-10-02T15:00:00Z",
    })
    const alone = await one<{ id: string }>(
      sql`select "id" from "saas_client" where "organization_id" = ${ORG_ALONE}`,
    )
    expect(of.get(alone.id)).toMatchObject({ decision: "entro", reason: null })
  })

  it("las tablas nuevas de admin no se abren al rol de la aplicación", async () => {
    const tables = [
      "admin.kairos_ai_usage",
      "admin.kairos_item",
      "admin.kairos_weekly",
      "admin.saas_client",
      "admin.saas_client_contact",
      "admin.saas_client_file",
      "admin.saas_follow_up",
      "admin.saas_inbound_email",
      "admin.saas_opportunity",
      "admin.saas_outreach",
      "admin.saas_proposal",
      "admin.saas_task",
      "admin.saas_waitlist_request",
    ]
    const reach = rows<{ tabla: string; alcanza: boolean }>(
      await ownerDb.execute(sql`
        select t as "tabla", has_table_privilege(${APP_ROLE}, t, 'select, insert, update, delete, truncate, references, trigger') as "alcanza"
        from unnest(${sql.raw(`array[${tables.map((table) => `'${table}'`).join(",")}]`)}) as t order by 1`),
    )
    expect(reach).toEqual(tables.map((tabla) => ({ tabla, alcanza: false })))
  })
})

describe("bitácora del cliente", () => {
  it("solo se agrega: ni el texto, ni el cliente a nulo, ni otro contacto", async () => {
    const clientId = await clientOf(OPEN)
    const contactId = await newContact(clientId, "Otra persona")
    const entry = await one<{ id: string }>(sql`
      insert into "saas_follow_up" ("client_id", "author_user_id", "body", "kind", "direction")
      values (${clientId}::uuid, ${ADA}, 'Llamé y quedó en pensarlo', 'llamada', 'salio') returning "id"`)
    await expect(
      ownerDb.execute(
        sql`update "saas_follow_up" set "body" = 'Otro texto' where "id" = ${entry.id}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_follow_up_append_only"))
    await expect(
      ownerDb.execute(
        sql`update "saas_follow_up" set "happened_at" = now() - interval '1 day' where "id" = ${entry.id}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_follow_up_append_only"))
    await expect(
      ownerDb.execute(
        sql`update "saas_follow_up" set "client_id" = null where "id" = ${entry.id}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_follow_up_append_only"))
    await expect(
      ownerDb.execute(
        sql`update "saas_follow_up" set "contact_id" = ${contactId}::uuid where "id" = ${entry.id}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_follow_up_append_only"))
    // «Solo administración» sigue pasando de no a sí.
    await ownerDb.execute(
      sql`update "saas_follow_up" set "admin_only" = true where "id" = ${entry.id}::uuid`,
    )
  })

  it("el cliente se llena o pasa a otro al fusionar; con cliente, la entrada no necesita solicitud ni clínica", async () => {
    const demoEntry = await one<{ id: string }>(
      sql`select "id" from "saas_follow_up" where "organization_id" = ${ORG_DEMO_SUB}`,
    )
    const keep = await newClient("Se queda")
    const other = await newClient("Se va")
    await ownerDb.execute(
      sql`update "saas_follow_up" set "client_id" = ${other}::uuid where "id" = ${demoEntry.id}::uuid`,
    )
    await ownerDb.execute(
      sql`update "saas_follow_up" set "client_id" = ${keep}::uuid where "id" = ${demoEntry.id}::uuid`,
    )
    await expect(
      ownerDb.execute(sql`insert into "saas_follow_up" ("body") values ('De nadie')`),
    ).rejects.toMatchObject(violates("saas_follow_up_subject_check"))
    await expect(
      ownerDb.execute(
        sql`insert into "saas_follow_up" ("client_id", "body", "kind") values (${keep}::uuid, 'Una visita', 'visita')`,
      ),
    ).rejects.toMatchObject(violates("saas_follow_up_kind_check"))
  })

  it("al borrar el contacto, la demo o la propuesta, la entrada queda sin ellos", async () => {
    const clientId = await newClient("Con todo")
    const contactId = await newContact(clientId, "Rosa")
    const proposalId = await newProposal(clientId, 1)
    const entry = await one<{ id: string }>(sql`
      insert into "saas_follow_up" ("client_id", "body", "kind", "contact_id", "demo_id", "proposal_id")
      values (${clientId}::uuid, 'Presentación con la demo', 'presentacion', ${contactId}::uuid, ${DEMO}::uuid, ${proposalId}::uuid)
      returning "id"`)
    await ownerDb.execute(sql`delete from "saas_client_contact" where "id" = ${contactId}::uuid`)
    await ownerDb.execute(sql`delete from "saas_proposal" where "id" = ${proposalId}::uuid`)
    await ownerDb.execute(sql`delete from "saas_demo" where "id" = ${DEMO}::uuid`)
    const after = await one<{
      contact_id: string | null
      demo_id: string | null
      proposal_id: string | null
      body: string
    }>(sql`
      select "contact_id", "demo_id", "proposal_id", "body" from "saas_follow_up" where "id" = ${entry.id}::uuid`)
    expect(after).toEqual({
      contact_id: null,
      demo_id: null,
      proposal_id: null,
      body: "Presentación con la demo",
    })
    // Borrar el cliente borra sus entradas.
    await ownerDb.execute(sql`delete from "saas_client" where "id" = ${clientId}::uuid`)
    const left = await one<{ n: number }>(
      sql`select count(*)::int as "n" from "saas_follow_up" where "id" = ${entry.id}::uuid`,
    )
    expect(left.n).toBe(0)
  })
})

describe("venta", () => {
  it("una oportunidad abierta por cliente; las decididas quedan como historia", async () => {
    const clientId = await clientOf(OPEN)
    await expect(
      ownerDb.execute(sql`insert into "saas_opportunity" ("client_id") values (${clientId}::uuid)`),
    ).rejects.toMatchObject({
      cause: { code: "23505", constraint_name: "saas_opportunity_open_uidx" },
    })
    await ownerDb.execute(sql`
      insert into "saas_opportunity" ("client_id", "decision", "reason", "decided_at", "return_on")
      values (${clientId}::uuid, 'no_por_ahora', 'no_es_el_momento', now(), '2027-03-01')`)
  })

  it("lo decidido dice cuándo, «no por ahora» cuándo volver, lo perdido por qué y lo que entró no lleva motivo", async () => {
    const clientId = await newClient("Decisiones")
    const cases = [
      sql`(${clientId}::uuid, 'perdido', 'precio', null, null)`,
      sql`(${clientId}::uuid, 'no_por_ahora', 'no_es_el_momento', now(), null)`,
      sql`(${clientId}::uuid, 'perdido', null, now(), null)`,
      sql`(${clientId}::uuid, 'entro', 'precio', now(), null)`,
      sql`(${clientId}::uuid, null, null, now(), null)`,
      sql`(${clientId}::uuid, 'perdido', 'caro', now(), null)`,
    ]
    for (const values of cases)
      await expect(
        ownerDb.execute(
          sql`insert into "saas_opportunity" ("client_id", "decision", "reason", "decided_at", "return_on") values ${values}`,
        ),
      ).rejects.toMatchObject(violates("saas_opportunity_decision_check"))
  })

  it("la propuesta enviada no cambia sus condiciones y solo pasa a aceptada o no aceptada", async () => {
    const clientId = await newClient("Propuesta")
    const id = await newProposal(clientId, 1)
    // En borrador se corrige.
    await ownerDb.execute(
      sql`update "saas_proposal" set "discount_bps" = 1000, "discount_months" = 3 where "id" = ${id}::uuid`,
    )
    await ownerDb.execute(
      sql`update "saas_proposal" set "status" = 'enviada', "sent_at" = now() where "id" = ${id}::uuid`,
    )
    for (const change of [
      sql`"discount_bps" = 2000`,
      sql`"valid_until" = '2027-01-31'`,
      sql`"list_price_cents" = 9900`,
      sql`"trial_days" = 30`,
      sql`"sent_at" = now() + interval '1 hour'`,
    ])
      await expect(
        ownerDb.execute(sql`update "saas_proposal" set ${change} where "id" = ${id}::uuid`),
      ).rejects.toMatchObject(violates("saas_proposal_terms_frozen"))
    await expect(
      ownerDb.execute(
        sql`update "saas_proposal" set "status" = 'borrador' where "id" = ${id}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_proposal_status_flow"))
    // Al fusionar, pasa a otro cliente con otra versión.
    const keep = await newClient("Se queda con la propuesta")
    await ownerDb.execute(
      sql`update "saas_proposal" set "client_id" = ${keep}::uuid, "version" = 2 where "id" = ${id}::uuid`,
    )
    await ownerDb.execute(sql`
      update "saas_proposal" set "status" = 'aceptada', "decided_at" = now(), "decided_by" = ${ADA},
        "accepted_note" = 'Aceptó por WhatsApp' where "id" = ${id}::uuid`)
    await expect(
      ownerDb.execute(
        sql`update "saas_proposal" set "status" = 'no_aceptada' where "id" = ${id}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_proposal_status_flow"))
    await expect(
      ownerDb.execute(
        sql`update "saas_proposal" set "accepted_note" = 'Otra nota' where "id" = ${id}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_proposal_status_flow"))
    // La misma versión no se repite en un cliente.
    await expect(newProposal(keep, 2)).rejects.toMatchObject({ cause: { code: "23505" } })
    await expect(
      ownerDb.execute(sql`
        insert into "saas_proposal" ("client_id", "version", "plan_id", "list_price_cents", "currency", "valid_until", "discount_bps")
        values (${keep}::uuid, 3, ${PLAN}::uuid, 19900, 'PEN', '2026-12-31', 9500)`),
    ).rejects.toMatchObject(violates("saas_proposal_discount_check"))
  })
})

describe("envíos", () => {
  async function newOutreach(clientId: string, contactId: string | null = null): Promise<string> {
    const row = await one<{ id: string }>(sql`
      insert into "saas_outreach" ("client_id", "contact_id", "channel", "to_address", "body", "created_by")
      values (${clientId}::uuid, ${contactId}::uuid, 'whatsapp', '+51987654321', 'Hola, ¿pudo ver la propuesta?', ${ADA})
      returning "id"`)
    return row.id
  }

  it("pendiente pasa a enviado, incierto o no salió; incierto, a enviado o no salió; lo final no cambia", async () => {
    const clientId = await newClient("Envíos")
    const uncertain = await newOutreach(clientId)
    await ownerDb.execute(
      sql`update "saas_outreach" set "status" = 'incierto' where "id" = ${uncertain}::uuid`,
    )
    await expect(
      ownerDb.execute(
        sql`update "saas_outreach" set "status" = 'pendiente' where "id" = ${uncertain}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_outreach_status_flow"))
    await ownerDb.execute(sql`
      update "saas_outreach" set "status" = 'enviado', "sent_at" = now(), "resolved_by" = ${ADA}, "resolved_at" = now()
      where "id" = ${uncertain}::uuid`)
    for (const change of [
      sql`"status" = 'no_salio'`,
      sql`"status" = 'incierto'`,
      sql`"sent_at" = now() + interval '1 hour'`,
    ])
      await expect(
        ownerDb.execute(sql`update "saas_outreach" set ${change} where "id" = ${uncertain}::uuid`),
      ).rejects.toMatchObject(violates("saas_outreach_status_flow"))

    const failed = await newOutreach(clientId)
    await ownerDb.execute(
      sql`update "saas_outreach" set "status" = 'no_salio', "resolved_by" = ${BETO}, "resolved_at" = now() where "id" = ${failed}::uuid`,
    )
    await expect(
      ownerDb.execute(
        sql`update "saas_outreach" set "status" = 'enviado' where "id" = ${failed}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_outreach_status_flow"))

    const direct = await newOutreach(clientId)
    await ownerDb.execute(
      sql`update "saas_outreach" set "status" = 'enviado', "sent_at" = now() where "id" = ${direct}::uuid`,
    )
  })

  it("lo que se envió y a quién no cambia; el contacto borrado queda nulo y el cliente pasa a otro al fusionar", async () => {
    const clientId = await newClient("Envío fijo")
    const contactId = await newContact(clientId, "Mario", true)
    const id = await newOutreach(clientId, contactId)
    for (const change of [
      sql`"body" = 'Otro texto'`,
      sql`"to_address" = '+51900000000'`,
      sql`"channel" = 'correo'`,
    ])
      await expect(
        ownerDb.execute(sql`update "saas_outreach" set ${change} where "id" = ${id}::uuid`),
      ).rejects.toMatchObject(violates("saas_outreach_immutable"))
    const otherContact = await newContact(clientId, "Otra")
    await expect(
      ownerDb.execute(
        sql`update "saas_outreach" set "contact_id" = ${otherContact}::uuid where "id" = ${id}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_outreach_immutable"))
    await ownerDb.execute(sql`delete from "saas_client_contact" where "id" = ${contactId}::uuid`)
    const keep = await newClient("Se queda con el envío")
    await ownerDb.execute(
      sql`update "saas_outreach" set "client_id" = ${keep}::uuid where "id" = ${id}::uuid`,
    )
    const after = await one<{ contact_id: string | null; client_id: string; status: string }>(
      sql`select "contact_id", "client_id", "status" from "saas_outreach" where "id" = ${id}::uuid`,
    )
    expect(after).toEqual({ contact_id: null, client_id: keep, status: "pendiente" })
  })
})

describe("clientes y contactos", () => {
  it("un principal por cliente, teléfono E.164, correo en minúsculas y papeles conocidos", async () => {
    const clientId = await newClient("Contactos")
    await newContact(clientId, "Principal", true)
    await expect(newContact(clientId, "Otra principal", true)).rejects.toMatchObject({
      cause: { code: "23505", constraint_name: "saas_client_contact_primary_uidx" },
    })
    await expect(
      ownerDb.execute(
        sql`insert into "saas_client_contact" ("client_id", "name", "phone") values (${clientId}::uuid, 'Sin más', '987654321')`,
      ),
    ).rejects.toMatchObject(violates("saas_client_contact_phone_check"))
    await expect(
      ownerDb.execute(
        sql`insert into "saas_client_contact" ("client_id", "name", "email") values (${clientId}::uuid, 'Mayúsculas', 'Rosa@Example.Test')`,
      ),
    ).rejects.toMatchObject(violates("saas_client_contact_email_check"))
    await expect(
      ownerDb.execute(
        sql`insert into "saas_client_contact" ("client_id", "name", "roles") values (${clientId}::uuid, 'Papel raro', '{decide,firma}')`,
      ),
    ).rejects.toMatchObject(violates("saas_client_contact_roles_check"))
    await ownerDb.execute(sql`
      insert into "saas_client_contact" ("client_id", "name", "roles", "phone", "email")
      values (${clientId}::uuid, 'Rosa', '{decide,paga}', '+51987654321', 'rosa@example.test')`)
  })

  it("una organización es de un solo cliente, y el producto es uno de los tres", async () => {
    await expect(
      ownerDb.execute(
        sql`insert into "saas_client" ("name", "product", "organization_id") values ('Otra vez Andes', 'dental', ${ORG_ENTERED})`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint_name: "saas_client_org_uidx" } })
    await expect(
      ownerDb.execute(
        sql`insert into "saas_client" ("name", "product") values ('Veterinaria', 'veterinary')`,
      ),
    ).rejects.toMatchObject(violates("saas_client_product_check"))
  })
})
