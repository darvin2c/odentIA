process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { readdir, readFile } from "node:fs/promises"
import { sql } from "drizzle-orm"
import { GenericContainer, Wait } from "testcontainers"
import { expect, it } from "vitest"
import { createOwnerDb } from "./client.js"

const PE = "lista-pe"
const CO = "lista-co"
const ROSA = "eeeeeeee-1111-4111-8111-111111111111"
const LUIS = "eeeeeeee-2222-4222-8222-222222222222"
const DRAFT = "eeeeeeee-3333-4333-8333-333333333333"

it("0102 convierte lo de desarrollo: códigos con su lista, tipo FHIR, «repetido» marcado y demografía internacional", async () => {
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
    for (const file of files.filter((f) => Number(f.slice(0, 4)) < 102)) await apply(file)

    await db.execute(sql`insert into cie10_code (code, description) values
      ('K02','Caries dental'),('K02.1','Caries de la dentina'),('K05.1','Gingivitis crónica')`)
    for (const [org, country] of [
      [PE, "PE"],
      [CO, "CO"],
    ] as const) {
      await db.execute(
        sql`insert into organization (id,name,slug,created_at) values (${org},${org},${org},now())`,
      )
      await db.execute(sql`insert into org_profile (organization_id,legal_name,country_code,currency,timezone,locale)
        values (${org},${org},${country},'PEN','America/Lima','es-PE')`)
    }
    await db.execute(
      sql`insert into "user" (id,name,email) values ('u-lista','Doctora','lista@example.test')`,
    )
    await db.execute(sql`insert into patient (id,organization_id,patient_number,display_name,marital_status,education_level,emergency_contact_relationship)
      values (${ROSA},${PE},1,'Rosa','conviviente','posgrado','conyuge'),
             (${LUIS},${CO},1,'Luis','conviviente','secundaria_completa','no_familiar')`)
    await db.execute(
      sql`insert into patient_condition (organization_id,patient_id,name,cie10_code) values (${PE},${ROSA},'Gingivitis','K05.1')`,
    )
    await db.execute(sql`insert into patient_family_history (organization_id,patient_id,relationship,condition) values
      (${PE},${ROSA},'madre','Diabetes'),(${PE},${ROSA},'abuelo','Hipertensión')`)
    await db.execute(sql`insert into encounter (id,organization_id,patient_id,dentist_user_id,status,reason)
      values (${DRAFT},${PE},${ROSA},'u-lista','borrador','Control')`)
    await db.execute(sql`insert into encounter_diagnosis (organization_id,patient_id,encounter_id,cie10_code,diagnosis_type) values
      (${PE},${ROSA},${DRAFT},'K02.1','repetido'),(${PE},${ROSA},${DRAFT},'K05.1','presuntivo')`)

    await apply("0102_diagnosticos_por_lista.sql")

    // Los códigos de desarrollo pasan como CIE-10 no oficial, con categorías y lo dental.
    expect(
      await db.execute(
        sql`select code, edition, is_category, is_dental from diagnosis_code order by code`,
      ),
    ).toEqual([
      { code: "K02", edition: "semilla-desarrollo", is_category: true, is_dental: true },
      { code: "K02.1", edition: "semilla-desarrollo", is_category: false, is_dental: true },
      { code: "K05.1", edition: "semilla-desarrollo", is_category: false, is_dental: true },
    ])
    expect(await db.execute(sql`select official, code_count from diagnosis_code_release`)).toEqual([
      { official: false, code_count: 3 },
    ])
    expect(
      await db.execute(
        sql`select diagnosis_system, diagnosis_code, diagnosis_type, previously_diagnosed from encounter_diagnosis order by diagnosis_code`,
      ),
    ).toEqual([
      {
        diagnosis_system: "ICD-10",
        diagnosis_code: "K02.1",
        diagnosis_type: "confirmed",
        previously_diagnosed: true,
      },
      {
        diagnosis_system: "ICD-10",
        diagnosis_code: "K05.1",
        diagnosis_type: "provisional",
        previously_diagnosed: false,
      },
    ])
    expect(
      await db.execute(sql`select diagnosis_system, diagnosis_code from patient_condition`),
    ).toEqual([{ diagnosis_system: "ICD-10", diagnosis_code: "K05.1" }])
    // Cada clínica queda con la lista de su país.
    expect(
      await db.execute(
        sql`select organization_id, diagnosis_system from org_profile order by organization_id`,
      ),
    ).toEqual([
      { organization_id: CO, diagnosis_system: "ICD-11" },
      { organization_id: PE, diagnosis_system: "ICD-10" },
    ])
    // «Conviviente» es la palabra de Perú; fuera de Perú es HL7 T.
    expect(
      await db.execute(
        sql`select marital_status, education_level, emergency_contact_relationship from patient order by display_name`,
      ),
    ).toEqual([
      { marital_status: "T", education_level: "3", emergency_contact_relationship: null },
      {
        marital_status: "PE:conviviente",
        education_level: "7",
        emergency_contact_relationship: "SPS",
      },
    ])
    expect(
      await db.execute(sql`select relationship from patient_family_history order by relationship`),
    ).toEqual([{ relationship: "FAMMEMB" }, { relationship: "MTH" }])
    // La guarda del borrador vuelve a estar puesta: un diagnóstico registrado no se reescribe.
    await expect(
      db.execute(sql`update encounter_diagnosis set note = 'otra' where encounter_id = ${DRAFT}`),
    ).rejects.toThrow()
    // La aplicación no escribe en el catálogo.
    const grants = (await db.execute(
      sql`select privilege_type from information_schema.role_table_grants where grantee = 'dentalagent_app' and table_name = 'diagnosis_code' order by privilege_type`,
    )) as unknown as Array<{ privilege_type: string }>
    expect(grants.map((row) => row.privilege_type)).not.toContain("INSERT")
    expect(grants.map((row) => row.privilege_type)).not.toContain("UPDATE")
  } finally {
    await container.stop()
  }
}, 300_000)
