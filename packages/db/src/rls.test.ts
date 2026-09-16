// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver docs).
// El servicio `podman-api` lo expone; requiere chmod 777 tras (re)crearlo.
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createAppDb, createOwnerDb, type Db } from "./client.js"
import { withOrgContext } from "./context.js"

// Imagen propia (infra/dev/postgres): trae pgmq + pg_cron, requeridos por la
// migración (pgmq.create) y el init (rol app + extensiones).
const IMAGE = "dentalagent-postgres:18.6"
const APP_ROLE = "dentalagent_app"
const APP_PASSWORD = "dentalagent_app"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

async function insertOrg(db: Db, id: string, slug: string) {
  await db.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at")
        values (${id}, ${"Clínica " + slug}, ${slug}, now())`,
  )
}

async function insertBranch(db: Db, id: string, orgId: string, name: string) {
  await db.execute(
    sql`insert into "branch" ("id", "organization_id", "name")
        values (${id}::uuid, ${orgId}, ${name})`,
  )
}

async function branchNames(db: Db): Promise<string[]> {
  const rows = await db.execute<{ name: string }>(sql`select "name" from "branch" order by "name"`)
  return (rows as unknown as { name: string }[]).map((r) => r.name)
}

async function insertContact(db: Db, id: string, orgId: string, name: string) {
  await db.execute(
    sql`insert into "contact" ("id", "organization_id", "display_name")
        values (${id}::uuid, ${orgId}, ${name})`,
  )
}

async function insertConnection(db: Db, id: string, orgId: string) {
  await db.execute(
    sql`insert into "channel_connection"
          ("id", "organization_id", "channel", "provider", "display_name", "config_encrypted", "webhook_secret")
        values (${id}::uuid, ${orgId}, 'telegram', 'telegram_bot_api', 'Bot', 'enc', 'secret')`,
  )
}

async function insertConversation(
  db: Db,
  id: string,
  orgId: string,
  contactId: string,
  connId: string,
) {
  await db.execute(
    sql`insert into "conversation"
          ("id", "organization_id", "contact_id", "channel_connection_id", "external_thread_id")
        values (${id}::uuid, ${orgId}, ${contactId}::uuid, ${connId}::uuid, ${"thread-" + id})`,
  )
}

async function insertMessage(
  db: Db,
  orgId: string,
  conversationId: string,
  body: string,
  externalId: string | null,
) {
  await db.execute(
    sql`insert into "message"
          ("organization_id", "conversation_id", "direction", "sender_kind", "body", "external_id")
        values (${orgId}, ${conversationId}::uuid, 'in', 'contact', ${body}, ${externalId})`,
  )
}

async function contactNames(db: Db): Promise<string[]> {
  const rows = await db.execute<{ display_name: string }>(
    sql`select "display_name" from "contact" order by "display_name"`,
  )
  return (rows as unknown as { display_name: string }[]).map((r) => r.display_name)
}

async function insertPatient(db: Db, id: string, orgId: string, contactId: string, number: number) {
  await db.execute(
    sql`insert into "patient" ("id", "organization_id", "contact_id", "patient_number")
        values (${id}::uuid, ${orgId}, ${contactId}::uuid, ${number})`,
  )
}

async function patientNumbers(db: Db): Promise<number[]> {
  const rows = await db.execute<{ patient_number: number }>(
    sql`select "patient_number" from "patient" order by "patient_number"`,
  )
  return (rows as unknown as { patient_number: number }[]).map((r) => r.patient_number)
}

async function messageBodies(db: Db): Promise<string[]> {
  const rows = await db.execute<{ body: string }>(sql`select "body" from "message" order by "body"`)
  return (rows as unknown as { body: string }[]).map((r) => r.body)
}

beforeAll(async () => {
  // GenericContainer en lugar de PostgreSqlContainer: este último inyecta un
  // healthcheck en el CREATE y Podman lo rechaza (sin systemd en la máquina).
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: "dentalagent",
      POSTGRES_USER: "dentalagent",
      POSTGRES_PASSWORD: "dentalagent",
      POSTGRES_APP_PASSWORD: APP_PASSWORD,
    })
    // Esperar por log: el mensaje aparece dos veces (initdb temporal y final).
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    // pg_cron exige preload; el init hace CREATE EXTENSION.
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
  await migrate(ownerDb, { migrationsFolder: "./drizzle" })

  appDb = createAppDb(
    `postgres://${APP_ROLE}:${APP_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  )

  await insertOrg(ownerDb, "org_a", "norte")
  await insertOrg(ownerDb, "org_b", "sur")
  await insertBranch(ownerDb, "11111111-1111-1111-1111-111111111111", "org_a", "Sede Lima")
  await insertBranch(ownerDb, "22222222-2222-2222-2222-222222222222", "org_b", "Sede Sur")
  await insertContact(ownerDb, "33333333-3333-3333-3333-333333333333", "org_a", "Paciente Ana")
  await insertContact(ownerDb, "44444444-4444-4444-4444-444444444444", "org_b", "Paciente Beto")
  await insertConnection(ownerDb, "55555555-5555-5555-5555-555555555555", "org_a")
  await insertConnection(ownerDb, "66666666-6666-6666-6666-666666666666", "org_b")
  await insertConversation(
    ownerDb,
    "77777777-7777-7777-7777-777777777777",
    "org_a",
    "33333333-3333-3333-3333-333333333333",
    "55555555-5555-5555-5555-555555555555",
  )
  await insertConversation(
    ownerDb,
    "88888888-8888-8888-8888-888888888888",
    "org_b",
    "44444444-4444-4444-4444-444444444444",
    "66666666-6666-6666-6666-666666666666",
  )
  await insertMessage(ownerDb, "org_a", "77777777-7777-7777-7777-777777777777", "Hola", "ext-1")
  await insertMessage(ownerDb, "org_b", "88888888-8888-8888-8888-888888888888", "Buenas", "ext-2")
  await insertPatient(
    ownerDb,
    "99999999-9999-9999-9999-999999999999",
    "org_a",
    "33333333-3333-3333-3333-333333333333",
    1,
  )
  await insertPatient(
    ownerDb,
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "org_b",
    "44444444-4444-4444-4444-444444444444",
    1,
  )
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("con contexto de org A solo ve la sucursal A", async () => {
  const names = await withOrgContext(appDb, "org_a", (tx) => branchNames(tx))
  expect(names).toEqual(["Sede Lima"])
})

it("sin contexto de org, el rol app ve 0 filas", async () => {
  expect(await branchNames(appDb)).toEqual([])
})

it("el rol owner bypasea RLS y ve todas las sucursales", async () => {
  expect(await branchNames(ownerDb)).toEqual(["Sede Lima", "Sede Sur"])
})

it("con contexto de org A solo ve contactos y mensajes de A", async () => {
  expect(await withOrgContext(appDb, "org_a", (tx) => contactNames(tx))).toEqual(["Paciente Ana"])
  expect(await withOrgContext(appDb, "org_a", (tx) => messageBodies(tx))).toEqual(["Hola"])
  expect(await withOrgContext(appDb, "org_b", (tx) => contactNames(tx))).toEqual(["Paciente Beto"])
  expect(await withOrgContext(appDb, "org_b", (tx) => messageBodies(tx))).toEqual(["Buenas"])
})

it("el dedupe por (conversation_id, external_id) rechaza el segundo insert", async () => {
  await expect(
    insertMessage(ownerDb, "org_a", "77777777-7777-7777-7777-777777777777", "Hola x2", "ext-1"),
  ).rejects.toThrow()
  // external_id null no dedupea: dos mensajes sin id externo conviven.
  await insertMessage(ownerDb, "org_a", "77777777-7777-7777-7777-777777777777", "Sin id 1", null)
  await insertMessage(ownerDb, "org_a", "77777777-7777-7777-7777-777777777777", "Sin id 2", null)
  expect(await withOrgContext(appDb, "org_a", (tx) => messageBodies(tx))).toEqual([
    "Hola",
    "Sin id 1",
    "Sin id 2",
  ])
})

it("org A no ve pacientes de org B; sin GUC ve cero filas", async () => {
  expect(await withOrgContext(appDb, "org_a", (tx) => patientNumbers(tx))).toEqual([1])
  expect(await withOrgContext(appDb, "org_b", (tx) => patientNumbers(tx))).toEqual([1])
  const aIds = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute<{ id: string }>(sql`select "id" from "patient"`),
  )
  expect((aIds as unknown as { id: string }[]).map((r) => r.id)).toEqual([
    "99999999-9999-9999-9999-999999999999",
  ])
  expect(await patientNumbers(appDb)).toEqual([])
})

