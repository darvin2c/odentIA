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

// Kairós vigila el alta (0119 y 0120): cuándo llegó cada archivo, la carga marcada, las tareas
// solo de Administración y la primera vez de cada paso del alta. La base se migra hasta la 0117,
// con datos como los de producción (correos de soporte@, una carga, tareas y los hechos del alta
// de una clínica), y después se despliega el resto.

const IMAGE = "dentalagent-postgres:18.6"
const APP_ROLE = "dentalagent_app"
const FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle")

let container: StartedTestContainer
let ownerDb: Db
let before: string

const ADA = "staff-ada"
const OWNER = "user-propietaria"
const OWNER_B = "user-propietaria-b"
const OWNER_DEMO = "user-demo"

const ORG = "org_alta"
const ORG_REVERTED = "org_revertida"
const ORG_DEMO = "org_demo_alta"
const ORG_ARCHIVED = "org_archivada"

const CLIENT = "c0000000-0000-4000-8000-000000000001"
const CLIENT_REVERTED = "c0000000-0000-4000-8000-000000000002"
const CLIENT_DEMO = "c0000000-0000-4000-8000-000000000003"
const CLIENT_ARCHIVED = "c0000000-0000-4000-8000-000000000004"

const MAIL = "e0000000-0000-4000-8000-000000000001"
const MAIL_GONE = "e0000000-0000-4000-8000-000000000002"

const FILE_MAIL = "f0000000-0000-4000-8000-000000000001"
const FILE_MAIL_GONE = "f0000000-0000-4000-8000-000000000002"
const FILE_CARGA = "f0000000-0000-4000-8000-000000000003"
const FILE_LETTER = "f0000000-0000-4000-8000-000000000004"
const FILE_DEMO_LETTER = "f0000000-0000-4000-8000-000000000005"

const TASK_CHARGE = "a0000000-0000-4000-8000-000000000001"
const TASK_KAIROS = "a0000000-0000-4000-8000-000000000002"
const TASK_PLAIN = "a0000000-0000-4000-8000-000000000003"

const CONNECTION = "b0000000-0000-4000-8000-000000000001"
const PATIENT = "b0000000-0000-4000-8000-000000000002"
const CONVERSATION = "b0000000-0000-4000-8000-000000000003"

