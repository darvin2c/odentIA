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

// La administración de hoy: la bitácora de seguimiento, la marca «Falta en la guía» y el
// comprobante rechazado. La base se migra primero hasta antes de la migración de reglas,
// con datos como los de producción (notas y casos atascados), para ver el traslado.

const IMAGE = "dentalagent-postgres:18.6"
const APP_ROLE = "dentalagent_app"
const FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle")

let container: StartedTestContainer
let ownerDb: Db
let before: string

const ADA = "staff-ada"
const BETO = "staff-beto"
const GONE = "staff-que-ya-no-esta"
const OWNER = "owner-andes"
const ORG = "org_andes"

const NOTED = "a0000000-0000-4000-8000-000000000001"
const UNAUDITED = "a0000000-0000-4000-8000-000000000002"
const ORPHAN_AUDIT = "a0000000-0000-4000-8000-000000000003"
const BLANK = "a0000000-0000-4000-8000-000000000004"
const NO_NOTE = "a0000000-0000-4000-8000-000000000005"

const STUCK = "c0000000-0000-4000-8000-000000000001"
const WAITING = "c0000000-0000-4000-8000-000000000002"
const INTERNAL_ONLY = "c0000000-0000-4000-8000-000000000003"
const NEVER_ANSWERED = "c0000000-0000-4000-8000-000000000004"
const RESOLVED = "c0000000-0000-4000-8000-000000000005"
const GRANTED = "c0000000-0000-4000-8000-000000000006"
const LOOSE_FILE = "c0000000-0000-4000-8000-000000000007"
const STAFF_FILE = "c0000000-0000-4000-8000-000000000008"
const OLD_GRANT = "c0000000-0000-4000-8000-000000000009"

