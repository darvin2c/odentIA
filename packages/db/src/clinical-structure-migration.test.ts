process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { readdir, readFile } from "node:fs/promises"
import { sql } from "drizzle-orm"
import { GenericContainer, Wait } from "testcontainers"
import { expect, it } from "vitest"
import { createOwnerDb } from "./client.js"

const ORG = "legacy"
const PATIENT = "aaaaaaaa-1111-4111-8111-111111111111"
const DRAFT = "aaaaaaaa-2222-4222-8222-222222222222"
const FINAL = "aaaaaaaa-3333-4333-8333-333333333333"

it("normaliza valores heredados y deja inmutable la atención finalizada", async () => {
  const container = await new GenericContainer("dentalagent-postgres:18.6")
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
    for (const file of files.filter((f) => Number(f.slice(0, 4)) < 35)) await apply(file)
    await db.execute(
      sql`insert into organization (id,name,slug,created_at) values (${ORG},'Legado','legacy',now())`,
    )
    await db.execute(
      sql`insert into "user" (id,name,email) values ('u-legacy','Clínico','legacy@example.test')`,
    )
    await db.execute(
      sql`insert into patient (id,organization_id,patient_number,display_name) values (${PATIENT},${ORG},1,'Paciente')`,
    )
    await db.execute(
      sql`insert into patient_allergy (organization_id,patient_id,substance,severity) values (${ORG},${PATIENT},'Penicilina','grave'),(${ORG},${PATIENT},'Látex','leve')`,
    )
    await db.execute(
      sql`insert into patient_condition (organization_id,patient_id,name,status) values (${ORG},${PATIENT},'Diabetes','en control')`,
    )
    await db.execute(
      sql`insert into patient_document (organization_id,patient_id,category,label,storage_key,content_type,size_bytes) values (${ORG},${PATIENT},'rx','Panorámica','k/1','image/png',10)`,
    )
    await db.execute(
      sql`insert into encounter (id,organization_id,patient_id,dentist_user_id,status,reason) values
          (${FINAL},${ORG},${PATIENT},'u-legacy','finalizada','Control')`,
    )
    await db.execute(
      sql`insert into encounter (id,organization_id,patient_id,dentist_user_id,status,reason) values
          (${DRAFT},${ORG},${PATIENT},'u-legacy','borrador','Dolor')`,
    )
    await apply("0035_clinical_structure.sql")

    // No se pierde la alerta: lo no reconocido queda como desconocido o vigente.
    expect(
      await db.execute(sql`select substance, severity, category from patient_allergy order by substance`),
    ).toEqual([
      { substance: "Látex", severity: "leve", category: null },
      { substance: "Penicilina", severity: "desconocida", category: null },
    ])
    expect(await db.execute(sql`select status, cie10_code from patient_condition`)).toEqual([
      { status: "activa", cie10_code: null },
    ])
    expect(await db.execute(sql`select category from patient_document`)).toEqual([{ category: "otro" }])

    // El borrador se sigue editando; la atención finalizada, no.
    await db.execute(sql`update encounter set evolution = 'En curso' where id = ${DRAFT}`)
    await expect(
      db.execute(sql`update encounter set evolution = 'Reescrita' where id = ${FINAL}`),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining("no se modifica") } })
    // Finalizar es la última escritura permitida.
    await db.execute(sql`update encounter set status = 'finalizada', finalized_at = now() where id = ${DRAFT}`)
    await expect(
      db.execute(sql`update encounter set reason = 'Otro' where id = ${DRAFT}`),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining("no se modifica") } })

    // El catálogo queda garantizado para escrituras nuevas.
    await expect(
      db.execute(
        sql`insert into patient_allergy (organization_id,patient_id,substance,severity) values (${ORG},${PATIENT},'Otra','grave')`,
      ),
    ).rejects.toThrow()
    await expect(
      db.execute(
        sql`insert into clinical_note (organization_id,patient_id,author_user_id,note,diagnosis_type) values (${ORG},${PATIENT},'u-legacy','Sin código','definitivo')`,
      ),
    ).rejects.toThrow()
  } finally {
    await container.stop()
  }
}, 240_000)