function migrationsBefore(suffix: string): string {
  const journal = JSON.parse(readFileSync(join(FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[]
  }
  const position = journal.entries.findIndex((entry) => entry.tag.endsWith(suffix))
  if (position < 0) throw new Error(`falta la migración «${suffix}» en el journal`)
  const entries = journal.entries.slice(0, position)
  const dir = mkdtempSync(join(tmpdir(), "odentia-alta-"))
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

const iso = (column: string) =>
  sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`)

async function insertOrg(id: string, name: string, owner: string, ownerSince: string) {
  await ownerDb.execute(sql`
    insert into "organization" ("id", "name", "slug", "created_at")
    values (${id}, ${name}, ${id.replaceAll("_", "-")}, '2026-10-01 12:00:00')`)
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at")
    values (${`m-${id}`}, ${id}, ${owner}, 'owner', ${ownerSince}::timestamp)`)
}

async function insertClient(id: string, name: string, organizationId: string | null) {
  await ownerDb.execute(sql`
    insert into "saas_client" ("id", "name", "product", "organization_id")
    values (${id}::uuid, ${name}, 'dental', ${organizationId})`)
}

async function insertMail(id: string, receivedAt: string, fileId: string, messageId: string) {
  await ownerDb.execute(sql`
    insert into "saas_inbound_email" ("id", "client_id", "mailbox", "product", "message_id", "from_address",
      "to_address", "received_at", "attachments")
    values (${id}::uuid, ${CLIENT}::uuid, 'soporte', 'dental', ${messageId}, 'clinica@example.test',
      'soporte@odentia32.com', ${receivedAt}::timestamptz,
      ${JSON.stringify([{ filename: "pacientes.xlsx", contentType: "application/vnd.ms-excel", size: 10, fileId }])}::jsonb)`)
}

async function insertFile(
  id: string,
  input: {
    clientId?: string
    kind: string
    createdAt: string
    deleteAfter?: string | null
    deletedAt?: string | null
  },
) {
  await ownerDb.execute(sql`
    insert into "saas_client_file" ("id", "client_id", "kind", "filename", "object_key", "content_type",
      "size_bytes", "delete_after", "deleted_at", "created_by", "source", "created_at")
    values (${id}::uuid, ${input.clientId ?? CLIENT}::uuid, ${input.kind}, 'archivo.xlsx', ${`clients/${id}`},
      'application/vnd.ms-excel', 10, ${input.deleteAfter ?? null}::date, ${input.deletedAt ?? null}::timestamptz,
      ${ADA}, ${input.kind === "correo" ? "correo" : "persona"}, ${input.createdAt}::timestamptz)`)
}

async function insertTask(id: string, kind: string, kairosKey: string | null) {
  await ownerDb.execute(sql`
    insert into "saas_task" ("id", "client_id", "kind", "title", "due_on", "by_kairos", "kairos_key")
    values (${id}::uuid, ${CLIENT}::uuid, ${kind}, 'Algo que hacer', '2026-11-20', ${kairosKey !== null}, ${kairosKey})`)
}

async function insertAudit(
  action: string,
  organizationId: string,
  at: string,
  metadata: object,
  entityId?: string,
) {
  await ownerDb.execute(sql`
    insert into "admin_audit" ("actor_user_id", "actor_role", "action", "organization_id", "entity_id", "metadata", "created_at")
    values (${ADA}, 'admin', ${action}, ${organizationId}, ${entityId ?? null}, ${JSON.stringify(metadata)}::jsonb, ${at}::timestamptz)`)
}

async function insertPayment(
  organizationId: string,
  key: string,
  status: "confirmado" | "reversado",
  confirmedAt: string,
) {
  await ownerDb.execute(sql`
    insert into "saas_payment" ("organization_id", "amount_cents", "currency", "method_code", "idempotency_key",
      "status", "confirmed_at", "confirmed_by", "created_by", "created_at")
    values (${organizationId}, 19900, 'PEN', 'transferencia', ${key}, 'confirmado', ${confirmedAt}::timestamptz, ${ADA}, ${ADA},
      ${confirmedAt}::timestamptz)`)
  if (status === "reversado")
    await ownerDb.execute(sql`
      update "saas_payment" set "status" = 'reversado', "reversed_at" = ${confirmedAt}::timestamptz + interval '1 day',
        "reversed_by" = ${ADA}, "reverse_reason" = 'El banco lo devolvió'
      where "idempotency_key" = ${key}`)
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
  before = migrationsBefore("0119_kairos_vigila_el_alta")
  await migrate(ownerDb, { migrationsFolder: before })

  await ownerDb.execute(sql`
    insert into "user" ("id", "name", "email") values
      (${ADA}, 'Ada', 'ada@example.test'),
      (${OWNER}, 'Inés', 'ines@example.test'),
      (${OWNER_B}, 'Rosa', 'rosa@example.test'),
      (${OWNER_DEMO}, 'Demo', 'demo@example.test')`)

  // La clínica en alta, una cuyo único pago se revirtió, una demo para presentar y un cliente
  // archivado.
  await insertOrg(ORG, "Clínica Alta", OWNER, "2026-10-02 12:00:00")
  await insertOrg(ORG_REVERTED, "Clínica Revertida", OWNER_B, "2026-10-04 12:00:00")
  await insertOrg(ORG_DEMO, "Demo del alta", OWNER_DEMO, "2026-10-02 12:00:00")
  await ownerDb.execute(
    sql`update "saas_subscription" set "is_demo" = true where "organization_id" = ${ORG_DEMO}`,
  )
  await insertClient(CLIENT, "Clínica Alta", ORG)
  await insertClient(CLIENT_REVERTED, "Clínica Revertida", ORG_REVERTED)
  await insertClient(CLIENT_DEMO, "Demo del alta", ORG_DEMO)
  await insertOrg(ORG_ARCHIVED, "Archivada", OWNER_DEMO, "2026-10-02 12:00:00")
  await insertClient(CLIENT_ARCHIVED, "Archivada", ORG_ARCHIVED)
  await ownerDb.execute(
    sql`update "saas_client" set "archived_at" = now() where "id" = ${CLIENT_ARCHIVED}::uuid`,
  )

  // Archivos: un adjunto de soporte@ por borrarse, otro ya borrado, la carga (con un plazo más
  // largo que 30 días) y la carta, ya borrada. La demo tiene su carta: no tiene hitos.
  await insertFile(FILE_MAIL, {
    kind: "correo",
    createdAt: "2026-11-01T10:05:00Z",
    deleteAfter: "2026-12-01",
  })
  await insertMail(MAIL, "2026-11-01T10:00:00Z", FILE_MAIL, "<uno@example.test>")
  await insertFile(FILE_MAIL_GONE, {
    kind: "correo",
    createdAt: "2026-09-15T10:05:00Z",
    deleteAfter: "2026-10-15",
    deletedAt: "2026-10-15T08:00:00Z",
  })
  await insertMail(MAIL_GONE, "2026-09-15T10:00:00Z", FILE_MAIL_GONE, "<dos@example.test>")
  await insertFile(FILE_CARGA, {
    kind: "archivo_clinica",
    createdAt: "2026-11-02T15:00:00Z",
    deleteAfter: "2026-12-30",
  })
  await insertFile(FILE_LETTER, {
    kind: "carta",
    createdAt: "2026-10-05T12:00:00Z",
    deletedAt: "2026-10-20T12:00:00Z",
  })
  await insertFile(FILE_DEMO_LETTER, {
    clientId: CLIENT_DEMO,
    kind: "carta",
    createdAt: "2026-10-05T12:00:00Z",
  })

  // Tareas: una de cobro, una de Kairós solo de Administración y una de cualquiera.
  await insertTask(TASK_CHARGE, "cobro", null)
  await insertTask(TASK_KAIROS, "alta", "carga_sin_informe:org_alta:2026-11-10")
  await insertAudit(
    "kairos.task_created",
    ORG,
    "2026-11-10T12:00:00Z",
    { rule: "carga_sin_informe", kind: "alta", adminOnly: true },
    TASK_KAIROS,
  )
  await insertTask(TASK_PLAIN, "llamar", null)
  await insertAudit(
    "kairos.task_created",
    ORG,
    "2026-11-10T12:00:00Z",
    { rule: "x", kind: "llamar", adminOnly: false },
    TASK_PLAIN,
  )

  // Los hechos del alta de la clínica: aceptó una versión vieja del contrato, la carga y el
  // informe (con la hora del correo aparte), su primera sesión, un pago confirmado y un mensaje
  // que llegó por su WhatsApp, sin verificar la dirección. Nadie más del equipo.
  await ownerDb.execute(sql`
    insert into "processing_agreement_acceptance" ("organization_id", "version", "accepted_by", "accepted_at")
    values (${ORG}, '2020-01-01', ${OWNER}, '2026-10-03T12:00:00Z')`)
  await insertAudit("org.setup_import", ORG, "2026-11-03T12:00:00Z", { created: 4 })
  await insertAudit("org.data_import", ORG, "2026-11-04T12:00:00Z", {
    from: 0,
    creadas: 20,
    planSha256: "abc",
  })
  await ownerDb.execute(sql`
    insert into "clinic_import_row" ("organization_id", "source_key", "contact_id", "outcome", "plan_sha256", "created_by", "created_at")
    values (${ORG}, 'fila-1', gen_random_uuid(), 'creada', 'abc', ${ADA}, '2026-11-04T12:01:00Z')`)
  await insertAudit(
    "org.progress_report_sent",
    ORG,
    "2026-11-06T12:00:00Z",
    { sentAt: "2026-11-05T09:00:00.000Z", registered: true },
    "informe-1",
  )
  await ownerDb.execute(sql`
    insert into "session" ("id", "expires_at", "token", "created_at", "updated_at", "user_id")
    values ('sesion-1', '2026-12-01 00:00:00', 'token-1', '2026-10-02 13:00:00', '2026-10-02 14:00:00', ${OWNER})`)
  await insertPayment(ORG, "pago-1", "confirmado", "2026-11-07T12:00:00Z")
  await insertPayment(ORG_REVERTED, "pago-2", "reversado", "2026-11-07T12:00:00Z")
  await ownerDb.execute(sql`
    insert into "channel_connection" ("id", "organization_id", "channel", "provider", "display_name", "config_encrypted", "webhook_secret")
    values (${CONNECTION}::uuid, ${ORG}, 'whatsapp', 'whatsapp_cloud', 'WhatsApp', 'cifrado', 'secreto')`)
  await ownerDb.execute(sql`
    insert into "contact" ("id", "organization_id", "display_name") values (${PATIENT}::uuid, ${ORG}, 'Paciente')`)
  await ownerDb.execute(sql`
    insert into "conversation" ("id", "organization_id", "contact_id", "channel_connection_id", "external_thread_id")
    values (${CONVERSATION}::uuid, ${ORG}, ${PATIENT}::uuid, ${CONNECTION}::uuid, 'hilo-1')`)
  await ownerDb.execute(sql`
    insert into "message" ("organization_id", "conversation_id", "direction", "sender_kind", "body", "created_at")
    values (${ORG}, ${CONVERSATION}::uuid, 'in', 'contact', 'Hola', '2026-11-08T12:00:00Z')`)

  // El resto de las migraciones, como en el despliegue.
  await migrate(ownerDb, { migrationsFolder: FOLDER })
})

