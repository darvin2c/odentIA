// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver docs).
// El servicio `podman-api` lo expone; requiere chmod 777 tras (re)crearlo.
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock";

import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAppDb, createOwnerDb, type Db } from "./client.js";
import { withOrgContext } from "./context.js";

// Imagen propia (infra/dev/postgres): trae pgmq + pg_cron, requeridos por la
// migración (pgmq.create) y el init (rol app + extensiones).
const IMAGE = "dentalagent-postgres:18.6";
const APP_ROLE = "dentalagent_app";
const APP_PASSWORD = "dentalagent_app";

let container: StartedTestContainer;
let ownerDb: Db;
let appDb: Db;

async function insertOrg(db: Db, id: string, slug: string) {
  await db.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at")
        values (${id}, ${"Clínica " + slug}, ${slug}, now())`,
  );
}

async function insertBranch(db: Db, id: string, orgId: string, name: string) {
  await db.execute(
    sql`insert into "branch" ("id", "organization_id", "name")
        values (${id}::uuid, ${orgId}, ${name})`,
  );
}

async function branchNames(db: Db): Promise<string[]> {
  const rows = await db.execute<{ name: string }>(sql`select "name" from "branch" order by "name"`);
  return (rows as unknown as { name: string }[]).map((r) => r.name);
}

async function insertContact(db: Db, id: string, orgId: string, name: string) {
  await db.execute(
    sql`insert into "contact" ("id", "organization_id", "display_name")
        values (${id}::uuid, ${orgId}, ${name})`,
  );
}

async function insertConnection(db: Db, id: string, orgId: string) {
  await db.execute(
    sql`insert into "channel_connection"
          ("id", "organization_id", "channel", "provider", "display_name", "config_encrypted", "webhook_secret")
        values (${id}::uuid, ${orgId}, 'telegram', 'telegram_bot_api', 'Bot', 'enc', 'secret')`,
  );
}

async function insertConversation(db: Db, id: string, orgId: string, contactId: string, connId: string) {
  await db.execute(
    sql`insert into "conversation"
          ("id", "organization_id", "contact_id", "channel_connection_id", "external_thread_id")
        values (${id}::uuid, ${orgId}, ${contactId}::uuid, ${connId}::uuid, ${"thread-" + id})`,
  );
}

async function insertMessage(db: Db, orgId: string, conversationId: string, body: string, externalId: string | null) {
  await db.execute(
    sql`insert into "message"
          ("organization_id", "conversation_id", "direction", "sender_kind", "body", "external_id")
        values (${orgId}, ${conversationId}::uuid, 'in', 'contact', ${body}, ${externalId})`,
  );
}

async function contactNames(db: Db): Promise<string[]> {
  const rows = await db.execute<{ display_name: string }>(
    sql`select "display_name" from "contact" order by "display_name"`,
  );
  return (rows as unknown as { display_name: string }[]).map((r) => r.display_name);
}

async function insertPatient(db: Db, id: string, orgId: string, contactId: string, number: number) {
  await db.execute(
    sql`insert into "patient" ("id", "organization_id", "contact_id", "patient_number")
        values (${id}::uuid, ${orgId}, ${contactId}::uuid, ${number})`,
  );
}

async function patientNumbers(db: Db): Promise<number[]> {
  const rows = await db.execute<{ patient_number: number }>(
    sql`select "patient_number" from "patient" order by "patient_number"`,
  );
  return (rows as unknown as { patient_number: number }[]).map((r) => r.patient_number);
}

async function messageBodies(db: Db): Promise<string[]> {
  const rows = await db.execute<{ body: string }>(sql`select "body" from "message" order by "body"`);
  return (rows as unknown as { body: string }[]).map((r) => r.body);
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
    .start();
  const uri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`;
  ownerDb = createOwnerDb(uri);
  await migrate(ownerDb, { migrationsFolder: "./drizzle" });

  appDb = createAppDb(
    `postgres://${APP_ROLE}:${APP_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  );

  await insertOrg(ownerDb, "org_a", "norte");
  await insertOrg(ownerDb, "org_b", "sur");
  await insertBranch(ownerDb, "11111111-1111-1111-1111-111111111111", "org_a", "Sede Lima");
  await insertBranch(ownerDb, "22222222-2222-2222-2222-222222222222", "org_b", "Sede Sur");
  await insertContact(ownerDb, "33333333-3333-3333-3333-333333333333", "org_a", "Paciente Ana");
  await insertContact(ownerDb, "44444444-4444-4444-4444-444444444444", "org_b", "Paciente Beto");
  await insertConnection(ownerDb, "55555555-5555-5555-5555-555555555555", "org_a");
  await insertConnection(ownerDb, "66666666-6666-6666-6666-666666666666", "org_b");
  await insertConversation(
    ownerDb,
    "77777777-7777-7777-7777-777777777777",
    "org_a",
    "33333333-3333-3333-3333-333333333333",
    "55555555-5555-5555-5555-555555555555",
  );
  await insertConversation(
    ownerDb,
    "88888888-8888-8888-8888-888888888888",
    "org_b",
    "44444444-4444-4444-4444-444444444444",
    "66666666-6666-6666-6666-666666666666",
  );
  await insertMessage(
    ownerDb,
    "org_a",
    "77777777-7777-7777-7777-777777777777",
    "Hola",
    "ext-1",
  );
  await insertMessage(
    ownerDb,
    "org_b",
    "88888888-8888-8888-8888-888888888888",
    "Buenas",
    "ext-2",
  );
  await insertPatient(ownerDb, "99999999-9999-9999-9999-999999999999", "org_a", "33333333-3333-3333-3333-333333333333", 1);
  await insertPatient(ownerDb, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "org_b", "44444444-4444-4444-4444-444444444444", 1);
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

it("con contexto de org A solo ve la sucursal A", async () => {
  const names = await withOrgContext(appDb, "org_a", (tx) => branchNames(tx));
  expect(names).toEqual(["Sede Lima"]);
});

it("sin contexto de org, el rol app ve 0 filas", async () => {
  expect(await branchNames(appDb)).toEqual([]);
});

it("el rol owner bypasea RLS y ve todas las sucursales", async () => {
  expect(await branchNames(ownerDb)).toEqual(["Sede Lima", "Sede Sur"]);
});

it("con contexto de org A solo ve contactos y mensajes de A", async () => {
  expect(await withOrgContext(appDb, "org_a", (tx) => contactNames(tx))).toEqual(["Paciente Ana"]);
  expect(await withOrgContext(appDb, "org_a", (tx) => messageBodies(tx))).toEqual(["Hola"]);
  expect(await withOrgContext(appDb, "org_b", (tx) => contactNames(tx))).toEqual(["Paciente Beto"]);
  expect(await withOrgContext(appDb, "org_b", (tx) => messageBodies(tx))).toEqual(["Buenas"]);
});

it("el dedupe por (conversation_id, external_id) rechaza el segundo insert", async () => {
  await expect(
    insertMessage(ownerDb, "org_a", "77777777-7777-7777-7777-777777777777", "Hola x2", "ext-1"),
  ).rejects.toThrow();
  // external_id null no dedupea: dos mensajes sin id externo conviven.
  await insertMessage(ownerDb, "org_a", "77777777-7777-7777-7777-777777777777", "Sin id 1", null);
  await insertMessage(ownerDb, "org_a", "77777777-7777-7777-7777-777777777777", "Sin id 2", null);
  expect(await withOrgContext(appDb, "org_a", (tx) => messageBodies(tx))).toEqual([
    "Hola",
    "Sin id 1",
    "Sin id 2",
  ]);
});

it("org A no ve pacientes de org B; sin GUC ve cero filas", async () => {
  expect(await withOrgContext(appDb, "org_a", (tx) => patientNumbers(tx))).toEqual([1]);
  expect(await withOrgContext(appDb, "org_b", (tx) => patientNumbers(tx))).toEqual([1]);
  const aIds = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute<{ id: string }>(sql`select "id" from "patient"`),
  );
  expect((aIds as unknown as { id: string }[]).map((r) => r.id)).toEqual(["99999999-9999-9999-9999-999999999999"]);
  expect(await patientNumbers(appDb)).toEqual([]);
});

it("encuentros y planes de A son invisibles para B; las piezas cerradas no se borran", async () => {
  await ownerDb.execute(sql`insert into "user" (id,name,email) values ('rls-dentist','Dentista','rls@example.test')`);
  await ownerDb.execute(sql`insert into encounter (id,organization_id,patient_id,dentist_user_id) values
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','org_a','99999999-9999-9999-9999-999999999999','rls-dentist')`);
  await ownerDb.execute(sql`insert into treatment_plan_item (organization_id,patient_id,title) values
    ('org_a','99999999-9999-9999-9999-999999999999','Restauración')`);
  await ownerDb.execute(sql`insert into encounter_tooth (organization_id,encounter_id,tooth_number) values
    ('org_a','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',36)`);
  await ownerDb.execute(sql`insert into encounter_procedure (organization_id,encounter_id,description) values
    ('org_a','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Restauración 36')`);
  for (const table of ["encounter", "encounter_tooth", "encounter_procedure", "treatment_plan_item"]) {
    const query = sql`select id from ${sql.identifier(table)}`;
    expect(await withOrgContext(appDb, "org_a", (tx) => tx.execute(query))).toHaveLength(1);
    expect(await withOrgContext(appDb, "org_b", (tx) => tx.execute(query))).toHaveLength(0);
    expect(await appDb.execute(query)).toHaveLength(0);
  }
  await ownerDb.execute(sql`update encounter set status='finalizada' where id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'`);
  const deleted = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(sql`delete from encounter_tooth where encounter_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' returning id`));
  expect(deleted).toHaveLength(0);
  await expect(withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(sql`delete from encounter where id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'`))).rejects.toThrow();
});
