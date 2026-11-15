// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver rls.test.ts).
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createOwnerDb, type Db } from "./client.js"

// Kairós vende y agenda (0129 y 0130): el horario y las ausencias del equipo, lo general de
// Kairós en una fila, la presentación con su fin y las propuestas en una conversación. Sin GRANT
// al rol de la aplicación, como el resto del ARM.

const IMAGE = "dentalagent-postgres:18.6"
const FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle")

let container: StartedTestContainer
let ownerDb: Db

const CLIENT = "c1000000-0000-4000-8000-000000000001"
const CHAT = "d1000000-0000-4000-8000-000000000001"
const CHAT_B = "d1000000-0000-4000-8000-000000000002"

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

describe("el equipo: horario y ausencias", () => {
  it("franjas dentro del día y de inicio a fin; ausencias que terminan después de empezar", async () => {
    await ownerDb.execute(
      sql`insert into "user" (id, name, email) values ('kv-ana', 'Ana', 'ana@kv.test')`,
    )
    await ownerDb.execute(sql`insert into admin_staff (user_id, role) values ('kv-ana', 'support')`)
    await ownerDb.execute(
      sql`insert into admin_staff_hours (user_id, weekday, start_min, end_min) values ('kv-ana', 1, 540, 720)`,
    )
    for (const [weekday, start, end] of [
      [7, 540, 720],
      [1, 720, 540],
      [1, -10, 60],
      [1, 600, 1500],
    ]) {
      await expect(
        ownerDb.execute(
          sql`insert into admin_staff_hours (user_id, weekday, start_min, end_min) values ('kv-ana', ${weekday}, ${start}, ${end})`,
        ),
      ).rejects.toMatchObject(violates("admin_staff_hours_range_check"))
    }
    await expect(
      ownerDb.execute(
        sql`insert into admin_staff_absence (user_id, starts_at, ends_at) values ('kv-ana', now(), now() - interval '1 hour')`,
      ),
    ).rejects.toMatchObject(violates("admin_staff_absence_check"))
    await expect(
      ownerDb.execute(
        sql`insert into admin_staff_absence (user_id, starts_at, ends_at, reason) values ('kv-ana', now(), now() + interval '1 day', '  ')`,
      ),
    ).rejects.toMatchObject(violates("admin_staff_absence_check"))
    await expect(
      ownerDb.execute(
        sql`update admin_staff set meeting_url = 'http://sala.test/ana' where user_id = 'kv-ana'`,
      ),
    ).rejects.toMatchObject(violates("admin_staff_meeting_url_check"))
  })
})

describe("Kairós", () => {
  it("una sola fila de lo general, con «responde solo» apagado", async () => {
    const found = [
      ...(await ownerDb.execute<{ id: boolean; sells_enabled: boolean }>(
        sql`select id, sells_enabled from kairos_setting`,
      )),
    ]
    expect(found).toEqual([{ id: true, sells_enabled: false }])
    await expect(
      ownerDb.execute(sql`insert into kairos_setting (id) values (false)`),
    ).rejects.toMatchObject(violates("kairos_setting_single_check"))
  })

  it("una sola propuesta pendiente por conversación", async () => {
    await ownerDb.execute(sql`insert into kairos_proposal (chat_id, assignee_user_id, starts_at, expires_at)
      values (${CHAT}::uuid, 'kv-ana', now() + interval '1 day', now() + interval '2 days')`)
    await expect(
      ownerDb.execute(sql`insert into kairos_proposal (chat_id, assignee_user_id, starts_at, expires_at)
        values (${CHAT}::uuid, 'kv-ana', now() + interval '2 days', now() + interval '2 days')`),
    ).rejects.toMatchObject(violates("kairos_proposal_pending_uidx", "23505"))
    await ownerDb.execute(
      sql`update kairos_proposal set status = 'reemplazada' where chat_id = ${CHAT}::uuid`,
    )
    await ownerDb.execute(sql`insert into kairos_proposal (chat_id, assignee_user_id, starts_at, expires_at)
      values (${CHAT}::uuid, 'kv-ana', now() + interval '2 days', now() + interval '2 days')`)
    await expect(
      ownerDb.execute(sql`insert into kairos_proposal (chat_id, assignee_user_id, starts_at, expires_at, status)
        values (${CHAT_B}::uuid, 'kv-ana', now(), now() + interval '1 day', 'aceptada')`),
    ).rejects.toMatchObject(violates("kairos_proposal_status_check"))
  })

  it("la presentación termina después de empezar, y la pausa de Kairós lleva su fecha", async () => {
    await expect(
      ownerDb.execute(sql`insert into saas_task (client_id, kind, title, due_on, due_at, ends_at)
        values (${CLIENT}::uuid, 'presentacion', 'Presentación', current_date, now(), now() - interval '1 minute')`),
    ).rejects.toMatchObject(violates("saas_task_ends_check"))
    await expect(
      ownerDb.execute(sql`insert into saas_task (client_id, kind, title, due_on, ends_at)
        values (${CLIENT}::uuid, 'presentacion', 'Presentación', current_date, now())`),
    ).rejects.toMatchObject(violates("saas_task_ends_check"))
    await expect(
      ownerDb.execute(
        sql`update saas_chat set kairos_paused_by = 'kv-ana' where id = ${CHAT}::uuid`,
      ),
    ).rejects.toMatchObject(violates("saas_chat_kairos_paused_check"))
  })
})
