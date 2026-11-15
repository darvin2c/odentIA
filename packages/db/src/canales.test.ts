// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver rls.test.ts).
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createOwnerDb, type Db } from "./client.js"

// El WhatsApp de la administración (0123 y 0124): la conversación y lo que entra, el envío que
// sale en una conversación (sin cliente, con su `wamid` anotado una vez) y la actividad que no
// cambia de conversación. Sin GRANT al rol de la aplicación, como el resto del ARM.

const IMAGE = "dentalagent-postgres:18.6"
const FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle")

let container: StartedTestContainer
let ownerDb: Db

const CLIENT = "c1000000-0000-4000-8000-000000000001"
const CHAT = "d1000000-0000-4000-8000-000000000001"
const CHAT_B = "d1000000-0000-4000-8000-000000000002"
const OUTREACH = "e1000000-0000-4000-8000-000000000001"
const FOLLOW_UP = "f1000000-0000-4000-8000-000000000001"

function violates(constraint: string, code = "23514") {
  return { cause: { code, constraint_name: constraint } }
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
  await migrate(ownerDb, { migrationsFolder: FOLDER })
  await ownerDb.execute(
    sql`insert into saas_client (id, name, product) values (${CLIENT}::uuid, 'Clínica (ficticia)', 'dental')`,
  )
  await ownerDb.execute(sql`insert into saas_chat (id, address) values
    (${CHAT}::uuid, '+51987000001'), (${CHAT_B}::uuid, '+51987000002')`)
})

afterAll(async () => {
  await container?.stop()
})

describe("la conversación de WhatsApp", () => {
  it("una por número, en E.164, y sin «No es una clínica» si tiene cliente", async () => {
    await expect(
      ownerDb.execute(sql`insert into saas_chat (address) values ('+51987000001')`),
    ).rejects.toMatchObject(violates("saas_chat_address_uidx", "23505"))
    await expect(
      ownerDb.execute(sql`insert into saas_chat (address) values ('987000003')`),
    ).rejects.toMatchObject(violates("saas_chat_address_check"))
    await expect(
      ownerDb.execute(sql`insert into saas_chat (address, channel) values ('+51987000004', 'sms')`),
    ).rejects.toMatchObject(violates("saas_chat_channel_check"))
    await expect(
      ownerDb.execute(
        sql`insert into saas_chat (address, client_id, not_clinic_at) values ('+51987000005', ${CLIENT}::uuid, now())`,
      ),
    ).rejects.toMatchObject(violates("saas_chat_not_clinic_check"))
  })

  it("en Instagram y Messenger es su id de Meta, sin formato de teléfono", async () => {
    await ownerDb.execute(sql`insert into saas_chat (channel, address) values
      ('instagram', '17841400000000001'), ('messenger', '17841400000000001')`)
    await expect(
      ownerDb.execute(
        sql`insert into saas_chat (channel, address) values ('messenger', 'con espacio')`,
      ),
    ).rejects.toMatchObject(violates("saas_chat_address_check"))
    await expect(
      ownerDb.execute(
        sql`insert into saas_outreach (channel, to_address, body, client_id) values ('instagram', '178414', 'Hola', ${CLIENT}::uuid)`,
      ),
    ).rejects.toMatchObject(violates("saas_outreach_chat_check"))
    await expect(
      ownerDb.execute(sql`insert into saas_follow_up (client_id, body, kind, direction)
        values (${CLIENT}::uuid, 'Nos escribió', 'messenger', 'entro')`),
    ).resolves.toBeDefined()
  })

  it("un mensaje entra una vez por su wamid", async () => {
    await ownerDb.execute(
      sql`insert into saas_inbound_message (chat_id, external_id, received_at) values (${CHAT}::uuid, 'wamid.A', now())`,
    )
    await expect(
      ownerDb.execute(
        sql`insert into saas_inbound_message (chat_id, external_id, received_at) values (${CHAT_B}::uuid, 'wamid.A', now())`,
      ),
    ).rejects.toMatchObject(violates("saas_inbound_message_external_uidx", "23505"))
  })

  it("el rol de la aplicación no la lee", async () => {
    const [row] = (await ownerDb.execute(sql`select
      has_table_privilege('dentalagent_app', 'admin.saas_chat', 'select') as chat,
      has_table_privilege('dentalagent_app', 'admin.saas_inbound_message', 'select') as message`)) as unknown as Array<{
      chat: boolean
      message: boolean
    }>
    expect(row).toEqual({ chat: false, message: false })
  })
})

