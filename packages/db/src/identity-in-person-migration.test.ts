process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { readdir, readFile } from "node:fs/promises"
import { sql } from "drizzle-orm"
import { GenericContainer, Wait } from "testcontainers"
import { expect, it } from "vitest"
import { createOwnerDb } from "./client.js"

const ORG = "identidad-persona"
const ROSA = "eeeeeeee-1111-4111-8111-111111111111"
const LUIS = "eeeeeeee-2222-4222-8222-222222222222"
const ANA = "eeeeeeee-3333-4333-8333-333333333333"
const OTRA = "eeeeeeee-4444-4444-8444-444444444444"

type Row = Record<string, unknown>

/**
 * Migración 0107 (ADR 0044): sobre datos de antes —fichas con identidad propia
 * que la persona no tenía— la persona queda completa, la ficha apunta a ella y
 * las columnas repetidas, la copia y la conciliación desaparecen.
 */
it("lleva a la persona lo que solo tenía la ficha y deja la identidad en un solo lugar", async () => {
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
    const host = `${container.getHost()}:${container.getMappedPort(5432)}`
    const db = createOwnerDb(`postgres://dentalagent:dentalagent@${host}/dentalagent`)
    const files = (await readdir("drizzle")).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
    const apply = async (file: string) => {
      for (const statement of (await readFile(`drizzle/${file}`, "utf8")).split("--> statement-breakpoint")) {
        if (statement.trim()) await db.execute(sql.raw(statement))
      }
    }
    for (const file of files.filter((f) => Number(f.slice(0, 4)) < 107)) await apply(file)
    const rows = async (query: ReturnType<typeof sql>) => (await db.execute(query)) as unknown as Row[]

    // Datos de antes: cada ficha recibe su persona con la copia de siempre.
    await db.execute(sql`insert into organization (id,name,slug,created_at) values (${ORG},${ORG},${ORG},now())`)
    await db.execute(sql`
      insert into patient (id,organization_id,patient_number,display_name,given_names,paternal_surname,maternal_surname,birth_date,sex,phone,email,doc_type,doc_number,doc_country) values
        (${ROSA},${ORG},1,'Rosa Quispe Huamán','Rosa','Quispe','Huamán','1985-03-02','F','+51987000111','rosa@example.test','DNI','40000001','PE'),
        (${LUIS},${ORG},2,'Luis Paredes','Luis','Paredes',null,'1990-07-07','M',null,null,null,null,null),
        (${ANA},${ORG},3,'Ana Torres','Ana','Torres',null,null,null,null,null,null,null,null)`)
    // Lo que solo tiene la ficha (como si la copia hubiera fallado): sin la
    // copia, se borra de la persona y queda solo en la ficha.
    await db.execute(sql`alter table contact disable trigger contact_person_identity_sync`)
    await db.execute(sql`
      update contact c set birth_date = null, email = null, doc_type = null, doc_number = null, doc_country = null
      from patient_contact pc where pc.contact_id = c.id and pc.relationship = 'self' and pc.patient_id = ${ROSA}`)
    await db.execute(sql`alter table contact enable trigger contact_person_identity_sync`)
    await db.execute(sql`alter table patient disable trigger patient_person_identity_sync`)
    // Luis: archivado solo en la ficha. Ana: nombre por revisar solo en la ficha.
    await db.execute(sql`update patient set is_active = false where id = ${LUIS}`)
    await db.execute(sql`update patient set identity_needs_review = true where id = ${ANA}`)
    await db.execute(sql`alter table patient enable trigger patient_person_identity_sync`)
    const selfOf = async (patientId: string) =>
      (await rows(sql`select contact_id from patient_contact where patient_id = ${patientId} and relationship = 'self'`))[0]!
        .contact_id as string
    const rosaPerson = await selfOf(ROSA)

    await apply("0107_la_identidad_en_la_persona.sql")

    // La ficha apunta a su persona, la misma de su vínculo propio.
    expect(await rows(sql`select id, person_id from patient where id = ${ROSA}`)).toEqual([{ id: ROSA, person_id: rosaPerson }])
    // La persona completó lo que solo tenía la ficha, documento entero incluido.
    expect(
      await rows(sql`
        select display_name, birth_date::text as birth_date, email, phone, doc_type, doc_number, doc_country, is_active, identity_needs_review
        from contact where id = ${rosaPerson}`),
    ).toEqual([
      {
        display_name: "Rosa Quispe Huamán",
        birth_date: "1985-03-02",
        email: "rosa@example.test",
        phone: "+51987000111",
        doc_type: "DNI",
        doc_number: "40000001",
        doc_country: "PE",
        is_active: true,
        identity_needs_review: false,
      },
    ])
    // Archivada si lo estaba cualquiera de las dos; la revisión del nombre pasa a la persona.
    expect(await rows(sql`select is_active from contact where id = ${await selfOf(LUIS)}`)).toEqual([{ is_active: false }])
    expect(await rows(sql`select identity_needs_review from contact where id = ${await selfOf(ANA)}`)).toEqual([
      { identity_needs_review: true },
    ])

    // La ficha ya no guarda identidad, ni su segundo índice de documento.
    const columns = (
      await rows(sql`select column_name from information_schema.columns where table_name = 'patient'`)
    ).map((r) => r.column_name)
    for (const gone of ["display_name", "given_names", "paternal_surname", "maternal_surname", "identity_needs_review", "doc_type", "doc_number", "doc_country", "birth_date", "sex", "phone", "email", "is_active"])
      expect(columns).not.toContain(gone)
    expect(columns).toContain("person_id")
    expect(await rows(sql`select indexname from pg_indexes where indexname in ('patient_org_doc_uidx','contact_org_doc_uidx','patient_org_person_uidx') order by 1`)).toEqual([
      { indexname: "contact_org_doc_uidx" },
      { indexname: "patient_org_person_uidx" },
    ])
    // Sin copia ni conciliación.
    expect(
      await rows(sql`
        select proname from pg_proc where proname in ('sync_patient_from_person','sync_person_from_patient','reconcile_patient_person','ensure_patient_person','link_patient_person','adopt_patient_person','patient_requires_person','guard_patient_person_link')`),
    ).toEqual([])

    // Una ficha nueva nace con su vínculo propio, y sin persona no existe.
    const [otra] = await rows(sql`insert into contact (organization_id, display_name) values (${ORG}, 'Otra Persona') returning id`)
    await db.execute(sql`insert into patient (id, organization_id, person_id, patient_number) values (${OTRA}, ${ORG}, ${otra!.id as string}, 4)`)
    expect(await selfOf(OTRA)).toBe(otra!.id)
    await expect(db.execute(sql`insert into patient (organization_id, patient_number) values (${ORG}, 5)`)).rejects.toThrow()
    // Una persona tiene una sola ficha.
    await expect(
      db.execute(sql`insert into patient (organization_id, person_id, patient_number) values (${ORG}, ${rosaPerson}, 6)`),
    ).rejects.toThrow()
    // El vínculo propio no se retira, no se degrada ni apunta a otra persona.
    const guarded = { cause: { message: expect.stringContaining("El vínculo propio del paciente es su persona") } }
    await expect(db.execute(sql`delete from patient_contact where patient_id = ${ROSA} and relationship = 'self'`)).rejects.toMatchObject(guarded)
    await expect(
      db.execute(sql`update patient_contact set relationship = 'other' where patient_id = ${ROSA} and relationship = 'self'`),
    ).rejects.toMatchObject(guarded)
    // Cambiar la persona de la ficha mueve su vínculo propio.
    const [nueva] = await rows(sql`insert into contact (organization_id, display_name) values (${ORG}, 'Otra de verdad') returning id`)
    await db.execute(sql`update patient set person_id = ${nueva!.id as string} where id = ${OTRA}`)
    expect(await selfOf(OTRA)).toBe(nueva!.id)
    expect(await rows(sql`select count(*)::int as n from patient_contact where patient_id = ${OTRA}`)).toEqual([{ n: 1 }])
    // El documento es único solo en la persona.
    await expect(
      db.execute(sql`update contact set doc_type = 'DNI', doc_number = '40000001', doc_country = 'PE' where id = ${nueva!.id as string}`),
    ).rejects.toThrow()
  } finally {
    await container.stop()
  }
}, 300_000)
