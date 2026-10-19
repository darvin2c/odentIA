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

async function insertPatient(
  db: Db,
  id: string,
  orgId: string,
  contactId: string,
  number: number,
  displayName: string,
) {
  // Persona única (ADR 0044): la identidad vive en el contacto, que es la
  // persona del paciente; la base crea su vínculo propio.
  await db.execute(sql`update "contact" set "display_name" = ${displayName} where "id" = ${contactId}::uuid`)
  await db.execute(
    sql`insert into "patient" ("id", "organization_id", "person_id", "patient_number")
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
    "Paciente Ana",
  )
  await insertPatient(
    ownerDb,
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "org_b",
    "44444444-4444-4444-4444-444444444444",
    1,
    "Paciente Beto",
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
  // Toda línea es de una opción del presupuesto (decisión 13 de la fase 3).
  await ownerDb.execute(sql`insert into treatment_budget_option (id,organization_id,patient_id,budget_id,position,is_recommended)
    values ('cccccccc-0000-4000-8000-000000000001','org_a','99999999-9999-9999-9999-999999999999','cccccccc-cccc-cccc-cccc-cccccccccccc',1,true)
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into encounter (id,organization_id,patient_id,dentist_user_id) values
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','org_a','99999999-9999-9999-9999-999999999999','rls-dentist')
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into treatment_plan_item (id,organization_id,patient_id,plan_id,title,currency,status) values
    ('11111111-1111-4111-8111-111111111111','org_a','99999999-9999-9999-9999-999999999999','dddddddd-dddd-dddd-dddd-dddddddddddd','Restauración','PEN','pendiente')
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into treatment_budget_item (organization_id,patient_id,plan_id,budget_id,option_id,plan_item_id,title,currency,decision) values
    ('org_a','99999999-9999-9999-9999-999999999999','dddddddd-dddd-dddd-dddd-dddddddddddd','cccccccc-cccc-cccc-cccc-cccccccccccc','cccccccc-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','Restauración','PEN','pendiente')
    on conflict do nothing`)
  // Un solo borrador por persona: este se entrega para que los siguientes tests armen el suyo.
  await ownerDb.execute(sql`update treatment_budget set status = 'presentado' where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'`)
  await ownerDb.execute(sql`insert into encounter_tooth (organization_id,encounter_id,tooth_number)
    values ('org_a','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',36)`)
  await ownerDb.execute(sql`insert into service_catalog (organization_id,source,code,name,scope,price_cents,currency)
    values ('org_a','custom','RESTAURACION','Restauración','tooth',10000,'PEN')`)
  await ownerDb.execute(sql`insert into encounter_procedure (organization_id,encounter_id,description)
    values ('org_a','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Restauración realizada')`)
  for (const table of [
    "encounter",
    "encounter_tooth",
    "encounter_procedure",
    "treatment_plan",
    "treatment_plan_item",
    "treatment_budget_item",
    "treatment_budget_option",
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
        sql`insert into service_catalog (organization_id,source,code,name,scope,price_cents,currency) values ('org_a','custom','INTRUSO','Ajeno','tooth',1,'PEN')`,
      ),
    ),
  ).rejects.toThrow()
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`delete from service_catalog where code='RESTAURACION'`),
    ),
  ).rejects.toThrow()
  await ownerDb.execute(
    sql`update encounter set status='finalizada', signer_name='Dra. Prueba', signer_registration='COP 1' where id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'`,
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
  // Firmado con el perfil (sin trazo) y con su norma escrita: no hay valor por defecto (ADR 0036).
  await ownerDb.execute(sql`insert into odontogram_assessment
    (organization_id,patient_id,author_user_id,purpose,specifications,observations,examiner_name,examiner_title,registration_number,patient_name,patient_number,entries,standard)
    values ('org_a','99999999-9999-9999-9999-999999999999','rls-odonto','initial','Acta inicial','Sin observaciones','Odonto','Cirujano dentista','COP 1','Paciente Ana',1,'[]','NTS 188-MINSA/DGIESP-2022')`)
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
    values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','org_a','99999999-9999-9999-9999-999999999999','22222222-2222-4222-8222-222222222222',2,'Presupuesto RLS','PEN','presentado')
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
        sql`insert into treatment_budget (organization_id,patient_id,plan_id,budget_number,title,currency) values ('org_a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222',99,'Intruso','PEN')`,
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
      sql`insert into treatment_budget (organization_id,patient_id,plan_id,budget_number,title,currency) values ('org_a','99999999-9999-9999-9999-999999999999','22222222-2222-4222-8222-222222222222',2,'Duplicado','PEN')`,
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

  // Archivo clínico: la app no cambia ni borra el archivo; solo puede retirarlo
  // con motivo y quien lo retira, y un retiro no se deshace.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(
        sql`update patient_document set label = 'otro' where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'`,
      ),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`delete from patient_document where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(
        sql`update patient_document set retired_at = now(), retire_reason = 'x' where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'`,
      ),
    ),
  ).rejects.toThrow()
  await ownerDb.execute(sql`insert into "user" (id,name,email) values ('rls-retirer','R','rls-retirer@example.test') on conflict (id) do nothing`)
  await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(
      sql`update patient_document set retired_at = now(), retired_by = 'rls-retirer', retire_reason = 'Paciente equivocado' where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'`,
    ),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(
        sql`update patient_document set retired_at = null, retired_by = null, retire_reason = null where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'`,
      ),
    ),
  ).rejects.toThrow()

  // Las indicaciones se cancelan o reemplazan; incluso sin vínculos no se borran.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`delete from treatment_plan_item where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  // Lo agendado de un plan (ADR 0034) se aísla por tenant y es historia: no se borra.
  const [sillon] = await ownerDb.execute<{ id: string }>(sql`
    insert into schedule_chair (organization_id,branch_id,name)
    values ('org_a','11111111-1111-1111-1111-111111111111','Unidad dental RLS') returning id`)
  const [cita] = await ownerDb.execute<{ id: string }>(sql`
    insert into appointment (organization_id,branch_id,patient_id,dentist_user_id,chair_id,starts_at,ends_at,duration_min,status)
    values ('org_a','11111111-1111-1111-1111-111111111111','99999999-9999-9999-9999-999999999999','rls-dentist',${sillon!.id},
      now() + interval '2 days', now() + interval '2 days 30 minutes', 30, 'cancelada')
    returning id`)
  await ownerDb.execute(sql`insert into appointment_plan_item (organization_id,patient_id,appointment_id,plan_item_id)
    values ('org_a','99999999-9999-9999-9999-999999999999',${cita!.id},'ffffffff-ffff-ffff-ffff-ffffffffffff')`)
  const linkedQuery = sql`select plan_item_id from appointment_plan_item where plan_item_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'`
  expect(await withOrgContext(appDb, "org_a", tx => tx.execute(linkedQuery))).toHaveLength(1)
  expect(await withOrgContext(appDb, "org_b", tx => tx.execute(linkedQuery))).toHaveLength(0)
  expect(await appDb.execute(linkedQuery)).toHaveLength(0)
  await expect(
    withOrgContext(appDb, "org_a", tx =>
      tx.execute(sql`delete from appointment_plan_item where plan_item_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'`)),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  // La cita y el tratamiento son del mismo paciente: otro paciente no se cuela.
  await expect(
    ownerDb.execute(sql`insert into appointment_plan_item (organization_id,patient_id,appointment_id,plan_item_id)
      values ('org_a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',${cita!.id},'ffffffff-ffff-ffff-ffff-ffffffffffff')`),
  ).rejects.toThrow()
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

  // Líneas económicas: alta y baja solo en borrador; tras presentar, solo decision cambia.
  await ownerDb.execute(sql`insert into "treatment_plan" (id,organization_id,patient_id,title)
    values ('33333333-3333-4333-8333-333333333333','org_a','99999999-9999-9999-9999-999999999999','Plan líneas')
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into "treatment_budget" (id,organization_id,patient_id,plan_id,budget_number,title,currency,status)
    values ('44444444-4444-4444-8444-444444444444','org_a','99999999-9999-9999-9999-999999999999','33333333-3333-4333-8333-333333333333',3,'Líneas','PEN','borrador')
    on conflict (id) do nothing`)
  await ownerDb.execute(sql`insert into treatment_budget_option (id,organization_id,patient_id,budget_id,position,is_recommended)
    values ('44444444-0000-4000-8000-000000000001','org_a','99999999-9999-9999-9999-999999999999','44444444-4444-4444-8444-444444444444',1,true)
    on conflict (id) do nothing`)
  // Un solo borrador por persona: la base rechaza un segundo de la misma persona.
  await expect(
    ownerDb.execute(
      sql`insert into treatment_budget (organization_id,patient_id,plan_id,budget_number,title,currency,status) values ('org_a','99999999-9999-9999-9999-999999999999','33333333-3333-4333-8333-333333333333',30,'Otro borrador','PEN','borrador')`,
    ),
  ).rejects.toMatchObject({ cause: { code: "23505" } })
  await ownerDb.execute(sql`insert into treatment_plan_item (id,organization_id,patient_id,plan_id,budget_id,title,price_cents,currency,status)
    values ('55555555-5555-4555-8555-555555555555','org_a','99999999-9999-9999-9999-999999999999','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','Línea',10000,'PEN','pendiente')
    on conflict (id) do nothing`)
  const inserted = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(
      sql`insert into treatment_budget_item (organization_id,patient_id,plan_id,budget_id,option_id,plan_item_id,title,price_cents,currency,decision)
      values ('org_a','99999999-9999-9999-9999-999999999999','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','44444444-0000-4000-8000-000000000001','55555555-5555-4555-8555-555555555555','Línea',10000,'PEN','pendiente')
      returning id`,
    ),
  )
  expect(inserted).toHaveLength(1)
  // En borrador la línea se puede quitar (y volver a incluir): nadie la ha recibido.
  const removed = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(
      sql`delete from treatment_budget_item where plan_item_id = '55555555-5555-4555-8555-555555555555' returning id`,
    ),
  )
  expect(removed).toHaveLength(1)
  await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(
      sql`insert into treatment_budget_item (organization_id,patient_id,plan_id,budget_id,option_id,plan_item_id,title,price_cents,currency,decision)
      values ('org_a','99999999-9999-9999-9999-999999999999','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','44444444-0000-4000-8000-000000000001','55555555-5555-4555-8555-555555555555','Línea',10000,'PEN','pendiente')`,
    ),
  )
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
  // Entregado, la línea es evidencia: el disparador rechaza el borrado.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(
        sql`delete from treatment_budget_item where plan_item_id = '55555555-5555-4555-8555-555555555555'`,
      ),
    ),
  ).rejects.toMatchObject({ cause: { message: expect.stringContaining("no se borran") } })
  const kept = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(
      sql`select id from treatment_budget_item where plan_item_id = '55555555-5555-4555-8555-555555555555'`,
    ),
  )
  expect(kept).toHaveLength(1)
  // Entregado, sus opciones tampoco se quitan ni cambian de recomendada; elegir sí.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`delete from treatment_budget_option where id = '44444444-0000-4000-8000-000000000001'`),
    ),
  ).rejects.toMatchObject({ cause: { message: expect.stringContaining("no se quitan") } })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`update treatment_budget_option set is_recommended = false where id = '44444444-0000-4000-8000-000000000001'`),
    ),
  ).rejects.toThrow()
  const chosen = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(
      sql`update treatment_budget_option set decision = 'elegida' where id = '44444444-0000-4000-8000-000000000001' returning decision`,
    ),
  )
  expect(chosen).toHaveLength(1)
  // Ni el owner borra planes por API: el rol app no tiene DELETE en treatment_plan.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`delete from treatment_plan where id = '33333333-3333-4333-8333-333333333333'`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
})