describe("lo que sale en una conversación", () => {
  it("sale sin cliente solo en una conversación, por WhatsApp, y su wamid se anota una vez", async () => {
    await expect(
      ownerDb.execute(
        sql`insert into saas_outreach (channel, to_address, body) values ('whatsapp', '+51987000001', 'Hola')`,
      ),
    ).rejects.toMatchObject(violates("saas_outreach_client_check"))
    await expect(
      ownerDb.execute(
        sql`insert into saas_outreach (channel, to_address, body, chat_id) values ('correo', 'a@b.test', 'Hola', ${CHAT}::uuid)`,
      ),
    ).rejects.toMatchObject(violates("saas_outreach_chat_check"))
    await expect(
      ownerDb.execute(
        sql`insert into saas_outreach (channel, to_address, body, client_id, template) values ('whatsapp', '+51987000001', 'Hola', ${CLIENT}::uuid, 'retomar_conversacion')`,
      ),
    ).rejects.toMatchObject(violates("saas_outreach_chat_check"))
    await ownerDb.execute(
      sql`insert into saas_outreach (id, channel, to_address, body, chat_id) values (${OUTREACH}::uuid, 'whatsapp', '+51987000001', 'Hola', ${CHAT}::uuid)`,
    )
    await ownerDb.execute(
      sql`update saas_outreach set status = 'enviado', sent_at = now(), external_id = 'wamid.S' where id = ${OUTREACH}::uuid`,
    )
    await expect(
      ownerDb.execute(
        sql`update saas_outreach set external_id = 'wamid.T' where id = ${OUTREACH}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_outreach_immutable"))
    await expect(
      ownerDb.execute(
        sql`update saas_outreach set chat_id = ${CHAT_B}::uuid where id = ${OUTREACH}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_outreach_immutable"))
    // Al ligar la conversación, el envío recibe su cliente.
    await ownerDb.execute(
      sql`update saas_outreach set client_id = ${CLIENT}::uuid where id = ${OUTREACH}::uuid`,
    )
  })

  it("«solo administración» se decide al escribirlo y solo sube: en el envío y en el mensaje", async () => {
    // El envío: de no a sí (pasa a un cliente sin app); nunca de sí a no.
    await ownerDb.execute(
      sql`update saas_outreach set admin_only = true where id = ${OUTREACH}::uuid`,
    )
    await expect(
      ownerDb.execute(
        sql`update saas_outreach set admin_only = false where id = ${OUTREACH}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_outreach_immutable"))
    // El mensaje: por omisión es de Administración; lo que lo es no deja de serlo.
    const [visible] = (await ownerDb.execute(
      sql`insert into saas_inbound_message (chat_id, external_id, received_at, admin_only)
        values (${CHAT_B}::uuid, 'wamid.visible', now(), false) returning id`,
    )) as unknown as Array<{ id: string }>
    const [hidden] = (await ownerDb.execute(
      sql`insert into saas_inbound_message (chat_id, external_id, received_at)
        values (${CHAT_B}::uuid, 'wamid.oculto', now()) returning id, admin_only`,
    )) as unknown as Array<{ id: string; admin_only: boolean }>
    expect(hidden?.admin_only).toBe(true)
    await ownerDb.execute(
      sql`update saas_inbound_message set admin_only = true where id = ${visible?.id}::uuid`,
    )
    await expect(
      ownerDb.execute(
        sql`update saas_inbound_message set admin_only = false where id = ${hidden?.id}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_inbound_message_admin_only_up"))
    // Lo demás del mensaje lo cambian los servicios (sus archivos, el texto de la carga).
    await ownerDb.execute(
      sql`update saas_inbound_message set body = null where id = ${hidden?.id}::uuid`,
    )
  })

  it("la actividad pasa a otro cliente pero no a otra conversación", async () => {
    await ownerDb.execute(sql`insert into saas_follow_up (id, client_id, body, kind, direction, chat_id)
      values (${FOLLOW_UP}::uuid, ${CLIENT}::uuid, 'Nos escribió', 'whatsapp', 'entro', ${CHAT}::uuid)`)
    await expect(
      ownerDb.execute(
        sql`update saas_follow_up set chat_id = ${CHAT_B}::uuid where id = ${FOLLOW_UP}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_follow_up_append_only"))
    const [other] = (await ownerDb.execute(
      sql`insert into saas_client (name, product) values ('Otra (ficticia)', 'dental') returning id`,
    )) as unknown as Array<{ id: string }>
    await ownerDb.execute(
      sql`update saas_follow_up set client_id = ${other?.id}::uuid where chat_id = ${CHAT}::uuid`,
    )
    // Borrar la conversación la deja sin ella (su clave foránea), sin perder la actividad.
    await ownerDb.execute(sql`delete from saas_outreach where chat_id = ${CHAT}::uuid`)
    await ownerDb.execute(sql`delete from saas_chat where id = ${CHAT}::uuid`)
    const [row] = (await ownerDb.execute(
      sql`select chat_id from saas_follow_up where id = ${FOLLOW_UP}::uuid`,
    )) as unknown as Array<{ chat_id: string | null }>
    expect(row).toEqual({ chat_id: null })
  })

  it("un archivo puede llegar por WhatsApp", async () => {
    await ownerDb.execute(sql`insert into saas_client_file (client_id, kind, filename, object_key, content_type, size_bytes, source)
      values (${CLIENT}::uuid, 'correo', 'agenda.xlsx', 'inbound/x.xlsx', 'text/csv', 1, 'whatsapp')`)
    await expect(
      ownerDb.execute(sql`insert into saas_client_file (client_id, kind, filename, object_key, content_type, size_bytes, source)
        values (${CLIENT}::uuid, 'correo', 'b.xlsx', 'inbound/y.xlsx', 'text/csv', 1, 'sms')`),
    ).rejects.toMatchObject(violates("saas_client_file_source_check"))
  })
})