/** Copia de las migraciones hasta antes de la de reglas: la base como estaba en producción. */
function migrationsBeforeRules(): string {
  const journal = JSON.parse(readFileSync(join(FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[]
  }
  const position = journal.entries.findIndex((entry) => entry.tag.endsWith("_administracion_hoy_reglas"))
  if (position < 0) throw new Error("falta la migración de reglas de la administración de hoy en el journal")
  const entries = journal.entries.slice(0, position)
  const dir = mkdtempSync(join(tmpdir(), "odentia-administracion-hoy-"))
  mkdirSync(join(dir, "meta"))
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }))
  for (const entry of entries) cpSync(join(FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  return dir
}

function rows<T>(result: unknown): T[] {
  return result as T[]
}

function violates(constraint: string) {
  return { cause: { code: "23514", constraint_name: constraint } }
}

async function insertRequest(id: string, note: string | null, createdAt: string) {
  await ownerDb.execute(sql`
    insert into "saas_waitlist_request"
      ("id", "first_name", "last_name", "email", "phone", "clinic_name", "country_code", "city",
       "professionals", "current_tool", "note", "created_at")
    values (${id}::uuid, 'Lucía', 'Quispe', ${`${id}@example.test`}, '+51987654321', 'Dental Andes', 'PE',
      'Lima', '2-3', 'cuaderno_excel', ${note}, ${createdAt}::timestamptz)`)
}

async function insertCase(id: string, status: string, lastPublicMessageAt: string | null) {
  await ownerDb.execute(sql`
    insert into "support_case"
      ("id", "organization_id", "question", "dedupe_key", "status", "opened_by", "last_public_message_at", "updated_at")
    values (${id}::uuid, ${ORG}, '¿Cómo cambio el horario?', ${`dedupe-${id}`}, ${status}, ${OWNER},
      ${lastPublicMessageAt}::timestamptz, '2026-11-01T12:00:00Z')`)
}

async function insertMessage(caseId: string, authorKind: string, internal: boolean, at: string) {
  await ownerDb.execute(sql`
    insert into "support_message" ("case_id", "organization_id", "author_kind", "author_user_id", "body", "is_internal", "created_at")
    values (${caseId}::uuid, ${ORG}, ${authorKind}, ${authorKind === "cliente" ? OWNER : ADA}, 'Mensaje',
      ${internal}, ${at}::timestamptz)`)
}

async function insertGrant(caseId: string, at: string) {
  await ownerDb.execute(sql`
    insert into "support_access_grant" ("case_id", "organization_id", "granted_by", "expires_at", "created_at")
    values (${caseId}::uuid, ${ORG}, ${OWNER}, ${at}::timestamptz + interval '30 minutes', ${at}::timestamptz)`)
}

/** Un adjunto suelto (sin mensaje). */
async function insertLooseAttachment(caseId: string, by: string, at: string) {
  await ownerDb.execute(sql`
    insert into "support_attachment" ("case_id", "organization_id", "object_key", "mime_type", "filename", "size", "created_by", "created_at")
    values (${caseId}::uuid, ${ORG}, ${`soporte/${caseId}/${by}.png`}, 'image/png', 'captura.png', 1200, ${by}, ${at}::timestamptz)`)
}

async function insertEntry(requestId: string, body = "Le escribí por WhatsApp") {
  const [entry] = rows<{ id: string }>(
    await ownerDb.execute(sql`
      insert into "saas_follow_up" ("request_id", "author_user_id", "body", "follow_up_on")
      values (${requestId}::uuid, ${ADA}, ${body}, '2026-11-12') returning "id"`),
  )
  return entry!.id
}

async function insertPendingPayment(id: string, status = "pendiente") {
  await ownerDb.execute(sql`
    insert into "saas_payment" ("id", "organization_id", "amount_cents", "currency", "method_code", "status", "idempotency_key", "receipt_object_key")
    values (${id}::uuid, ${ORG}, 19900, 'PEN', 'transferencia', ${status}, ${`key-${id}`}, 'comprobantes/demo.png')`)
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
    .withCommand(["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=dentalagent"])
    .start()
  ownerDb = createOwnerDb(
    `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  )
  before = migrationsBeforeRules()
  await migrate(ownerDb, { migrationsFolder: before })

  await ownerDb.execute(sql`
    insert into "user" ("id", "name", "email") values
      (${ADA}, 'Ada', 'ada@example.test'),
      (${BETO}, 'Beto', 'beto@example.test'),
      (${OWNER}, 'Lucía Quispe', 'lucia@example.test')`)
  await ownerDb.execute(sql`
    insert into "organization" ("id", "name", "slug", "created_at") values (${ORG}, 'Dental Andes', 'dental-andes', now())`)

  // Notas como las de producción: una auditada dos veces (vale la última), una sin auditoría,
  // una auditada por alguien que ya no está, una en blanco y una solicitud sin nota.
  await insertRequest(NOTED, "Llamé: quiere ver la demo el jueves", "2026-11-01T14:00:00Z")
  await insertRequest(UNAUDITED, "Nota de antes de auditar", "2026-10-20T14:00:00Z")
  await insertRequest(ORPHAN_AUDIT, "La anotó alguien que ya no está", "2026-10-25T14:00:00Z")
  await insertRequest(BLANK, "   ", "2026-11-02T14:00:00Z")
  await insertRequest(NO_NOTE, null, "2026-11-03T14:00:00Z")
  await ownerDb.execute(sql`
    insert into "admin_audit" ("actor_user_id", "action", "entity_id", "created_at") values
      (${BETO}, 'saas.waitlist_note', ${NOTED}, '2026-11-02T10:00:00Z'),
      (${ADA}, 'saas.waitlist_note', ${NOTED}, '2026-11-04T16:30:00Z'),
      (${BETO}, 'saas.waitlist_discard', ${NOTED}, '2026-11-05T09:00:00Z'),
      (${GONE}, 'saas.waitlist_note', ${ORPHAN_AUDIT}, '2026-10-26T11:00:00Z')`)

  // Casos: uno atascado (la clínica escribió después de nuestra respuesta), uno que de verdad
  // espera a la clínica, uno con solo una nota interna después, uno que nunca respondimos y
  // uno resuelto.
  await insertCase(STUCK, "esperando_clinica", "2026-11-05T15:00:00Z")
  await insertMessage(STUCK, "staff", false, "2026-11-05T15:00:00Z")
  await insertMessage(STUCK, "cliente", false, "2026-11-06T10:00:00Z")
  await insertCase(WAITING, "esperando_clinica", "2026-11-06T15:00:00Z")
  await insertMessage(WAITING, "cliente", false, "2026-11-05T10:00:00Z")
  await insertMessage(WAITING, "staff", false, "2026-11-06T15:00:00Z")
  await insertCase(INTERNAL_ONLY, "esperando_clinica", "2026-11-06T15:00:00Z")
  await insertMessage(INTERNAL_ONLY, "staff", true, "2026-11-07T09:00:00Z")
  await insertCase(NEVER_ANSWERED, "esperando_clinica", null)
  await insertMessage(NEVER_ANSWERED, "cliente", false, "2026-11-04T10:00:00Z")
  await insertCase(RESOLVED, "resuelto", "2026-11-05T15:00:00Z")
  await insertMessage(RESOLVED, "cliente", false, "2026-11-06T10:00:00Z")
  // Lo que la clínica hizo sin escribir: antes de esta entrega no movía el caso. Autorizó el
  // acceso después de nuestro pedido, o subió un archivo suelto; un archivo del equipo o un
  // acceso anterior a nuestra respuesta no cuentan.
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at")
    values ('member-owner-andes', ${ORG}, ${OWNER}, 'owner', now())`)
  await insertCase(GRANTED, "esperando_clinica", "2026-11-10T14:00:00Z")
  await insertGrant(GRANTED, "2026-11-10T14:30:00Z")
  await insertCase(LOOSE_FILE, "esperando_clinica", "2026-11-10T14:00:00Z")
  await insertLooseAttachment(LOOSE_FILE, OWNER, "2026-11-10T15:00:00Z")
  await insertCase(STAFF_FILE, "esperando_clinica", "2026-11-10T14:00:00Z")
  await insertLooseAttachment(STAFF_FILE, ADA, "2026-11-10T15:00:00Z")
  await insertCase(OLD_GRANT, "esperando_clinica", "2026-11-10T14:00:00Z")
  await insertGrant(OLD_GRANT, "2026-11-10T13:00:00Z")

  // El resto de las migraciones, como en el despliegue.
  await migrate(ownerDb, { migrationsFolder: FOLDER })
})