it("controles, recetas y cuenta se aíslan por tenant y no admiten borrado", async () => {
  const paciente = "99999999-9999-9999-9999-999999999999"
  const planItem = "55555555-5555-4555-8555-555555555555"
  const contacto = "33333333-3333-3333-3333-333333333333"
  const atencion = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  // Vínculo previo: la responsabilidad exige contacto del propio paciente.
  await ownerDb.execute(
    sql`insert into patient_contact (organization_id, patient_id, contact_id, relationship)
        values ('org_a', ${paciente}::uuid, ${contacto}::uuid, 'guardian') on conflict do nothing`,
  )
  await ownerDb.execute(
    sql`insert into clinical_follow_up (organization_id, patient_id, plan_item_id, kind, title, due_at, status)
        values ('org_a', ${paciente}::uuid, ${planItem}::uuid, 'tratamiento', 'Control RLS', now() + interval '7 days', 'pendiente')`,
  )
  await ownerDb.execute(
    sql`insert into prescription (organization_id, patient_id, prescription_number, status)
        values ('org_a', ${paciente}::uuid, 9001, 'emitida')`,
  )
  await ownerDb.execute(
    sql`insert into prescription_item (organization_id, patient_id, prescription_id, medication_name, dose, route, frequency, duration)
        select 'org_a', ${paciente}::uuid, id, 'Ibuprofeno', '400 mg', 'Oral', 'Cada 8 horas', '3 días'
        from prescription where prescription_number = 9001`,
  )
  await ownerDb.execute(
    sql`insert into patient_charge (id, organization_id, patient_id, description, amount_cents, currency)
        values ('c0000000-0000-4000-8000-000000000001', 'org_a', ${paciente}::uuid, 'Cargo RLS', 12000, 'PEN')`,
  )
  await ownerDb.execute(
    sql`insert into patient_payment (id, organization_id, patient_id, amount_cents, currency, paid_at, method_name)
        values ('c0000000-0000-4000-8000-000000000002', 'org_a', ${paciente}::uuid, 8000, 'PEN', now(), 'efectivo')`,
  )
  await ownerDb.execute(
    sql`insert into patient_payment_application (organization_id, patient_id, payment_id, charge_id, amount_cents)
        values ('org_a', ${paciente}::uuid, 'c0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 5000)`,
  )
  await ownerDb.execute(
    sql`insert into patient_payment_refund (organization_id, patient_id, payment_id, amount_cents, refunded_at, reason)
        values ('org_a', ${paciente}::uuid, 'c0000000-0000-4000-8000-000000000002', 1000, now(), 'Ajuste RLS')`,
  )
  await ownerDb.execute(
    sql`insert into patient_responsibility (organization_id, patient_id, contact_id, kind, starts_at)
        values ('org_a', ${paciente}::uuid, ${contacto}::uuid, 'representante_legal', current_date)`,
  )
  // Nota: `atencion` se referencia para documentar el contexto clínico del corte.
  expect(atencion).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")

  for (const table of [
    "clinical_follow_up",
    "prescription",
    "prescription_item",
    "patient_charge",
    "patient_payment",
    "patient_payment_application",
    "patient_payment_refund",
    "patient_responsibility",
  ] as const) {
    const query = sql`select id from ${sql.identifier(table)}`
    expect(
      await withOrgContext(appDb, "org_a", (tx) => tx.execute(query)),
      `${table}: org A`,
    ).toHaveLength(1)
    expect(
      await withOrgContext(appDb, "org_b", (tx) => tx.execute(query)),
      `${table}: org B`,
    ).toHaveLength(0)
    expect(await appDb.execute(query), `${table}: sin contexto`).toHaveLength(0)
    await expect(
      withOrgContext(appDb, "org_a", (tx) =>
        tx.execute(sql`delete from ${sql.identifier(table)}`),
      ),
      `${table}: DELETE denegado`,
    ).rejects.toMatchObject({ cause: { code: "42501" } })
  }

  // Escritura cruzada: con contexto de B no se cuela una fila de A.
  await expect(
    withOrgContext(appDb, "org_b", (tx) =>
      tx.execute(
        sql`insert into patient_charge (organization_id, patient_id, description, amount_cents, currency)
            values ('org_a', ${paciente}::uuid, 'Intruso', 1, 'PEN')`,
      ),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  // La anulación con motivo sí es una corrección permitida sobre el cargo.
  const anulado = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(
      sql`update patient_charge set voided_at = now(), void_reason = 'corrección' where description = 'Cargo RLS' returning id`,
    ),
  )
  expect(anulado).toHaveLength(1)
})

it("los mensajes de WhatsApp de una clínica se aíslan por tenant, no se borran y sus versiones no cruzan de organización", async () => {
  const mensajeA = "abababab-abab-4bab-8bab-abababababab"
  const mensajeB = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd"
  await ownerDb.execute(sql`insert into clinic_message (id, organization_id, key, current_version) values
    (${mensajeA}::uuid, 'org_a', 'recordatorio_cita', 1),
    (${mensajeB}::uuid, 'org_b', 'recordatorio_cita', 0)`)
  await ownerDb.execute(sql`insert into clinic_message_version (organization_id, message_id, number, body, template_name)
    values ('org_a', ${mensajeA}::uuid, 1, 'Hola, {{persona}}.', 'odentia_recordatorio_cita_tprueba')`)
  for (const table of ["clinic_message", "clinic_message_version"]) {
    const query = sql`select 1 from ${sql.identifier(table)}`
    expect(await withOrgContext(appDb, "org_a", (tx) => tx.execute(query)), `${table}: org A`).toHaveLength(1)
    expect(await appDb.execute(query), `${table}: sin contexto`).toHaveLength(0)
    await expect(
      withOrgContext(appDb, "org_a", (tx) => tx.execute(sql`delete from ${sql.identifier(table)}`)),
      `${table}: DELETE denegado`,
    ).rejects.toMatchObject({ cause: { code: "42501" } })
  }
  expect(await withOrgContext(appDb, "org_b", (tx) => tx.execute(sql`select 1 from clinic_message_version`))).toHaveLength(0)
  // Un texto guardado no se reescribe: otro texto es otra versión.
  await expect(
    withOrgContext(appDb, "org_a", (tx) => tx.execute(sql`update clinic_message_version set body = 'Otro'`)),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  // La versión de B no puede colgarse del mensaje de A: el vínculo incluye la organización.
  await expect(
    ownerDb.execute(sql`insert into clinic_message_version (organization_id, message_id, number, body, template_name)
      values ('org_b', ${mensajeA}::uuid, 2, 'Intruso', 'odentia_intruso')`),
  ).rejects.toMatchObject({ cause: { code: "23503" } })
  // Un mensaje es del catálogo o propio, y uno del catálogo no se archiva.
  await expect(
    ownerDb.execute(sql`insert into clinic_message (organization_id, key, title) values ('org_a', 'cita_cancelada', 'Doble')`),
  ).rejects.toMatchObject({ cause: { code: "23514" } })
  await expect(
    ownerDb.execute(sql`update clinic_message set archived_at = now() where id = ${mensajeA}::uuid`),
  ).rejects.toMatchObject({ cause: { code: "23514" } })
  await expect(
    ownerDb.execute(sql`insert into clinic_message (organization_id, key) values ('org_a', 'recordatorio_cita')`),
  ).rejects.toMatchObject({ cause: { code: "23505" } })
})

// Estado final que aseguraban las pruebas de migraciones viejas (ADR 0045):
// se comprueba sobre la base nueva, sin aplicar migraciones parciales.

it("la atención y sus diagnósticos: firma para cerrar, motivo para anular y lo registrado no se reescribe", async () => {
  const persona = "e1000000-0000-4000-8000-000000000001"
  const paciente = "e1000000-0000-4000-8000-000000000002"
  const cerrada = "e1000000-0000-4000-8000-000000000011"
  const borrador = "e1000000-0000-4000-8000-000000000012"
  const guarda = (constraint: string) => ({ cause: { code: "23514", constraint_name: constraint } })
  await ownerDb.execute(
    sql`insert into "user" (id,name,email) values ('rls-dentist','Dentista','rls@example.test') on conflict (id) do nothing`,
  )
  await ownerDb.execute(sql`insert into diagnosis_code_release (system_key, edition, official, license, code_count)
    values ('ICD-10', 'rls', false, 'Solo pruebas', 2) on conflict do nothing`)
  await ownerDb.execute(sql`insert into diagnosis_code (system_key, code, edition, title, is_dental, search_text) values
    ('ICD-10', 'K02.1', 'rls', 'Caries de la dentina', true, 'k02.1 caries de la dentina'),
    ('ICD-10', 'K05.1', 'rls', 'Gingivitis crónica', true, 'k05.1 gingivitis cronica')
    on conflict do nothing`)
  await insertContact(ownerDb, persona, "org_a", "Paciente Diagnóstico")
  await insertPatient(ownerDb, paciente, "org_a", persona, 9101, "Paciente Diagnóstico")
  const diagnostico = (encounterId: string, code: string) =>
    sql`insert into encounter_diagnosis (organization_id, patient_id, encounter_id, diagnosis_system, diagnosis_code, diagnosis_type)
        values ('org_a', ${paciente}::uuid, ${encounterId}::uuid, 'ICD-10', ${code}, 'confirmed') returning id`

  // Cerrar exige la firma con colegiatura.
  await ownerDb.execute(sql`insert into encounter (id, organization_id, patient_id, dentist_user_id)
    values (${cerrada}::uuid, 'org_a', ${paciente}::uuid, 'rls-dentist')`)
  const [d1] = await ownerDb.execute<{ id: string }>(diagnostico(cerrada, "K02.1"))
  await expect(
    ownerDb.execute(sql`update encounter set status = 'finalizada', finalized_at = now() where id = ${cerrada}::uuid`),
  ).rejects.toMatchObject(guarda("encounter_signature_required"))
  await ownerDb.execute(sql`update encounter set status = 'finalizada', finalized_at = now(),
    signer_name = 'Dra. Prueba', signer_registration = 'COP 1' where id = ${cerrada}::uuid`)
  // Cerrada: no entra un diagnóstico nuevo ni se anula uno; su estado clínico sí sigue al paciente.
  await expect(ownerDb.execute(diagnostico(cerrada, "K05.1"))).rejects.toMatchObject(guarda("encounter_child_draft_only"))
  await ownerDb.execute(sql`update encounter_diagnosis set status = 'resuelto', resolved_at = now() where id = ${d1!.id}::uuid`)
  await expect(
    ownerDb.execute(sql`update encounter_diagnosis set voided_at = now(), voided_by = 'rls-dentist', void_reason = 'Error'
      where id = ${d1!.id}::uuid`),
  ).rejects.toMatchObject(guarda("encounter_child_draft_only"))

  // En borrador lo registrado no se reescribe: se anula, y la anulación es definitiva.
  await ownerDb.execute(sql`insert into encounter (id, organization_id, patient_id, dentist_user_id)
    values (${borrador}::uuid, 'org_a', ${paciente}::uuid, 'rls-dentist')`)
  const [d2] = await ownerDb.execute<{ id: string }>(diagnostico(borrador, "K05.1"))
  await expect(
    ownerDb.execute(sql`update encounter_diagnosis set note = 'otra' where id = ${d2!.id}::uuid`),
  ).rejects.toMatchObject(guarda("encounter_child_draft_only"))
  await expect(
    ownerDb.execute(sql`update encounter_diagnosis set diagnosis_code = 'K02.1' where id = ${d2!.id}::uuid`),
  ).rejects.toMatchObject(guarda("encounter_child_draft_only"))
  await ownerDb.execute(sql`update encounter_diagnosis set voided_at = now(), voided_by = 'rls-dentist', void_reason = 'Duplicado'
    where id = ${d2!.id}::uuid`)
  await expect(
    ownerDb.execute(sql`update encounter_diagnosis set voided_at = null, voided_by = null, void_reason = null
      where id = ${d2!.id}::uuid`),
  ).rejects.toMatchObject(guarda("encounter_child_draft_only"))

  // Anular la atención exige motivo y lo anulado no se reescribe.
  await expect(
    ownerDb.execute(sql`update encounter set status = 'anulada' where id = ${borrador}::uuid`),
  ).rejects.toMatchObject(guarda("encounter_void_check"))
  await ownerDb.execute(sql`update encounter set status = 'anulada', voided_at = now(), voided_by = 'rls-dentist',
    void_reason = 'Paciente equivocado' where id = ${borrador}::uuid`)
  await expect(
    ownerDb.execute(sql`update encounter set reason = 'Otro' where id = ${borrador}::uuid`),
  ).rejects.toMatchObject(guarda("encounter_finalized_immutable"))

  // La cita de una atención existe y es del mismo paciente.
  await expect(
    ownerDb.execute(sql`insert into encounter (organization_id, patient_id, dentist_user_id, appointment_id)
      values ('org_a', ${paciente}::uuid, 'rls-dentist', gen_random_uuid())`),
  ).rejects.toMatchObject({ cause: { code: "23503" } })
  const [unidad] = await ownerDb.execute<{ id: string }>(sql`
    insert into schedule_chair (organization_id, branch_id, name)
    values ('org_a', '11111111-1111-1111-1111-111111111111', 'Unidad dental FK') returning id`)
  const [ajena] = await ownerDb.execute<{ id: string }>(sql`
    insert into appointment (organization_id, branch_id, patient_id, dentist_user_id, chair_id, starts_at, ends_at, duration_min, status)
    values ('org_a', '11111111-1111-1111-1111-111111111111', '99999999-9999-9999-9999-999999999999', 'rls-dentist', ${unidad!.id},
      now() + interval '3 days', now() + interval '3 days 30 minutes', 30, 'cancelada')
    returning id`)
  await expect(
    ownerDb.execute(sql`insert into encounter (organization_id, patient_id, dentist_user_id, appointment_id)
      values ('org_a', ${paciente}::uuid, 'rls-dentist', ${ajena!.id}::uuid)`),
  ).rejects.toMatchObject({ cause: { code: "23503" } })

  // Diagnósticos: aislados por organización y sin borrado para la app.
  const consulta = sql`select id from encounter_diagnosis where patient_id = ${paciente}::uuid`
  expect(await withOrgContext(appDb, "org_a", (tx) => tx.execute(consulta))).toHaveLength(2)
  expect(await withOrgContext(appDb, "org_b", (tx) => tx.execute(consulta))).toHaveLength(0)
  expect(await appDb.execute(consulta)).toHaveLength(0)
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`delete from encounter_diagnosis where patient_id = ${paciente}::uuid`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })

  // La lista de diagnósticos es global: la app la lee sin contexto y no la escribe.
  expect(await appDb.execute(sql`select code from diagnosis_code where edition = 'rls'`)).toHaveLength(2)
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`insert into diagnosis_code (system_key, code, edition, title, is_dental, search_text)
        values ('ICD-10', 'K99.9', 'rls', 'Intrusa', false, 'k99.9')`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`update diagnosis_code set title = 'hack' where edition = 'rls'`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
})

