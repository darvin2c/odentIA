process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { readdir, readFile } from "node:fs/promises"
import { sql } from "drizzle-orm"
import { GenericContainer, Wait } from "testcontainers"
import { expect, it } from "vitest"
import { createAppDb, createOwnerDb } from "./client.js"
import { withOrgContext } from "./context.js"

const ORG = "ciclo"
const OTHER = "ajena"
const PATIENT = "cccccccc-1111-4111-8111-111111111111"
const OTHER_PATIENT = "cccccccc-9999-4999-8999-999999999999"
const FINAL = "cccccccc-2222-4222-8222-222222222222"
const DRAFT = "cccccccc-3333-4333-8333-333333333333"
const NOTE = "cccccccc-4444-4444-8444-444444444444"
const QUICK_NOTE = "cccccccc-5555-4555-8555-555555555555"

it("migra diagnósticos, conserva horas y protege la atención cerrada o anulada", async () => {
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
    const host = `${container.getHost()}:${container.getMappedPort(5432)}`
    const db = createOwnerDb(`postgres://dentalagent:dentalagent@${host}/dentalagent`)
    const files = (await readdir("drizzle")).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
    const apply = async (file: string) => {
      for (const statement of (await readFile(`drizzle/${file}`, "utf8")).split(
        "--> statement-breakpoint",
      )) {
        if (statement.trim()) await db.execute(sql.raw(statement))
      }
    }
    for (const file of files.filter((f) => Number(f.slice(0, 4)) < 36)) await apply(file)
    await db.execute(
      sql`insert into cie10_code (code, description) values ('K02.1','Caries de la dentina'),('K05.1','Gingivitis crónica') on conflict do nothing`,
    )
    for (const [id, slug] of [
      [ORG, "ciclo"],
      [OTHER, "ajena"],
    ]) {
      await db.execute(
        sql`insert into organization (id,name,slug,created_at) values (${id},${slug},${slug},now())`,
      )
    }
    await db.execute(
      sql`insert into "user" (id,name,email) values ('u-ciclo','Dra. Ciclo','ciclo@example.test')`,
    )
    await db.execute(
      sql`insert into patient (id,organization_id,patient_number,display_name) values (${PATIENT},${ORG},1,'Paciente'),(${OTHER_PATIENT},${OTHER},1,'Ajena')`,
    )
    await db.execute(
      sql`insert into encounter (id,organization_id,patient_id,dentist_user_id,status,reason,created_at,finalized_at,finalized_by) values
          (${FINAL},${ORG},${PATIENT},'u-ciclo','finalizada','Control','2026-01-10T15:00:00Z','2026-01-10T15:40:00Z','u-ciclo')`,
    )
    await db.execute(
      sql`insert into encounter (id,organization_id,patient_id,dentist_user_id,status,reason,created_at) values
          (${DRAFT},${ORG},${PATIENT},'u-ciclo','borrador','Dolor','2026-02-01T10:00:00Z')`,
    )
    await db.execute(
      sql`insert into clinical_note (id,organization_id,patient_id,author_user_id,note,diagnosis_code,diagnosis_type,tooth_number,encounter_id,kind) values
          (${NOTE},${ORG},${PATIENT},'u-ciclo','Dx: caries','K02.1','definitivo',36,${FINAL},'evolucion'),
          (${QUICK_NOTE},${ORG},${PATIENT},'u-ciclo','Gingivitis','K05.1',null,null,null,'evolucion')`,
    )
    await apply("0036_encounter_lifecycle.sql")

    // Las horas históricas salen de la apertura y el cierre reales.
    expect(
      await db.execute(
        sql`select id, started_at = created_at as started, ended_at = finalized_at as ended, ended_at is null as open from encounter order by id`,
      ),
    ).toEqual([
      { id: FINAL, started: true, ended: true, open: false },
      { id: DRAFT, started: true, ended: null, open: true },
    ])
    // Cada nota con código pasa a ser un diagnóstico; la nota sigue intacta.
    expect(
      await db.execute(
        sql`select cie10_code, diagnosis_type, tooth_number, encounter_id, legacy_note_id from encounter_diagnosis order by cie10_code`,
      ),
    ).toEqual([
      {
        cie10_code: "K02.1",
        diagnosis_type: "definitivo",
        tooth_number: 36,
        encounter_id: FINAL,
        legacy_note_id: NOTE,
      },
      {
        cie10_code: "K05.1",
        diagnosis_type: null,
        tooth_number: null,
        encounter_id: null,
        legacy_note_id: QUICK_NOTE,
      },
    ])
    expect(await db.execute(sql`select count(*)::int as n from clinical_note`)).toEqual([{ n: 2 }])

    // Cerrar exige la firma con colegiatura.
    await expect(
      db.execute(
        sql`update encounter set status='finalizada', finalized_at=now() where id=${DRAFT}`,
      ),
    ).rejects.toThrow()
    // Un diagnóstico nuevo solo entra a un borrador, y solo se anula allí.
    await expect(
      db.execute(
        sql`insert into encounter_diagnosis (organization_id,patient_id,encounter_id,cie10_code,diagnosis_type) values (${ORG},${PATIENT},${FINAL},'K02.1','definitivo')`,
      ),
    ).rejects.toThrow()
    await db.execute(
      sql`insert into encounter_diagnosis (organization_id,patient_id,encounter_id,cie10_code,diagnosis_type) values (${ORG},${PATIENT},${DRAFT},'K05.1','presuntivo')`,
    )
    await expect(
      db.execute(
        sql`update encounter_diagnosis set cie10_code='K02.1' where encounter_id=${DRAFT}`,
      ),
    ).rejects.toThrow()
    // El estado clínico de un diagnóstico cerrado sigue al paciente.
    await db.execute(
      sql`update encounter_diagnosis set status='resuelto', resolved_at=now() where legacy_note_id=${NOTE}`,
    )
    await expect(
      db.execute(
        sql`update encounter_diagnosis set voided_at=now(), void_reason='Error' where legacy_note_id=${NOTE}`,
      ),
    ).rejects.toThrow()

    // Anular el borrador lo deja inmutable, con motivo obligatorio.
    await expect(
      db.execute(sql`update encounter set status='anulada' where id=${DRAFT}`),
    ).rejects.toThrow()
    await db.execute(
      sql`update encounter set status='anulada', voided_at=now(), voided_by='u-ciclo', void_reason='Paciente equivocado' where id=${DRAFT}`,
    )
    await expect(
      db.execute(sql`update encounter set reason='Otro' where id=${DRAFT}`),
    ).rejects.toThrow()
    await expect(
      db.execute(sql`update encounter set evolution='Otro' where id=${FINAL}`),
    ).rejects.toThrow()

    // Una cita inexistente o de otra organización no puede motivar una atención.
    await expect(
      db.execute(
        sql`insert into encounter (organization_id,patient_id,dentist_user_id,status,reason,appointment_id) values (${ORG},${PATIENT},'u-ciclo','borrador','X','eeeeeeee-1111-4111-8111-111111111111')`,
      ),
    ).rejects.toThrow()

    // El rol de aplicación ve solo su organización y no borra diagnósticos.
    const app = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}/dentalagent`)
    const visible = await withOrgContext(app, OTHER, (tx) =>
      tx.execute(sql`select count(*)::int as n from encounter_diagnosis`),
    )
    expect(visible).toEqual([{ n: 0 }])
    await expect(
      withOrgContext(app, ORG, (tx) => tx.execute(sql`delete from encounter_diagnosis`)),
    ).rejects.toThrow()
  } finally {
    await container.stop()
  }
}, 180_000)