it("encuentros y planes de A son invisibles para B; las piezas cerradas no se borran", async () => {
  await ownerDb.execute(
    sql`insert into "user" (id,name,email) values ('rls-dentist','Dentista','rls@example.test') on conflict (id) do nothing`,
  )
  await ownerDb.execute(sql`insert into "treatment_plan" (id,organization_id,patient_id,title,is_legacy)
    values ('dddddddd-dddd-dddd-dddd-dddddddddddd','org_a','99999999-9999-9999-9999-999999999999','Plan RLS',false)
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into "treatment_budget" (id,organization_id,patient_id,plan_id,budget_number,title,currency,status)
    values ('cccccccc-cccc-cccc-cccc-cccccccccccc','org_a','99999999-9999-9999-9999-999999999999','dddddddd-dddd-dddd-dddd-dddddddddddd',1,'Presupuesto','PEN','borrador')
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into encounter (id,organization_id,patient_id,dentist_user_id) values
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','org_a','99999999-9999-9999-9999-999999999999','rls-dentist')
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into treatment_plan_item (id,organization_id,patient_id,plan_id,title,status) values
    ('11111111-1111-4111-8111-111111111111','org_a','99999999-9999-9999-9999-999999999999','dddddddd-dddd-dddd-dddd-dddddddddddd','Restauración','pendiente')
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into treatment_budget_item (organization_id,patient_id,plan_id,budget_id,plan_item_id,title,currency,decision) values
    ('org_a','99999999-9999-9999-9999-999999999999','dddddddd-dddd-dddd-dddd-dddddddddddd','cccccccc-cccc-cccc-cccc-cccccccccccc','11111111-1111-4111-8111-111111111111','Restauración','PEN','pendiente')
    on conflict do nothing`)
  await ownerDb.execute(sql`insert into encounter_tooth (organization_id,encounter_id,tooth_number)
    values ('org_a','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',36)`)
  await ownerDb.execute(sql`insert into service_catalog (organization_id,source,code,name,specialty,scope,price_cents)
    values ('org_a','custom','RESTAURACION','Restauración','restauradora','tooth',10000)`)
  await ownerDb.execute(sql`insert into encounter_procedure (organization_id,encounter_id,description)
    values ('org_a','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Restauración realizada')`)
  for (const table of [
    "encounter",
    "encounter_tooth",
    "encounter_procedure",
    "treatment_plan",
    "treatment_plan_item",
    "treatment_budget_item",
    "service_catalog",
  ]) {
    const query = sql`select id from ${sql.identifier(table)}`
    expect(await withOrgContext(appDb, "org_a", (tx) => tx.execute(query))).toHaveLength(1)
    expect(await withOrgContext(appDb, "org_b", (tx) => tx.execute(query))).toHaveLength(0)
    expect(await appDb.execute(query)).toHaveLength(0)
  }
  await expect(
    withOrgContext(appDb, "org_b", (tx) =>
      tx.execute(
        sql`insert into service_catalog (organization_id,source,code,name,specialty,scope,price_cents) values ('org_a','custom','INTRUSO','Ajeno','restauradora','tooth',1)`,
      ),
    ),
  ).rejects.toThrow()
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`delete from service_catalog where code='RESTAURACION'`),
    ),
  ).rejects.toThrow()
  await ownerDb.execute(
    sql`update encounter set status='finalizada' where id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'`,
  )
  const deleted = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(
      sql`delete from encounter_tooth where encounter_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' returning id`,
    ),
  )
  expect(deleted).toHaveLength(0)
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`delete from encounter where id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'`),
    ),
  ).rejects.toThrow()
})