it("persona única: una ficha por persona, su vínculo propio lo cuida la base y el documento es de una sola persona", async () => {
  const persona = "e2000000-0000-4000-8000-000000000001"
  const ficha = "e2000000-0000-4000-8000-000000000002"
  const otra = "e2000000-0000-4000-8000-000000000003"
  await insertContact(ownerDb, persona, "org_a", "Persona Única")
  await insertPatient(ownerDb, ficha, "org_a", persona, 9102, "Persona Única")
  const propio = async () =>
    (await ownerDb.execute<{ contact_id: string }>(
      sql`select contact_id from patient_contact where patient_id = ${ficha}::uuid and relationship = 'self'`,
    )) as unknown as { contact_id: string }[]
  // La base crea el vínculo propio desde person_id.
  expect([...(await propio())]).toEqual([{ contact_id: persona }])
  // Sin persona no hay ficha, y una persona tiene una sola ficha.
  await expect(
    ownerDb.execute(sql`insert into patient (organization_id, patient_number) values ('org_a', 9103)`),
  ).rejects.toMatchObject({ cause: { code: "23502" } })
  await expect(
    ownerDb.execute(sql`insert into patient (organization_id, person_id, patient_number) values ('org_a', ${persona}::uuid, 9104)`),
  ).rejects.toMatchObject({ cause: { code: "23505" } })
  // El vínculo propio no se retira ni se degrada.
  await expect(
    ownerDb.execute(sql`delete from patient_contact where patient_id = ${ficha}::uuid and relationship = 'self'`),
  ).rejects.toMatchObject({ cause: { code: "23514" } })
  await expect(
    ownerDb.execute(sql`update patient_contact set relationship = 'family' where patient_id = ${ficha}::uuid and relationship = 'self'`),
  ).rejects.toMatchObject({ cause: { code: "23514" } })
  // Cambiar la persona de la ficha mueve su vínculo propio, sin dejar otro.
  await insertContact(ownerDb, otra, "org_a", "Persona Real")
  await ownerDb.execute(sql`update patient set person_id = ${otra}::uuid where id = ${ficha}::uuid`)
  expect([...(await propio())]).toEqual([{ contact_id: otra }])
  expect(await ownerDb.execute(sql`select 1 from patient_contact where patient_id = ${ficha}::uuid`)).toHaveLength(1)
  // El documento es único por organización junto con su país emisor; sin país también (NULLS NOT DISTINCT).
  await ownerDb.execute(sql`update contact set doc_type = 'DNI', doc_number = '40009901', doc_country = 'PE' where id = ${otra}::uuid`)
  await expect(
    ownerDb.execute(sql`insert into contact (organization_id, display_name, doc_type, doc_number, doc_country)
      values ('org_a', 'Doble', 'DNI', '40009901', 'PE')`),
  ).rejects.toMatchObject({ cause: { code: "23505" } })
  await ownerDb.execute(sql`insert into contact (organization_id, display_name, doc_type, doc_number) values ('org_a', 'Sin país', 'CE', 'X-9901')`)
  await expect(
    ownerDb.execute(sql`insert into contact (organization_id, display_name, doc_type, doc_number) values ('org_a', 'Sin país 2', 'CE', 'X-9901')`),
  ).rejects.toMatchObject({ cause: { code: "23505" } })
  await ownerDb.execute(sql`insert into contact (organization_id, display_name, doc_type, doc_number, doc_country)
    values ('org_b', 'Otra clínica', 'DNI', '40009901', 'PE')`)
  // El nombre visible se deriva del nombre separado.
  const [nombre] = await ownerDb.execute<{ display_name: string }>(sql`
    insert into contact (organization_id, display_name, given_names, family_name)
    values ('org_a', 'x', 'Rosa María', 'Quispe  Huamán') returning display_name`)
  expect(nombre?.display_name).toBe("Rosa María Quispe Huamán")
})