afterAll(async () => {
  await container?.stop()
  if (before) rmSync(before, { recursive: true, force: true })
})

describe("al desplegar", () => {
  it("cada archivo sabe cuándo llegó y por qué correo", async () => {
    const files = rows<{ id: string; received_at: string; inbound_email_id: string | null }>(
      await ownerDb.execute(sql`
        select "id", ${iso('"received_at"')} as "received_at", "inbound_email_id"
        from "saas_client_file" where "client_id" = ${CLIENT}::uuid order by "id"`),
    )
    expect(files).toEqual([
      { id: FILE_MAIL, received_at: "2026-11-01T10:00:00Z", inbound_email_id: MAIL },
      { id: FILE_MAIL_GONE, received_at: "2026-09-15T10:00:00Z", inbound_email_id: MAIL_GONE },
      { id: FILE_CARGA, received_at: "2026-11-02T15:00:00Z", inbound_email_id: null },
      { id: FILE_LETTER, received_at: "2026-10-05T12:00:00Z", inbound_email_id: null },
    ])
  })

  it("lo de soporte@ por borrarse deja de estarlo, con su constancia; lo ya borrado no cambia", async () => {
    const files = rows<{ id: string; delete_after: string | null; deleted: boolean }>(
      await ownerDb.execute(sql`
        select "id", to_char("delete_after", 'YYYY-MM-DD') as "delete_after", "deleted_at" is not null as "deleted"
        from "saas_client_file" where "id" in (${FILE_MAIL}::uuid, ${FILE_MAIL_GONE}::uuid) order by "id"`),
    )
    expect(files).toEqual([
      { id: FILE_MAIL, delete_after: null, deleted: false },
      { id: FILE_MAIL_GONE, delete_after: "2026-10-15", deleted: true },
    ])
    const lifted = rows<{
      organization_id: string
      entity_id: string
      actor_role: string
      metadata: unknown
    }>(
      await ownerDb.execute(sql`
        select "organization_id", "entity_id", "actor_role", "metadata"
        from "admin_audit" where "action" = 'client_file.retention_lifted'`),
    )
    expect(lifted).toEqual([
      {
        organization_id: ORG,
        entity_id: FILE_MAIL,
        actor_role: "system",
        metadata: { clientId: CLIENT, deleteAfter: "2026-12-01" },
      },
    ])
  })

  it("la carga queda marcada cuando se subió y se borra a los 30 días de llegar", async () => {
    const carga = await one<{ carga_at: string; delete_after: string }>(sql`
      select ${iso('"carga_at"')} as "carga_at", to_char("delete_after", 'YYYY-MM-DD') as "delete_after"
      from "saas_client_file" where "id" = ${FILE_CARGA}::uuid`)
    expect(carga).toEqual({ carga_at: "2026-11-02T15:00:00Z", delete_after: "2026-12-02" })
    const unmarked = await one<{ n: number }>(sql`
      select count(*)::int as "n" from "saas_client_file" where "kind" <> 'archivo_clinica' and "carga_at" is not null`)
    expect(unmarked.n).toBe(0)
  })

  it("las tareas de cobro y las de Kairós solo de Administración quedan solo de Administración", async () => {
    const tasks = rows<{ id: string; admin_only: boolean }>(
      await ownerDb.execute(sql`select "id", "admin_only" from "saas_task" order by "id"`),
    )
    expect(tasks).toEqual([
      { id: TASK_CHARGE, admin_only: true },
      { id: TASK_KAIROS, admin_only: true },
      { id: TASK_PLAIN, admin_only: false },
    ])
  })

  it("cada paso del alta guarda la primera vez que pasó, de los mismos hechos que la ficha", async () => {
    const milestones = rows<{ step: string; reached_at: string; source: string }>(
      await ownerDb.execute(sql`
        select "step", ${iso('"reached_at"')} as "reached_at", "source"
        from "saas_client_milestone" where "client_id" = ${CLIENT}::uuid order by "reached_at", "step"`),
    )
    expect(milestones).toEqual([
      { step: "entro", reached_at: "2026-10-02T12:00:00Z", source: "hecho" },
      { step: "primer_uso", reached_at: "2026-10-02T13:00:00Z", source: "hecho" },
      // Una versión vieja del contrato también cuenta: un cambio de versión no reabre el alta.
      { step: "contrato", reached_at: "2026-10-03T12:00:00Z", source: "hecho" },
      // La carta ya se borró, pero se guardó.
      { step: "carta", reached_at: "2026-10-05T12:00:00Z", source: "hecho" },
      // Solo la carga cuenta, no el correo a soporte@ del 1 nov.
      { step: "archivos", reached_at: "2026-11-02T15:00:00Z", source: "hecho" },
      { step: "configuracion", reached_at: "2026-11-03T12:00:00Z", source: "hecho" },
      { step: "pacientes", reached_at: "2026-11-04T12:00:00Z", source: "hecho" },
      // A la hora del correo aparte, no a la del registro.
      { step: "informe", reached_at: "2026-11-05T09:00:00Z", source: "hecho" },
      { step: "primer_pago", reached_at: "2026-11-07T12:00:00Z", source: "hecho" },
      { step: "whatsapp", reached_at: "2026-11-08T12:00:00Z", source: "hecho" },
    ])
  })

  it("el pago revertido no deja hito; la demo y el archivado no tienen hitos", async () => {
    const reverted = rows<{ step: string }>(
      await ownerDb.execute(sql`
        select "step" from "saas_client_milestone" where "client_id" = ${CLIENT_REVERTED}::uuid order by "step"`),
    )
    expect(reverted).toEqual([{ step: "entro" }])
    const others = await one<{ n: number }>(sql`
      select count(*)::int as "n" from "saas_client_milestone"
      where "client_id" in (${CLIENT_DEMO}::uuid, ${CLIENT_ARCHIVED}::uuid)`)
    expect(others.n).toBe(0)
  })

  it("la tabla nueva no se abre al rol de la aplicación", async () => {
    const reach = await one<{ alcanza: boolean }>(sql`
      select has_table_privilege(${APP_ROLE}, 'admin.saas_client_milestone',
        'select, insert, update, delete, truncate, references, trigger') as "alcanza"`)
    expect(reach.alcanza).toBe(false)
  })
})

