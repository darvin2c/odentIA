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

// El correo de la administración (0109 y 0110): la dirección de cada persona del equipo, el
// remitente y el hilo de cada envío, y a quién le llegó cada correo. La base se migra hasta antes
// de las reglas con el equipo de hoy, para ver que cada persona recibe su dirección; después, el resto.

const IMAGE = "dentalagent-postgres:18.6"
const FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle")

let container: StartedTestContainer
let ownerDb: Db
let before: string

function migrationsBefore(suffix: string): string {
  const journal = JSON.parse(readFileSync(join(FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[]
  }
  const position = journal.entries.findIndex((entry) => entry.tag.endsWith(suffix))
  if (position < 0) throw new Error(`falta la migración «${suffix}» en el journal`)
  const entries = journal.entries.slice(0, position)
  const dir = mkdtempSync(join(tmpdir(), "odentia-correo-"))
  mkdirSync(join(dir, "meta"))
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }))
  for (const entry of entries)
    cpSync(join(FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  return dir
}

function violates(constraint: string, code = "23514") {
  return { cause: { code, constraint_name: constraint } }
}

async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  const [row] = (await ownerDb.execute(query)) as unknown as T[]
  if (row === undefined) throw new Error("La consulta no devolvió ninguna fila")
  return row
}

async function user(id: string, name: string, email: string) {
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values (${id}, ${name}, ${email})`,
  )
}

async function staff(id: string, at: string) {
  await ownerDb.execute(
    sql`insert into "admin_staff" ("user_id", "role", "created_at") values (${id}, 'admin', ${at}::timestamptz)`,
  )
}

async function mailLocalOf(id: string): Promise<string | null> {
  const row = await one<{ mail_local: string | null }>(
    sql`select "mail_local" from "admin_staff" where "user_id" = ${id}`,
  )
  return row.mail_local
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
  before = migrationsBefore("_correo_reglas")
  await migrate(ownerDb, { migrationsFolder: before })

  // El equipo de hoy: uno con correo nuestro, una con Gmail, dos que se llaman igual y una que se
  // llama como un buzón.
  await user("u-darvin", "Darvin Cotrina", "Darvin.Cotrina@odentia32.com")
  await user("u-ada", "Ada Lovelace", "ada.l@gmail.com")
  await user("u-ana1", "Ana María Pérez López", "ana1@example.test")
  await user("u-ana2", "Ana María Pérez López", "ana2@example.test")
  await user("u-hola", "Hola", "equipo@example.test")
  await staff("u-darvin", "2026-10-01T10:00:00Z")
  await staff("u-ada", "2026-10-02T10:00:00Z")
  await staff("u-ana1", "2026-10-03T10:00:00Z")
  await staff("u-ana2", "2026-10-04T10:00:00Z")
  await staff("u-hola", "2026-10-05T10:00:00Z")

  await migrate(ownerDb, { migrationsFolder: FOLDER })
})

afterAll(async () => {
  await container?.stop()
  if (before) rmSync(before, { recursive: true, force: true })
})

describe("la dirección de cada persona del equipo", () => {
  it("al desplegar, cada persona de hoy recibe la suya: su parte local si es nuestra, si no su nombre", async () => {
    expect(await mailLocalOf("u-darvin")).toBe("darvin.cotrina")
    expect(await mailLocalOf("u-ada")).toBe("ada.lovelace")
    // Primer nombre y primer apellido; la segunda que choca lleva un número, en el orden en que entraron.
    expect(await mailLocalOf("u-ana1")).toBe("ana.perez")
    expect(await mailLocalOf("u-ana2")).toBe("ana.perez2")
    // Nunca un buzón reservado.
    expect(await mailLocalOf("u-hola")).toBe("hola2")
  })

  it("una persona nueva la recibe sola, sin tildes ni signos", async () => {
    await user("u-jose", "José Ñúñez O'Brien", "jose@example.test")
    await staff("u-jose", "2026-11-01T10:00:00Z")
    expect(await mailLocalOf("u-jose")).toBe("jose.nunez")
    await user("u-sin", "", "Sin.Nombre+algo@example.test")
    await staff("u-sin", "2026-11-01T11:00:00Z")
    expect(await mailLocalOf("u-sin")).toBe("sin.nombre")
  })

  it("no acepta reservados, signos ni duplicados", async () => {
    for (const value of [
      "soporte",
      "no-reply",
      "Mayus",
      "a",
      "dos..puntos",
      ".punto",
      "con espacio",
    ])
      await expect(
        ownerDb.execute(
          sql`update "admin_staff" set "mail_local" = ${value} where "user_id" = 'u-jose'`,
        ),
      ).rejects.toMatchObject(violates("admin_staff_mail_local_check"))
    await expect(
      ownerDb.execute(
        sql`update "admin_staff" set "mail_local" = 'ada.lovelace' where "user_id" = 'u-jose'`,
      ),
    ).rejects.toMatchObject(violates("admin_staff_mail_local_uidx", "23505"))
    await expect(
      ownerDb.execute(
        sql`update "admin_staff" set "mail_copy_to" = 'Otro@Gmail.com' where "user_id" = 'u-jose'`,
      ),
    ).rejects.toMatchObject(violates("admin_staff_mail_copy_check"))
    await ownerDb.execute(
      sql`update "admin_staff" set "mail_local" = 'jose', "mail_copy_to" = 'jose@gmail.com' where "user_id" = 'u-jose'`,
    )
    expect(await mailLocalOf("u-jose")).toBe("jose")
  })

  it("después del primer correo queda fija, y la fecha del primero no cambia", async () => {
    await ownerDb.execute(
      sql`update "admin_staff" set "mail_first_sent_at" = now() where "user_id" = 'u-ada'`,
    )
    for (const change of [
      sql`"mail_local" = 'ada'`,
      sql`"mail_first_sent_at" = null`,
      sql`"mail_first_sent_at" = now() + interval '1 day'`,
    ])
      await expect(
        ownerDb.execute(sql`update "admin_staff" set ${change} where "user_id" = 'u-ada'`),
      ).rejects.toMatchObject(violates("admin_staff_mail_fixed"))
    // Lo demás de la persona sigue cambiando.
    await ownerDb.execute(
      sql`update "admin_staff" set "role" = 'support', "mail_copy_to" = 'ada@gmail.com' where "user_id" = 'u-ada'`,
    )
  })
})

describe("correos y respuestas", () => {
  async function newClient(): Promise<string> {
    const row = await one<{ id: string }>(
      sql`insert into "saas_client" ("name", "product") values ('Clínica del hilo', 'dental') returning "id"`,
    )
    return row.id
  }

  async function newEmail(mailbox: string, staffUserId: string | null = null): Promise<string> {
    const row = await one<{ id: string }>(sql`
      insert into "saas_inbound_email" ("mailbox", "product", "message_id", "from_address", "to_address", "received_at", "staff_user_id")
      values (${mailbox}, 'dental', ${`<${crypto.randomUUID()}@gmail.com>`}, 'dra@gmail.com', 'hola@odentia32.com', now(), ${staffUserId})
      returning "id"`)
    return row.id
  }

  it("llega a hola@, fundadores@ o a una persona; solo el de una persona dice a quién", async () => {
    await newEmail("hola")
    await newEmail("fundadores")
    await newEmail("persona", "u-darvin")
    await expect(newEmail("contacto", "u-darvin")).rejects.toMatchObject(
      violates("saas_inbound_email_staff_check"),
    )
    await expect(newEmail("ventas")).rejects.toMatchObject(
      violates("saas_inbound_email_mailbox_check"),
    )
  })

  it("una respuesta sale sin cliente solo si responde un correo; después solo se le pone uno", async () => {
    const emailId = await newEmail("contacto")
    await expect(
      ownerDb.execute(sql`
        insert into "saas_outreach" ("channel", "to_address", "subject", "body")
        values ('correo', 'dra@gmail.com', 'Hola', 'Gracias')`),
    ).rejects.toMatchObject(violates("saas_outreach_client_check"))
    const reply = await one<{ id: string }>(sql`
      insert into "saas_outreach" ("channel", "to_address", "subject", "body", "in_reply_to_email_id", "from_address", "message_id", "references")
      values ('correo', 'dra@gmail.com', 'Re: Hola', 'Gracias', ${emailId}::uuid, 'darvin.cotrina@odentia32.com', '<r1@odentia32.com>', '<a@gmail.com>')
      returning "id"`)
    // El Message-ID es único.
    await expect(
      ownerDb.execute(sql`
        insert into "saas_outreach" ("channel", "to_address", "subject", "body", "in_reply_to_email_id", "message_id")
        values ('correo', 'dra@gmail.com', 'Re: Hola', 'Otra', ${emailId}::uuid, '<r1@odentia32.com>')`),
    ).rejects.toMatchObject(violates("saas_outreach_message_uidx", "23505"))
    // Remitente, Message-ID, hilo y correo que responde no cambian.
    for (const change of [
      sql`"from_address" = 'hola@odentia32.com'`,
      sql`"message_id" = '<otro@odentia32.com>'`,
      sql`"references" = null`,
      sql`"in_reply_to_email_id" = null`,
    ])
      await expect(
        ownerDb.execute(sql`update "saas_outreach" set ${change} where "id" = ${reply.id}::uuid`),
      ).rejects.toMatchObject({ cause: { code: "23514" } })
    const clientId = await newClient()
    await ownerDb.execute(
      sql`update "saas_outreach" set "client_id" = ${clientId}::uuid where "id" = ${reply.id}::uuid`,
    )
    await expect(
      ownerDb.execute(
        sql`update "saas_outreach" set "client_id" = null where "id" = ${reply.id}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_outreach_immutable"))
  })

  it("Kairós puede preparar la respuesta de un correo", async () => {
    await ownerDb.execute(sql`
      insert into "kairos_item" ("kind", "title", "reason", "payload", "idempotency_key", "expires_at")
      values ('responder_correo', 'Responder a Dra.', 'Le escribió a hola@', '{}'::jsonb, 'responder:1', now() + interval '48 hours')`)
  })
})