it("vínculos y altas: únicos, sin cruzar de clínica, aislados y la alta no se reescribe", async () => {
  const persona = "e3000000-0000-4000-8000-000000000001"
  const ficha = "e3000000-0000-4000-8000-000000000002"
  const madre = "e3000000-0000-4000-8000-000000000003"
  await insertContact(ownerDb, persona, "org_a", "Registro Uno")
  await insertContact(ownerDb, madre, "org_a", "Registro Madre")
  await insertPatient(ownerDb, ficha, "org_a", persona, 9105, "Registro Uno")
  const vinculo = (patientId: string, contactId: string, relationship: string, preferred = false) =>
    sql`insert into patient_contact (organization_id, patient_id, contact_id, relationship, is_preferred)
        values ('org_a', ${patientId}::uuid, ${contactId}::uuid, ${relationship}, ${preferred})`
  // El mismo par, un segundo propio o un segundo preferente (el propio nació preferente) no entran.
  await expect(ownerDb.execute(vinculo(ficha, persona, "family"))).rejects.toMatchObject({ cause: { code: "23505" } })
  await expect(ownerDb.execute(vinculo(ficha, madre, "self"))).rejects.toMatchObject({ cause: { code: "23505" } })
  await expect(ownerDb.execute(vinculo(ficha, madre, "guardian", true))).rejects.toMatchObject({ cause: { code: "23505" } })
  await ownerDb.execute(vinculo(ficha, madre, "guardian"))
  // Ni contacto ni paciente de otra organización.
  await expect(
    ownerDb.execute(vinculo(ficha, "44444444-4444-4444-4444-444444444444", "family")),
  ).rejects.toMatchObject({ cause: { code: "23503" } })
  await expect(
    ownerDb.execute(vinculo("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", madre, "family")),
  ).rejects.toMatchObject({ cause: { code: "23503" } })
  const vinculos = sql`select contact_id from patient_contact where patient_id = ${ficha}::uuid`
  expect(await withOrgContext(appDb, "org_a", (tx) => tx.execute(vinculos))).toHaveLength(2)
  expect(await withOrgContext(appDb, "org_b", (tx) => tx.execute(vinculos))).toHaveLength(0)
  expect(await appDb.execute(vinculos)).toHaveLength(0)

  // Catálogos de la ficha: grupo sanguíneo y severidad de la alergia.
  await expect(
    ownerDb.execute(sql`update patient set blood_group = 'X' where id = ${ficha}::uuid`),
  ).rejects.toMatchObject({ cause: { code: "23514" } })
  await ownerDb.execute(sql`update patient set blood_group = 'O+' where id = ${ficha}::uuid`)
  const alergia = (severity: string) =>
    sql`insert into patient_allergy (organization_id, patient_id, substance, severity) values ('org_a', ${ficha}::uuid, 'Penicilina', ${severity})`
  await expect(ownerDb.execute(alergia("grave"))).rejects.toMatchObject({ cause: { code: "23514" } })
  await ownerDb.execute(alergia("severa"))

  // La alta es de solo anexado para la app y se aísla por organización.
  await ownerDb.execute(sql`insert into patient_registration (organization_id, patient_id, entry_point, answers)
    values ('org_a', ${ficha}::uuid, 'platform', '{}'::jsonb)`)
  const altas = sql`select id from patient_registration where patient_id = ${ficha}::uuid`
  expect(await withOrgContext(appDb, "org_a", (tx) => tx.execute(altas))).toHaveLength(1)
  expect(await withOrgContext(appDb, "org_b", (tx) => tx.execute(altas))).toHaveLength(0)
  expect(await appDb.execute(altas)).toHaveLength(0)
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`update patient_registration set privacy_notice = 'revisado' where patient_id = ${ficha}::uuid`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`delete from patient_registration where patient_id = ${ficha}::uuid`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })

  // La configuración del registro de otra clínica no se ve.
  await ownerDb.execute(sql`insert into patient_registration_config (organization_id, fields) values ('org_b', '{}'::jsonb)`)
  const config = sql`select organization_id from patient_registration_config where organization_id = 'org_b'`
  expect(await withOrgContext(appDb, "org_a", (tx) => tx.execute(config))).toHaveLength(0)
  expect(await withOrgContext(appDb, "org_b", (tx) => tx.execute(config))).toHaveLength(1)

  // La huella del enlace de registro es única en toda la base, no solo en la clínica.
  const enlace = (org: string, contactId: string, conversationId: string) =>
    sql`insert into patient_registration_link (organization_id, contact_id, conversation_id, token_hash, expires_at)
        values (${org}, ${contactId}::uuid, ${conversationId}::uuid, 'rls-hash-unico', now() + interval '3 days')`
  await ownerDb.execute(enlace("org_a", "33333333-3333-3333-3333-333333333333", "77777777-7777-7777-7777-777777777777"))
  await expect(
    ownerDb.execute(enlace("org_b", "44444444-4444-4444-4444-444444444444", "88888888-8888-8888-8888-888888888888")),
  ).rejects.toMatchObject({ cause: { code: "23505" } })
})