describe("la primera vez no se mueve", () => {
  it("no se adelanta ni se atrasa, ni cambia de dónde salió", async () => {
    await expect(
      ownerDb.execute(sql`
        update "saas_client_milestone" set "reached_at" = "reached_at" - interval '1 day'
        where "client_id" = ${CLIENT}::uuid and "step" = 'entro'`),
    ).rejects.toMatchObject(violates("saas_client_milestone_guard"))
    await expect(
      ownerDb.execute(sql`
        update "saas_client_milestone" set "step" = 'equipo'
        where "client_id" = ${CLIENT}::uuid and "step" = 'entro'`),
    ).rejects.toMatchObject(violates("saas_client_milestone_guard"))
  })

  it("solo vuelve a faltar cuando se pierde, y perdido toma la fecha nueva", async () => {
    await expect(
      ownerDb.execute(sql`
        update "saas_client_milestone" set "reached_at" = null, "source" = null
        where "client_id" = ${CLIENT}::uuid and "step" = 'primer_pago'`),
    ).rejects.toMatchObject(violates("saas_client_milestone_guard"))
    await ownerDb.execute(sql`
      update "saas_client_milestone" set "reached_at" = null, "lost_at" = now(), "lost_reason" = 'pago_revertido'
      where "client_id" = ${CLIENT}::uuid and "step" = 'primer_pago'`)
    // Con la fecha nueva, lo perdido se limpia.
    await expect(
      ownerDb.execute(sql`
        update "saas_client_milestone" set "reached_at" = '2026-11-12T12:00:00Z'
        where "client_id" = ${CLIENT}::uuid and "step" = 'primer_pago'`),
    ).rejects.toMatchObject(violates("saas_client_milestone_lost_check"))
    await ownerDb.execute(sql`
      update "saas_client_milestone" set "reached_at" = '2026-11-12T12:00:00Z', "lost_at" = null, "lost_reason" = null
      where "client_id" = ${CLIENT}::uuid and "step" = 'primer_pago'`)
    const paid = await one<{ reached_at: string }>(sql`
      select ${iso('"reached_at"')} as "reached_at" from "saas_client_milestone"
      where "client_id" = ${CLIENT}::uuid and "step" = 'primer_pago'`)
    expect(paid.reached_at).toBe("2026-11-12T12:00:00Z")
  })

  it("«No aplica» lleva su motivo y solo en equipo, WhatsApp y pacientes; lo perdido, solo en su paso; nunca una fila vacía", async () => {
    await expect(
      ownerDb.execute(sql`
        insert into "saas_client_milestone" ("client_id", "step", "na_reason", "na_by", "na_at")
        values (${CLIENT_REVERTED}::uuid, 'carta', 'No la quiere', ${ADA}, now())`),
    ).rejects.toMatchObject(violates("saas_client_milestone_na_check"))
    await ownerDb.execute(sql`
      insert into "saas_client_milestone" ("client_id", "step", "na_reason", "na_by", "na_at")
      values (${CLIENT_REVERTED}::uuid, 'equipo', 'Trabaja sola', ${ADA}, now())`)
    await expect(
      ownerDb.execute(sql`
        insert into "saas_client_milestone" ("client_id", "step", "lost_at", "lost_reason")
        values (${CLIENT_REVERTED}::uuid, 'contrato', now(), 'pago_revertido')`),
    ).rejects.toMatchObject(violates("saas_client_milestone_lost_check"))
    await expect(
      ownerDb.execute(sql`
        insert into "saas_client_milestone" ("client_id", "step") values (${CLIENT_REVERTED}::uuid, 'informe')`),
    ).rejects.toMatchObject(violates("saas_client_milestone_nonempty_check"))
  })
})