afterAll(async () => {
  await container?.stop()
  if (before) rmSync(before, { recursive: true, force: true })
})

describe("al desplegar", () => {
  it("la nota de cada solicitud pasa a ser su primera entrada, con autor solo si está auditada y existe", async () => {
    const entries = rows<{ request_id: string; author_user_id: string | null; body: string; follow_up_on: string | null; admin_only: boolean; created_at: string }>(
      await ownerDb.execute(sql`
        select "request_id", "author_user_id", "body", "follow_up_on", "admin_only",
          to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "created_at"
        from "saas_follow_up" order by "created_at"`),
    )
    expect(entries).toEqual([
      { request_id: UNAUDITED, author_user_id: null, body: "Nota de antes de auditar", follow_up_on: null, admin_only: false, created_at: "2026-10-20T14:00:00Z" },
      { request_id: ORPHAN_AUDIT, author_user_id: null, body: "La anotó alguien que ya no está", follow_up_on: null, admin_only: false, created_at: "2026-10-26T11:00:00Z" },
      { request_id: NOTED, author_user_id: ADA, body: "Llamé: quiere ver la demo el jueves", follow_up_on: null, admin_only: false, created_at: "2026-11-04T16:30:00Z" },
    ])
    // La columna vieja sigue: la ruta de la nota vive durante este despliegue.
    const [noted] = rows<{ note: string }>(
      await ownerDb.execute(sql`select "note" from "saas_waitlist_request" where "id" = ${NOTED}::uuid`),
    )
    expect(noted!.note).toBe("Llamé: quiere ver la demo el jueves")
  })

  it("el caso en que la clínica escribió, adjuntó o autorizó el acceso después de nuestra respuesta vuelve a «En atención»; los demás quedan igual", async () => {
    const cases = rows<{ id: string; status: string; moved: boolean }>(
      await ownerDb.execute(sql`
        select "id", "status", "updated_at" > '2026-11-01T12:00:00Z'::timestamptz as "moved"
        from "support_case" order by "id"`),
    )
    expect(cases).toEqual([
      { id: STUCK, status: "en_atencion", moved: true },
      { id: WAITING, status: "esperando_clinica", moved: false },
      { id: INTERNAL_ONLY, status: "esperando_clinica", moved: false },
      { id: NEVER_ANSWERED, status: "en_atencion", moved: true },
      { id: RESOLVED, status: "resuelto", moved: false },
      { id: GRANTED, status: "en_atencion", moved: true },
      { id: LOOSE_FILE, status: "en_atencion", moved: true },
      { id: STAFF_FILE, status: "esperando_clinica", moved: false },
      { id: OLD_GRANT, status: "esperando_clinica", moved: false },
    ])
  })

  it("las dos tablas nuevas de admin no se abren al rol de la aplicación", async () => {
    const reach = rows<{ tabla: string; alcanza: boolean }>(
      await ownerDb.execute(sql`
        select t as "tabla", has_table_privilege(${APP_ROLE}, t, 'select, insert, update, delete') as "alcanza"
        from unnest(array['admin.saas_follow_up', 'admin.support_guide_gap']) as t order by 1`),
    )
    expect(reach).toEqual([
      { tabla: "admin.saas_follow_up", alcanza: false },
      { tabla: "admin.support_guide_gap", alcanza: false },
    ])
  })
})