it("ventas: solo los cuatro pasos fijos y una sola tarea abierta por oportunidad", async () => {
  const [pipe] = await ownerDb.execute<{ id: string }>(
    sql`insert into pipeline (organization_id, name) values ('org_a', 'Ventas RLS') returning id`,
  )
  const paso = (name: string, position: number, moment: string) =>
    sql`insert into pipeline_stage (organization_id, pipeline_id, name, position, moment)
        values ('org_a', ${pipe!.id}::uuid, ${name}, ${position}, ${moment}) returning id`
  const [interesado] = await ownerDb.execute<{ id: string }>(paso("Interesado", 0, "interesado"))
  await expect(ownerDb.execute(paso("Contactado", 1, "contactado"))).rejects.toMatchObject({ cause: { code: "23514" } })
  await expect(ownerDb.execute(paso("Otro interesado", 2, "interesado"))).rejects.toMatchObject({ cause: { code: "23505" } })
  const [opp] = await ownerDb.execute<{ id: string }>(sql`
    insert into opportunity (organization_id, contact_id, pipeline_id, stage_id, title, currency)
    values ('org_a', '33333333-3333-3333-3333-333333333333', ${pipe!.id}::uuid, ${interesado!.id}::uuid, 'Implante RLS', 'PEN')
    returning id`)
  const tarea = (title: string) =>
    sql`insert into task (organization_id, contact_id, opportunity_id, title, created_by)
        values ('org_a', '33333333-3333-3333-3333-333333333333', ${opp!.id}::uuid, ${title}, 'user') returning id`
  const [primera] = await ownerDb.execute<{ id: string }>(tarea("Llamar"))
  await expect(ownerDb.execute(tarea("Otra"))).rejects.toMatchObject({ cause: { code: "23505" } })
  // Hecha la primera, la siguiente sí entra.
  await ownerDb.execute(sql`update task set status = 'done' where id = ${primera!.id}::uuid`)
  await ownerDb.execute(tarea("Siguiente"))
})

