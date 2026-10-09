process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { readdir, readFile } from "node:fs/promises"
import { sql } from "drizzle-orm"
import { GenericContainer, Wait } from "testcontainers"
import { expect, it } from "vitest"
import { createOwnerDb } from "./client.js"

const ORG = "identidad"
const ROSA = "dddddddd-1111-4111-8111-111111111111"
const LUIS = "dddddddd-2222-4222-8222-222222222222"

it("separa nombres sin perder datos, migra catálogos y mantiene la sincronía persona–ficha", async () => {
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
    for (const file of files.filter((f) => Number(f.slice(0, 4)) < 39)) await apply(file)
    await db.execute(
      sql`insert into organization (id,name,slug,created_at) values (${ORG},${ORG},${ORG},now())`,
    )
    await db.execute(
      sql`insert into patient (id,organization_id,patient_number,display_name,marital_status,education_level,data_consent_at) values
          (${ROSA},${ORG},1,'Rosa María Quispe Huamán','Casada','Secundaria completa',now()),
          (${LUIS},${ORG},2,'Luis Paredes','Unión libre','Técnico',null)`,
    )
    await apply("0039_identidad_estandar.sql")

    const rows = (await db.execute(
      sql`select id, display_name, given_names, paternal_surname, maternal_surname, identity_needs_review, marital_status, education_level, identity_legacy from patient where organization_id = ${ORG} order by patient_number`,
    )) as unknown as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({
      display_name: "Rosa María Quispe Huamán",
      given_names: "Rosa María",
      paternal_surname: "Quispe",
      maternal_surname: "Huamán",
      identity_needs_review: true,
      marital_status: "casado",
      education_level: "secundaria_completa",
    })
    // Lo que no encaja en el catálogo se conserva aparte, nunca se descarta.
    expect(rows[1]).toMatchObject({
      given_names: "Luis",
      paternal_surname: "Paredes",
      marital_status: null,
      education_level: null,
      identity_legacy: { maritalStatus: "Unión libre", educationLevel: "Técnico" },
    })
    const consents = (await db.execute(
      sql`select patient_id, notice_version from patient_data_consent where organization_id = ${ORG}`,
    )) as unknown as Array<Record<string, unknown>>
    expect(consents).toEqual([{ patient_id: ROSA, notice_version: 0 }])

    // Cambiar el nombre separado en la ficha deriva el visible y llega a la persona.
    await db.execute(
      sql`update patient set given_names = 'Rosa', maternal_surname = 'Huamán de Ruiz' where id = ${ROSA}`,
    )
    const [person] = (await db.execute(
      sql`select c.display_name, c.given_names, c.maternal_surname from contact c join patient_contact pc on pc.contact_id = c.id and pc.relationship = 'self' where pc.patient_id = ${ROSA}`,
    )) as unknown as Array<Record<string, unknown>>
    expect(person).toEqual({
      display_name: "Rosa Quispe Huamán de Ruiz",
      given_names: "Rosa",
      maternal_surname: "Huamán de Ruiz",
    })
    // Los catálogos nuevos rechazan valores fuera de ellos.
    await expect(db.execute(sql`update patient set sex = 'X' where id = ${ROSA}`)).rejects.toThrow()
    await db.execute(sql`update patient set sex = 'D', doc_type = 'CNV' where id = ${LUIS}`)
  } finally {
    await container.stop()
  }
})
