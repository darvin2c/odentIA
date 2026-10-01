process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { readdir, readFile } from "node:fs/promises"
import { sql } from "drizzle-orm"
import { GenericContainer, Wait } from "testcontainers"
import { expect, it } from "vitest"
import { createOwnerDb } from "./client.js"

it("conserva fechas históricas sin inventar reservas ni reabrir controles cerrados", async () => {
  const container = await new GenericContainer("dentalagent-postgres:18.6")
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
  try {
    const db = createOwnerDb(
      `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
    )
    const files = (await readdir("drizzle")).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
    const apply = async (file: string) => {
      for (const statement of (await readFile(`drizzle/${file}`, "utf8")).split(
        "--> statement-breakpoint",
      )) {
        if (statement.trim()) await db.execute(sql.raw(statement))
      }
    }
    for (const file of files.filter((f) => Number(f.slice(0, 4)) < 31)) await apply(file)
    await db.execute(
      sql`insert into organization (id,name,slug,created_at) values ('legacy','Legado','legacy',now())`,
    )
    await db.execute(
      sql`insert into patient (id,organization_id,patient_number,display_name) values ('aaaaaaaa-1111-4111-8111-111111111111','legacy',1,'Paciente')`,
    )
    for (const status of ["programado", "realizado", "cancelado"]) {
      await db.execute(
        sql`insert into clinical_follow_up (organization_id,patient_id,kind,title,due_at,status,scheduled_at) values ('legacy','aaaaaaaa-1111-4111-8111-111111111111','mantenimiento',${status},'2020-01-02T15:00:00Z',${status},'2020-01-02T15:00:00Z')`,
      )
    }
    await apply("0031_follow_up_appointments.sql")
    const rows = await db.execute(
      sql`select title,status,appointment_id,legacy_scheduled_at::text as legacy from clinical_follow_up order by title`,
    )
    expect(
      rows.map((r) => ({
        title: r.title,
        status: r.status,
        appointmentId: r.appointment_id,
        legacy: r.legacy,
      })),
    ).toEqual([
      {
        title: "cancelado",
        status: "cancelado",
        appointmentId: null,
        legacy: "2020-01-02 15:00:00+00",
      },
      {
        title: "programado",
        status: "pendiente",
        appointmentId: null,
        legacy: "2020-01-02 15:00:00+00",
      },
      {
        title: "realizado",
        status: "realizado",
        appointmentId: null,
        legacy: "2020-01-02 15:00:00+00",
      },
    ])
  } finally {
    await container.stop()
  }
}, 180_000)