describe("bitácora de seguimiento", () => {
  it("una entrada no se reescribe: ni el texto ni la fecha para volver", async () => {
    const id = await insertEntry(NO_NOTE)
    await expect(
      ownerDb.execute(sql`update "saas_follow_up" set "body" = 'Otro texto' where "id" = ${id}::uuid`),
    ).rejects.toMatchObject(violates("saas_follow_up_append_only"))
    await expect(
      ownerDb.execute(sql`update "saas_follow_up" set "follow_up_on" = null where "id" = ${id}::uuid`),
    ).rejects.toMatchObject(violates("saas_follow_up_append_only"))
  })

  it("«solo administración» pasa de no a sí, pero no vuelve a no", async () => {
    const id = await insertEntry(NO_NOTE)
    await ownerDb.execute(sql`update "saas_follow_up" set "admin_only" = true where "id" = ${id}::uuid`)
    const [entry] = rows<{ admin_only: boolean }>(
      await ownerDb.execute(sql`select "admin_only" from "saas_follow_up" where "id" = ${id}::uuid`),
    )
    expect(entry!.admin_only).toBe(true)
    await expect(
      ownerDb.execute(sql`update "saas_follow_up" set "admin_only" = false where "id" = ${id}::uuid`),
    ).rejects.toMatchObject(violates("saas_follow_up_append_only"))
  })

  it("cada entrada es de una solicitud o de una clínica, nunca de las dos ni de ninguna", async () => {
    await expect(
      ownerDb.execute(sql`
        insert into "saas_follow_up" ("request_id", "organization_id", "body")
        values (${NO_NOTE}::uuid, ${ORG}, 'De las dos')`),
    ).rejects.toMatchObject(violates("saas_follow_up_subject_check"))
    await expect(
      ownerDb.execute(sql`insert into "saas_follow_up" ("body") values ('De ninguna')`),
    ).rejects.toMatchObject(violates("saas_follow_up_subject_check"))
    await expect(
      ownerDb.execute(sql`insert into "saas_follow_up" ("request_id", "body") values (${NO_NOTE}::uuid, '   ')`),
    ).rejects.toMatchObject(violates("saas_follow_up_body_check"))
  })

  it("borrar la solicitud borra sus entradas, y borrar al autor deja la entrada sin autor", async () => {
    await insertRequest("a0000000-0000-4000-8000-000000000009", null, "2026-11-08T14:00:00Z")
    await insertEntry("a0000000-0000-4000-8000-000000000009")
    await ownerDb.execute(sql`delete from "saas_waitlist_request" where "id" = 'a0000000-0000-4000-8000-000000000009'::uuid`)
    const [left] = rows<{ total: number }>(
      await ownerDb.execute(sql`
        select count(*)::int as "total" from "saas_follow_up" where "request_id" = 'a0000000-0000-4000-8000-000000000009'::uuid`),
    )
    expect(left!.total).toBe(0)

    await ownerDb.execute(sql`insert into "user" ("id", "name", "email") values ('staff-temporal', 'Temporal', 'temporal@example.test')`)
    const [entry] = rows<{ id: string }>(
      await ownerDb.execute(sql`
        insert into "saas_follow_up" ("request_id", "author_user_id", "body")
        values (${NO_NOTE}::uuid, 'staff-temporal', 'La dejó alguien que se va') returning "id"`),
    )
    await ownerDb.execute(sql`delete from "user" where "id" = 'staff-temporal'`)
    const [after] = rows<{ author_user_id: string | null; body: string }>(
      await ownerDb.execute(sql`select "author_user_id", "body" from "saas_follow_up" where "id" = ${entry!.id}::uuid`),
    )
    expect(after).toEqual({ author_user_id: null, body: "La dejó alguien que se va" })
  })
})