it("una tabla nueva nace cerrada al rol app y lo que este alcanza de una clínica lleva RLS", async () => {
  // ADR 0063: el acceso del rol app se concede tabla por tabla, nunca por defecto.
  await ownerDb.execute(sql`create table "permiso_por_defecto" ("id" int primary key)`)
  try {
    const [nueva] = (await ownerDb.execute(
      sql`select has_table_privilege(${APP_ROLE}, 'public.permiso_por_defecto', 'select, insert, update, delete') as "alcanza"`,
    )) as unknown as { alcanza: boolean }[]
    expect(nueva!.alcanza).toBe(false)
  } finally {
    await ownerDb.execute(sql`drop table "permiso_por_defecto"`)
  }

  // Vendedores y liquidaciones son solo de odentIA.
  const admin = (await ownerDb.execute(sql`
    select c.relname as "tabla"
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('saas_seller', 'saas_commission_settlement', 'saas_commission_settlement_line')
      and has_table_privilege(${APP_ROLE}, c.oid, 'select, insert, update, delete')
  `)) as unknown as { tabla: string }[]
  expect(admin).toEqual([])

  // Una tabla con organization_id que el rol app alcanza sin RLS mostraría las
  // filas de todas las clínicas. member e invitation son del adaptador de
  // identidad, que filtra por organización en cada consulta.
  const abiertas = (await ownerDb.execute(sql`
    select c.relname as "tabla"
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
      and has_table_privilege(${APP_ROLE}, c.oid, 'select, insert, update, delete')
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
    order by 1
  `)) as unknown as { tabla: string }[]
  expect(abiertas.map((r) => r.tabla)).toEqual(["invitation", "member"])
})