it("aísla hallazgos y evaluaciones por tenant y conserva sus originales", async () => {
  await ownerDb.execute(
    sql`insert into "user" (id,name,email) values ('rls-odonto','Odonto','odonto@example.test') on conflict (id) do nothing`,
  )
  await ownerDb.execute(sql`insert into odontogram_entry (organization_id,patient_id,tooth_number,condition,status,details,needs_review)
    values ('org_a','99999999-9999-9999-9999-999999999999',16,'caries','recorded','{"variant":"enamel"}',false)`)
  await ownerDb.execute(sql`insert into odontogram_assessment
    (organization_id,patient_id,author_user_id,purpose,specifications,observations,examiner_name,registration_number,patient_name,patient_number,signature,entries)
    values ('org_a','99999999-9999-9999-9999-999999999999','rls-odonto','initial','Acta inicial','Sin observaciones','Odonto','COP 1','Paciente Ana',1,'[[[5,90],[20,70]]]','[]')`)
  const assessmentQuery = sql`select id from odontogram_assessment`
  expect(await withOrgContext(appDb, "org_a", (tx) => tx.execute(assessmentQuery))).toHaveLength(1)
  expect(await withOrgContext(appDb, "org_b", (tx) => tx.execute(assessmentQuery))).toHaveLength(0)
  expect(await appDb.execute(assessmentQuery)).toHaveLength(0)
  // Inmutabilidad real: UPDATE y DELETE con el rol app son rechazados (42501).
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(
        sql`update odontogram_assessment set observations='hack' where organization_id='org_a'`,
      ),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`delete from odontogram_assessment where organization_id='org_a'`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(
        sql`update odontogram_entry set condition='root_remnant' where organization_id='org_a'`,
      ),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`delete from odontogram_entry where organization_id='org_a'`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  // La corrección auditable del hallazgo (void) sí conserva UPDATE permitido.
  const voided = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(
      sql`update odontogram_entry set status='voided', voided_at=now(), void_reason='revisión' where organization_id='org_a' and tooth_number=16 returning id`,
    ),
  )
  expect(voided).toHaveLength(1)
})