describe("comprobante rechazado", () => {
  it("un pendiente se rechaza con quién, cuándo y motivo, y después no cambia", async () => {
    const id = "e0000000-0000-4000-8000-000000000001"
    await insertPendingPayment(id)
    await ownerDb.execute(sql`
      update "saas_payment" set "status" = 'rechazado', "rejected_at" = now(), "rejected_by" = ${ADA},
        "reject_reason" = 'El importe no coincide con el cargo' where "id" = ${id}::uuid`)
    await expect(
      ownerDb.execute(sql`
        update "saas_payment" set "status" = 'confirmado', "confirmed_at" = now(), "confirmed_by" = ${ADA},
          "rejected_at" = null, "rejected_by" = null, "reject_reason" = null where "id" = ${id}::uuid`),
    ).rejects.toMatchObject(violates("saas_payment_rejected_final"))
    await expect(
      ownerDb.execute(sql`update "saas_payment" set "reject_reason" = 'Otro motivo' where "id" = ${id}::uuid`),
    ).rejects.toMatchObject(violates("saas_payment_rejected_final"))
  })

  it("un rechazado sin motivo no se guarda, y un motivo sin rechazo tampoco", async () => {
    await expect(
      ownerDb.execute(sql`
        insert into "saas_payment" ("organization_id", "amount_cents", "currency", "method_code", "status", "idempotency_key", "rejected_at", "rejected_by")
        values (${ORG}, 19900, 'PEN', 'transferencia', 'rechazado', 'key-sin-motivo', now(), ${ADA})`),
    ).rejects.toMatchObject(violates("saas_payment_rejection_check"))
    await expect(
      ownerDb.execute(sql`
        insert into "saas_payment" ("organization_id", "amount_cents", "currency", "method_code", "status", "idempotency_key", "reject_reason")
        values (${ORG}, 19900, 'PEN', 'transferencia', 'pendiente', 'key-motivo-suelto', 'No es un rechazo')`),
    ).rejects.toMatchObject(violates("saas_payment_rejection_check"))
  })

  it("lo confirmado no se rechaza: es dinero que entró", async () => {
    const id = "e0000000-0000-4000-8000-000000000002"
    await insertPendingPayment(id)
    await ownerDb.execute(sql`
      update "saas_payment" set "status" = 'confirmado', "confirmed_at" = now(), "confirmed_by" = ${ADA} where "id" = ${id}::uuid`)
    await expect(
      ownerDb.execute(sql`
        update "saas_payment" set "status" = 'rechazado', "rejected_at" = now(), "rejected_by" = ${ADA},
          "reject_reason" = 'Tarde' where "id" = ${id}::uuid`),
    ).rejects.toMatchObject(violates("saas_payment_reject_pending_only"))
  })
})

describe("«Falta en la guía» y el pedido de acceso", () => {
  it("una marca por caso, que se va con el caso", async () => {
    await ownerDb.execute(sql`insert into "support_guide_gap" ("case_id", "marked_by") values (${WAITING}::uuid, ${ADA})`)
    await expect(
      ownerDb.execute(sql`insert into "support_guide_gap" ("case_id", "marked_by") values (${WAITING}::uuid, ${BETO})`),
    ).rejects.toMatchObject({ cause: { code: "23505" } })
    await ownerDb.execute(sql`update "support_case" set "access_requested_at" = now() where "id" = ${WAITING}::uuid`)
    await ownerDb.execute(sql`delete from "support_case" where "id" = ${WAITING}::uuid`)
    const [left] = rows<{ total: number }>(
      await ownerDb.execute(sql`select count(*)::int as "total" from "support_guide_gap" where "case_id" = ${WAITING}::uuid`),
    )
    expect(left!.total).toBe(0)
  })
})
