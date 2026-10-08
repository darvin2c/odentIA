process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { readdir, readFile } from "node:fs/promises"
import { sql } from "drizzle-orm"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createOwnerDb, type Db } from "./client.js"

const ORG = "legacy"
const A = "aaaaaaaa-1111-4111-8111-111111111111"
const B = "bbbbbbbb-1111-4111-8111-111111111111"
const D = "dddddddd-1111-4111-8111-111111111111"
const SELF_B = "bbbbbbbb-2222-4222-8222-222222222222"
const MOTHER = "dddddddd-2222-4222-8222-222222222222"

let container: StartedTestContainer
let db: Db

const person = async (patientId: string) =>
  (
    await db.execute(
      sql`select c.id, c.display_name, c.phone, c.email, c.doc_type, c.doc_number, c.birth_date::text as birth_date, c.sex, c.notes, pc.is_preferred
          from patient_contact pc join contact c on c.id = pc.contact_id
          where pc.patient_id = ${patientId} and pc.relationship = 'self'`,
    )
  )[0]
const patientRow = async (patientId: string) =>
  (
    await db.execute(
      sql`select display_name, phone, email, doc_type, doc_number, birth_date::text as birth_date, sex from patient where id = ${patientId}`,
    )
  )[0]

beforeAll(async () => {
  container = await new GenericContainer("dentalagent-postgres:18.6")
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
  db = createOwnerDb(
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
  for (const file of files.filter((f) => Number(f.slice(0, 4)) < 34)) await apply(file)

  // Datos previos a la persona única.
  await db.execute(
    sql`insert into organization (id,name,slug,created_at) values (${ORG},'Legado','legacy',now())`,
  )
  // A: sin ninguna persona, con valores fuera de catálogo.
  await db.execute(
    sql`insert into patient (id,organization_id,patient_number,display_name,doc_type,doc_number,sex,birth_date,phone)
        values (${A},${ORG},1,'Ana Sola','carnet','X-1','f','1990-05-02','999111222')`,
  )
  // B: con persona propia cuyos datos difieren de la ficha.
  await db.execute(
    sql`insert into patient (id,organization_id,patient_number,display_name,doc_type,doc_number,phone,email)
        values (${B},${ORG},2,'Beatriz Ramos Vega','DNI','40000002','987000111',null)`,
  )
  await db.execute(
    sql`insert into contact (id,organization_id,display_name,phone,email) values (${SELF_B},${ORG},'Bea 🌸','51911222333','bea@example.test')`,
  )
  await db.execute(
    sql`insert into patient_contact (organization_id,patient_id,contact_id,relationship,is_preferred) values (${ORG},${B},${SELF_B},'self',true)`,
  )
  // D: menor atendido a través de su madre; no tiene persona propia.
  await db.execute(
    sql`insert into patient (id,organization_id,patient_number,display_name,birth_date) values (${D},${ORG},3,'Diego Menor','2018-01-01')`,
  )
  await db.execute(
    sql`insert into contact (id,organization_id,display_name,phone) values (${MOTHER},${ORG},'Madre de Diego','900000003')`,
  )
  await db.execute(
    sql`insert into patient_contact (organization_id,patient_id,contact_id,relationship,is_preferred) values (${ORG},${D},${MOTHER},'guardian',true)`,
  )
  await db.execute(
    sql`insert into agent_proposal (organization_id,contact_id,action,payload,idempotency_key)
        values (${ORG},${MOTHER},'reservar_cita',${JSON.stringify({ patientId: D })}::jsonb,'k-1'),
               (${ORG},${MOTHER},'enviar_mensaje',${JSON.stringify({ text: "hola" })}::jsonb,'k-2')`,
  )
  await apply("0034_person_identity.sql")
}, 240_000)

afterAll(async () => {
  await container?.stop()
})

it("da persona a cada paciente existente sin perder ni inventar identidad", async () => {
  // A: persona creada desde la filiación, con el catálogo normalizado.
  expect(await patientRow(A)).toMatchObject({ doc_type: "OTRO", doc_number: "X-1", sex: "F" })
  expect(await person(A)).toMatchObject({
    display_name: "Ana Sola",
    doc_type: "OTRO",
    doc_number: "X-1",
    sex: "F",
    birth_date: "1990-05-02",
    phone: "999111222",
    is_preferred: true,
  })
  // B: se conserva la persona vinculada; manda la ficha y lo distinto queda anotado.
  const b = await person(B)
  expect(b).toMatchObject({
    id: SELF_B,
    display_name: "Beatriz Ramos Vega",
    doc_type: "DNI",
    doc_number: "40000002",
    phone: "987000111",
    email: "bea@example.test",
  })
  expect(b.notes).toContain("Teléfono anterior del contacto: 51911222333")
  expect(await patientRow(B)).toMatchObject({ phone: "987000111", email: "bea@example.test" })
  // D: el menor recibe su propia persona; la madre sigue siendo su tutora y preferente.
  const d = await person(D)
  expect(d).toMatchObject({ display_name: "Diego Menor", is_preferred: false })
  expect(d.id).not.toBe(MOTHER)
  const links = await db.execute(
    sql`select relationship, is_preferred from patient_contact where patient_id = ${D} order by relationship`,
  )
  expect(links).toEqual([
    { relationship: "guardian", is_preferred: true },
    { relationship: "self", is_preferred: false },
  ])
  // La propuesta del agente queda referida a su paciente; la comercial, a ninguno.
  const proposals = await db.execute(
    sql`select idempotency_key, patient_id from agent_proposal order by idempotency_key`,
  )
  expect(proposals).toEqual([
    { idempotency_key: "k-1", patient_id: D },
    { idempotency_key: "k-2", patient_id: null },
  ])
})

it("mantiene una sola identidad: editar la ficha o la persona actualiza la otra", async () => {
  await db.execute(sql`update patient set display_name = 'Ana Sola Pérez', email = 'ana@example.test' where id = ${A}`)
  expect(await person(A)).toMatchObject({ display_name: "Ana Sola Pérez", email: "ana@example.test" })
  const { id } = await person(A)
  await db.execute(sql`update contact set phone = '955000111', birth_date = '1990-05-03' where id = ${id as string}`)
  expect(await patientRow(A)).toMatchObject({ phone: "955000111", birth_date: "1990-05-03" })
  // Lo que no es identidad no viaja: las notas de la persona no tocan la ficha.
  await db.execute(sql`update contact set notes = 'Prefiere la tarde' where id = ${id as string}`)
  expect(await patientRow(A)).toMatchObject({ display_name: "Ana Sola Pérez" })
})

it("todo paciente nuevo es una persona: se adopta por documento o se crea", async () => {
  // Persona conocida por su documento, aún sin ficha: se adopta, no se duplica.
  const [known] = await db.execute(
    sql`insert into contact (organization_id,display_name,doc_type,doc_number,phone) values (${ORG},'Carla','DNI','40000009','944000999') returning id`,
  )
  const [created] = await db.execute(
    sql`insert into patient (organization_id,patient_number,display_name,doc_type,doc_number) values (${ORG},10,'Carla Núñez','DNI','40000009') returning id`,
  )
  const adopted = await person(created.id as string)
  expect(adopted).toMatchObject({ id: known.id, display_name: "Carla Núñez", phone: "944000999" })
  expect(await patientRow(created.id as string)).toMatchObject({ phone: "944000999" })
  // Sin documento coincidente: persona nueva. El teléfono nunca identifica.
  const [other] = await db.execute(
    sql`insert into patient (organization_id,patient_number,display_name,phone) values (${ORG},11,'Otra Persona','944000999') returning id`,
  )
  expect((await person(other.id as string)).id).not.toBe(known.id)
  // Vínculo explícito en la misma transacción: no se crea una persona de más.
  await db.transaction(async (tx) => {
    const [lead] = await tx.execute(
      sql`insert into contact (organization_id,display_name,phone) values (${ORG},'Lead WhatsApp','51900111222') returning id`,
    )
    const [p] = await tx.execute(
      sql`insert into patient (organization_id,patient_number,display_name) values (${ORG},12,'Elena Torres') returning id`,
    )
    await tx.execute(
      sql`insert into patient_contact (organization_id,patient_id,contact_id,relationship,is_preferred) values (${ORG},${p.id as string},${lead.id as string},'self',true)`,
    )
  })
  const count = await db.execute(
    sql`select count(*)::int as n from contact where organization_id = ${ORG} and display_name = 'Elena Torres'`,
  )
  expect(count[0].n).toBe(1)
})

it("la propia persona no se desvincula ni se degrada; un documento es de una sola persona", async () => {
  const guarded = { cause: { message: expect.stringContaining("conservar su propia persona") } }
  await expect(
    db.execute(sql`delete from patient_contact where patient_id = ${A} and relationship = 'self'`),
  ).rejects.toMatchObject(guarded)
  await expect(
    db.execute(sql`update patient_contact set relationship = 'other' where patient_id = ${A} and relationship = 'self'`),
  ).rejects.toMatchObject(guarded)
  expect(await person(A)).toBeDefined()
  await expect(
    db.execute(sql`insert into contact (organization_id,display_name,doc_type,doc_number) values (${ORG},'Duplicada','DNI','40000002')`),
  ).rejects.toThrow()
})