it("presupuestos, contextos versionados y vínculos atención-plan se aíslan por tenant", async () => {
  await ownerDb.execute(
    sql`insert into "user" (id,name,email) values ('rls-dentist','Dentista','rls@example.test') on conflict (id) do nothing`,
  )
  // Presupuesto propio del test (número 2: el 1 lo siembra el test de encuentros).
  await ownerDb.execute(sql`insert into "treatment_plan" (id,organization_id,patient_id,title,is_legacy)
    values ('22222222-2222-4222-8222-222222222222','org_a','99999999-9999-9999-9999-999999999999','Plan RLS',false)
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into "treatment_budget" (id,organization_id,patient_id,plan_id,budget_number,title,currency,status)
    values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','org_a','99999999-9999-9999-9999-999999999999','22222222-2222-4222-8222-222222222222',2,'Presupuesto RLS','PEN','borrador')
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into treatment_plan_item (id,organization_id,patient_id,plan_id,budget_id,title,price_cents,currency,status)
    values ('ffffffff-ffff-ffff-ffff-ffffffffffff','org_a','99999999-9999-9999-9999-999999999999','22222222-2222-4222-8222-222222222222','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','Corona',90000,'PEN','pendiente')
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into encounter (id,organization_id,patient_id,dentist_user_id,status) values
    ('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee','org_a','99999999-9999-9999-9999-999999999999','rls-dentist','finalizada')
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into encounter_plan_item (organization_id,encounter_id,plan_item_id) values
    ('org_a','aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee','ffffffff-ffff-ffff-ffff-ffffffffffff')
    on conflict do nothing`)
  await ownerDb.execute(sql`insert into patient_document (id,organization_id,patient_id,category,label,storage_key,content_type,size_bytes)
    values ('dddddddd-dddd-dddd-dddd-dddddddddddd','org_a','99999999-9999-9999-9999-999999999999','radiografia','rx','k','image/png',4)
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into patient_document_context (organization_id,patient_id,document_id,version,tooth_numbers,tags)
    values ('org_a','99999999-9999-9999-9999-999999999999','dddddddd-dddd-dddd-dddd-dddddddddddd',1,'{36}','{control}')
    on conflict do nothing`)

  // Lecturas: A ve su fila, B ve cero, sin contexto cero.
  const budgetQuery = sql`select id from treatment_budget where budget_number = 2`
  expect(await withOrgContext(appDb, "org_a", (tx) => tx.execute(budgetQuery))).toHaveLength(1)
  expect(await withOrgContext(appDb, "org_b", (tx) => tx.execute(budgetQuery))).toHaveLength(0)
  expect(await appDb.execute(budgetQuery)).toHaveLength(0)
  const contextQuery = sql`select id from patient_document_context where document_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'`
  expect(await withOrgContext(appDb, "org_a", (tx) => tx.execute(contextQuery))).toHaveLength(1)
  expect(await withOrgContext(appDb, "org_b", (tx) => tx.execute(contextQuery))).toHaveLength(0)
  expect(await appDb.execute(contextQuery)).toHaveLength(0)
  const linkQuery = sql`select encounter_id from encounter_plan_item where encounter_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'`
  expect(await withOrgContext(appDb, "org_a", (tx) => tx.execute(linkQuery))).toHaveLength(1)
  expect(await withOrgContext(appDb, "org_b", (tx) => tx.execute(linkQuery))).toHaveLength(0)
  expect(await appDb.execute(linkQuery)).toHaveLength(0)

  // Escrituras cruzadas: con contexto de B no se puede colar una fila de A.
  await expect(
    withOrgContext(appDb, "org_b", (tx) =>
      tx.execute(
        sql`insert into treatment_budget (organization_id,patient_id,plan_id,budget_number,title) values ('org_a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222',99,'Intruso')`,
      ),
    ),
  ).rejects.toThrow()
  await expect(
    withOrgContext(appDb, "org_b", (tx) =>
      tx.execute(
        sql`insert into patient_document_context (organization_id,patient_id,document_id,version) values ('org_a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dddddddd-dddd-dddd-dddd-dddddddddddd',99)`,
      ),
    ),
  ).rejects.toThrow()
  await expect(
    withOrgContext(appDb, "org_b", (tx) =>
      tx.execute(
        sql`insert into encounter_plan_item (organization_id,encounter_id,plan_item_id) values ('org_a','aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee','ffffffff-ffff-ffff-ffff-ffffffffffff')`,
      ),
    ),
  ).rejects.toThrow()

  // Versiones append-only: (document_id, version) no se duplica.
  await expect(
    ownerDb.execute(
      sql`insert into patient_document_context (organization_id,patient_id,document_id,version) values ('org_a','99999999-9999-9999-9999-999999999999','dddddddd-dddd-dddd-dddd-dddddddddddd',1)`,
    ),
  ).rejects.toThrow()
  // Correlativo de presupuesto único por organización.
  await expect(
    ownerDb.execute(
      sql`insert into treatment_budget (organization_id,patient_id,plan_id,budget_number,title) values ('org_a','99999999-9999-9999-9999-999999999999','22222222-2222-4222-8222-222222222222',2,'Duplicado')`,
    ),
  ).rejects.toThrow()

  // Inmutabilidad real: presupuestos se cancelan por estado (nunca DELETE);
  // vínculos y contextos son append-only (rechazados con 42501).
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`delete from treatment_budget where budget_number = 2`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(
        sql`update patient_document_context set tags = '{hack}' where document_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'`,
      ),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(
        sql`delete from patient_document_context where document_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'`,
      ),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(
        sql`delete from encounter_plan_item where encounter_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'`,
      ),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })

  // El ítem es el set editable del borrador: DELETE permitido en borrador sin
  // relaciones; bloqueado con vínculos de ejecución o presupuesto no borrador.
  await ownerDb.execute(sql`insert into treatment_plan_item (id,organization_id,patient_id,plan_id,budget_id,title,status)
    values ('99999999-0000-4000-8000-000000000000','org_a','99999999-9999-9999-9999-999999999999','22222222-2222-4222-8222-222222222222','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','Puente libre','pendiente')
    on conflict (id) do nothing`)
  const draftDeleted = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(
      sql`delete from treatment_plan_item where id = '99999999-0000-4000-8000-000000000000' returning id`,
    ),
  )
  expect(draftDeleted).toHaveLength(1)
  // Con vínculo atención-plan no se elimina aunque el presupuesto siga en borrador.
  const linkedDeleted = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(
      sql`delete from treatment_plan_item where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff' returning id`,
    ),
  )
  expect(linkedDeleted).toHaveLength(0)
  await ownerDb.execute(sql`insert into treatment_plan_item (id,organization_id,patient_id,plan_id,budget_id,title,status)
    values ('11111111-2222-3333-4444-555555555555','org_a','99999999-9999-9999-9999-999999999999','22222222-2222-4222-8222-222222222222','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','Puente','pendiente')`)
  await ownerDb.execute(
    sql`update treatment_budget set status = 'presentado' where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'`,
  )
  const presentedDeleted = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(
      sql`delete from treatment_plan_item where id = '11111111-2222-3333-4444-555555555555' returning id`,
    ),
  )
  expect(presentedDeleted).toHaveLength(0)
})