describe("la carga marcada", () => {
  it("no vuelve a ser un correo ni alarga su plazo; sí cambia de cliente y adelanta su borrado", async () => {
    await expect(
      ownerDb.execute(
        sql`update "saas_client_file" set "kind" = 'correo' where "id" = ${FILE_CARGA}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_client_file_carga_guard"))
    await expect(
      ownerDb.execute(
        sql`update "saas_client_file" set "delete_after" = '2027-01-30' where "id" = ${FILE_CARGA}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_client_file_carga_guard"))
    await expect(
      ownerDb.execute(
        sql`update "saas_client_file" set "delete_after" = null where "id" = ${FILE_CARGA}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_client_file_carga_guard"))
    await ownerDb.execute(
      sql`update "saas_client_file" set "delete_after" = '2026-11-30', "client_id" = ${CLIENT_REVERTED}::uuid
        where "id" = ${FILE_CARGA}::uuid`,
    )
  })

  it("un correo se marca como la carga sin volver a subirse; la marca es solo de la carga", async () => {
    await expect(
      ownerDb.execute(
        sql`update "saas_client_file" set "carga_at" = now() where "id" = ${FILE_LETTER}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_client_file_carga_check"))
    await expect(
      ownerDb.execute(
        sql`update "saas_client_file" set "kind" = 'archivo_clinica', "carga_at" = now() where "id" = ${FILE_MAIL}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_client_file_carga_check"))
    await ownerDb.execute(sql`
      update "saas_client_file" set "kind" = 'archivo_clinica', "carga_at" = now(), "delete_after" = '2026-12-01'
      where "id" = ${FILE_MAIL}::uuid`)
  })
})
