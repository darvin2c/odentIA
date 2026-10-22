// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver rls.test.ts).
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createAppDb, createOwnerDb, type Db } from "./client.js"
import { withOrgContext } from "./context.js"

const IMAGE = "dentalagent-postgres:18.6"
const APP_ROLE = "dentalagent_app"
const APP_PASSWORD = "dentalagent_app"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

const ORG_A = "org_agenda_a"
const ORG_B = "org_agenda_b"
const BRANCH_A = "11111111-1111-4111-8111-111111111111"
const BRANCH_B = "22222222-2222-4222-8222-222222222222"
const PATIENT_A = "33333333-3333-4333-8333-333333333333"
const PATIENT_B = "44444444-4444-4444-8444-444444444444"
const ROOM_A = "55555555-5555-4555-8555-555555555555"
const ROOM_A2 = "66666666-6666-4666-8666-666666666666"
const ROOM_B = "77777777-7777-4777-8777-777777777777"
const PROFESSIONAL_A = "agenda-professional-a"
const PROFESSIONAL_A2 = "agenda-professional-a2"
const PROFESSIONAL_B = "agenda-professional-b"

const T0 = "2026-09-25T15:00:00Z" // 10:00 Lima
const T1 = "2026-09-25T15:45:00Z"

async function insertAppointment(
  tx: Db,
  orgId: string,
  overrides: Partial<{
    branchId: string
    patientId: string
    professionalUserId: string
    roomId: string
    startsAt: string
    endsAt: string
    status: string
  }> = {},
) {
  const row = await tx.execute<{ id: string }>(sql`
    insert into "appointment"
      ("organization_id", "branch_id", "patient_id", "professional_user_id", "room_id",
       "starts_at", "ends_at", "duration_min", "status")
    values (
      ${orgId},
      ${overrides.branchId ?? BRANCH_A}::uuid,
      ${overrides.patientId ?? PATIENT_A}::uuid,
      ${overrides.professionalUserId ?? PROFESSIONAL_A},
      ${overrides.roomId ?? ROOM_A}::uuid,
      ${overrides.startsAt ?? T0}::timestamptz,
      ${overrides.endsAt ?? T1}::timestamptz,
      45,
      ${overrides.status ?? "programada"}
    )
    returning "id"`)
  return (row as unknown as { id: string }[])[0]!.id
}

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: "dentalagent",
      POSTGRES_USER: "dentalagent",
      POSTGRES_PASSWORD: "dentalagent",
      POSTGRES_APP_PASSWORD: APP_PASSWORD,
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
  const uri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(uri)
  await migrate(ownerDb, { migrationsFolder: "./drizzle" })
  appDb = createAppDb(
    `postgres://${APP_ROLE}:${APP_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  )

  await ownerDb.execute(sql`
    insert into "organization" ("id", "name", "slug", "created_at") values
      (${ORG_A}, 'Clínica Agenda A', 'agenda-a', now()),
      (${ORG_B}, 'Clínica Agenda B', 'agenda-b', now())`)
  await ownerDb.execute(sql`
    insert into "branch" ("id", "organization_id", "name") values
      (${BRANCH_A}::uuid, ${ORG_A}, 'Sede A'),
      (${BRANCH_B}::uuid, ${ORG_B}, 'Sede B')`)
  await ownerDb.execute(sql`
    insert into "user" ("id", "name", "email") values
      (${PROFESSIONAL_A}, 'Odontóloga A', 'professional-agenda-a@example.test'),
      (${PROFESSIONAL_A2}, 'Odontólogo A2', 'professional-agenda-a2@example.test'),
      (${PROFESSIONAL_B}, 'Odontólogo B', 'professional-agenda-b@example.test')`)
  // La identidad vive en la persona (ADR 0044): cada ficha apunta a la suya.
  await ownerDb.execute(sql`
    with a as (insert into "contact" ("organization_id", "display_name") values (${ORG_A}, 'Paciente Agenda A') returning id),
      b as (insert into "contact" ("organization_id", "display_name") values (${ORG_B}, 'Paciente Agenda B') returning id)
    insert into "patient" ("id", "organization_id", "person_id", "patient_number")
      select ${PATIENT_A}::uuid, ${ORG_A}, a.id, 9001 from a
      union all select ${PATIENT_B}::uuid, ${ORG_B}, b.id, 9002 from b`)
  await withOrgContext(appDb, ORG_A, async (tx) => {
    await tx.execute(sql`
      insert into "schedule_room" ("id", "organization_id", "branch_id", "name") values
        (${ROOM_A}::uuid, ${ORG_A}, ${BRANCH_A}::uuid, 'Unidad dental A1'),
        (${ROOM_A2}::uuid, ${ORG_A}, ${BRANCH_A}::uuid, 'Unidad dental A2')`)
  })
  await withOrgContext(appDb, ORG_B, (tx) =>
    tx.execute(sql`
      insert into "schedule_room" ("id", "organization_id", "branch_id", "name") values
        (${ROOM_B}::uuid, ${ORG_B}, ${BRANCH_B}::uuid, 'Unidad dental B1')`),
  )
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("rechaza el solapamiento del mismo profesional aunque cambie la unidad dental", async () => {
  await withOrgContext(appDb, ORG_A, (tx) => insertAppointment(tx, ORG_A))
  await expect(
    withOrgContext(appDb, ORG_A, (tx) =>
      insertAppointment(tx, ORG_A, {
        roomId: ROOM_A2,
        startsAt: "2026-09-25T15:30:00Z",
        endsAt: "2026-09-25T16:15:00Z",
      }),
    ),
  ).rejects.toMatchObject({ cause: { code: "23P01" } })
})

it("rechaza el solapamiento de la misma unidad dental aunque cambie el profesional", async () => {
  await expect(
    withOrgContext(appDb, ORG_A, (tx) =>
      insertAppointment(tx, ORG_A, {
        professionalUserId: PROFESSIONAL_A2,
        startsAt: "2026-09-25T15:30:00Z",
        endsAt: "2026-09-25T16:15:00Z",
      }),
    ),
  ).rejects.toMatchObject({ cause: { code: "23P01" } })
})

it("permite citas contiguas sobre el mismo recurso", async () => {
  const id = await withOrgContext(appDb, ORG_A, (tx) =>
    insertAppointment(tx, ORG_A, {
      startsAt: T1,
      endsAt: "2026-09-25T16:30:00Z",
    }),
  )
  expect(id).toBeTruthy()
})

it("cancelada y no_asistio no ocupan el recurso", async () => {
  await withOrgContext(appDb, ORG_A, async (tx) => {
    await insertAppointment(tx, ORG_A, {
      status: "cancelada",
      startsAt: "2026-09-25T17:00:00Z",
      endsAt: "2026-09-25T17:45:00Z",
    })
    await insertAppointment(tx, ORG_A, {
      status: "no_asistio",
      startsAt: "2026-09-25T17:00:00Z",
      endsAt: "2026-09-25T17:45:00Z",
    })
    // Y una activa encima de ambas: permitida.
    await insertAppointment(tx, ORG_A, {
      status: "confirmada",
      startsAt: "2026-09-25T17:00:00Z",
      endsAt: "2026-09-25T17:45:00Z",
    })
  })
})

it("RLS: la org B no ve ni toca las citas de A; owner sí las ve", async () => {
  const inB = await withOrgContext(appDb, ORG_B, (tx) =>
    tx.execute<{ total: number }>(sql`select count(*)::int as "total" from "appointment"`),
  )
  expect((inB as unknown as { total: number }[])[0]!.total).toBe(0)
  const all = await ownerDb.execute<{ total: number }>(
    sql`select count(*)::int as "total" from "appointment"`,
  )
  expect((all as unknown as { total: number }[])[0]!.total).toBeGreaterThan(0)
  await expect(
    withOrgContext(appDb, ORG_A, (tx) =>
      tx.execute(sql`delete from "appointment" where true`),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
})