it("la biblioteca global es de solo lectura y las líneas se blindan por trigger", async () => {
  await ownerDb.execute(sql`insert into "treatment_template" ("key", "name", "specialty", "scope")
    values ('rls:prueba', 'Prestación RLS', 'prevencion', 'general')
    on conflict ("key") do nothing`)
  // Lectura global sin tenant: el rol app lee, sin importar el contexto.
  const libraryQuery = sql`select "key" from "treatment_template" where "key" = 'rls:prueba'`
  expect(await withOrgContext(appDb, "org_a", (tx) => tx.execute(libraryQuery))).toHaveLength(1)
  expect(await withOrgContext(appDb, "org_b", (tx) => tx.execute(libraryQuery))).toHaveLength(1)
  // Escritura denegada al rol app (42501): solo el seed owner la mantiene.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(
        sql`insert into "treatment_template" ("key", "name", "specialty", "scope") values ('rls:intrusa', 'Intrusa', 'prevencion', 'general')`,
      ),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`update "treatment_template" set "name" = 'hack' where "key" = 'rls:prueba'`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`delete from "treatment_template" where "key" = 'rls:prueba'`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })

  // Líneas económicas: alta solo en borrador; tras presentar, solo decision cambia; nunca DELETE.
  await ownerDb.execute(sql`insert into "treatment_plan" (id,organization_id,patient_id,title)
    values ('33333333-3333-4333-8333-333333333333','org_a','99999999-9999-9999-9999-999999999999','Plan líneas')
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into "treatment_budget" (id,organization_id,patient_id,plan_id,budget_number,title,currency,status)
    values ('44444444-4444-4444-8444-444444444444','org_a','99999999-9999-9999-9999-999999999999','33333333-3333-4333-8333-333333333333',3,'Líneas','PEN','borrador')
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into treatment_plan_item (id,organization_id,patient_id,plan_id,budget_id,title,price_cents,currency,status)
    values ('55555555-5555-4555-8555-555555555555','org_a','99999999-9999-9999-9999-999999999999','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','Línea',10000,'PEN','pendiente')
    on conflict (id) do nothing`)
  const inserted = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(
      sql`insert into treatment_budget_item (organization_id,patient_id,plan_id,budget_id,plan_item_id,title,price_cents,currency,decision)
      values ('org_a','99999999-9999-9999-9999-999999999999','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555','Línea',10000,'PEN','pendiente')
      returning id`,
    ),
  )
  expect(inserted).toHaveLength(1)
  await ownerDb.execute(
    sql`update treatment_budget set status = 'presentado' where id = '44444444-4444-4444-8444-444444444444'`,
  )
  // Snapshot cerrado: ni el contenido ni la pertenencia cambian.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(
        sql`update treatment_budget_item set title = 'hack' where plan_item_id = '55555555-5555-4555-8555-555555555555'`,
      ),
    ),
  ).rejects.toThrow()
  // La decisión sí puede registrarse sobre el presentado.
  const decided = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(
      sql`update treatment_budget_item set decision = 'aceptado' where plan_item_id = '55555555-5555-4555-8555-555555555555' returning decision`,
    ),
  )
  expect(decided).toHaveLength(1)
  // Sin DELETE físico en ningún estado (42501 por REVOKE).
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(
        sql`delete from treatment_budget_item where plan_item_id = '55555555-5555-4555-8555-555555555555'`,
      ),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  // Ni el owner borra planes por API: el rol app no tiene DELETE en treatment_plan.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`delete from treatment_plan where id = '33333333-3333-4333-8333-333333333333'`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
})
