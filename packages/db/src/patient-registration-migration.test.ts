// Prueba de regresión de la migración 0017 (registro de pacientes y contactos).
// Convenciones de contenedores (igual que rls.test.ts): Testcontainers usa el
// socket Podman compartido en /mnt/wsl; DOCKER_HOST puede sobreescribirse
// (p. ej. el pipe npipe de Windows) sin tocar el archivo.
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createAppDb, createOwnerDb, type Db } from "./client.js"
import { withOrgContext } from "./context.js"

// Imagen propia (infra/dev/postgres): trae pgmq + pg_cron, requeridos por las
// migraciones base (pgmq.create) y el init (rol app + extensiones).
const IMAGE = "dentalagent-postgres:18.6"
const APP_ROLE = "dentalagent_app"
const APP_PASSWORD = "dentalagent_app"
// La genera Main en el paso 2 del plan; si cambia el nombre, falla con mensaje claro.
const MIGRACION_0017 = "0017_true_logan.sql"
// Base efímera para el caso de fallo: segundo database en el mismo contenedor.
const DB_FALLO = "mig_fallo_0017"

// Fijuras legadas (esquema previo a 0017): dos organizaciones, un adulto sin
// responsable, un menor con responsable distinta y la anomalía
// responsable == self (un solo vínculo self + auditoría de migración).
const ORG_A = "org_mig_a"
const ORG_B = "org_mig_b"
const OPERADOR = "u_mig_operador"
const C_ADULTO = "11111111-1111-1111-1111-111111111111"
const C_MENOR = "22222222-2222-2222-2222-222222222222"
const C_MADRE = "33333333-3333-3333-3333-333333333333"
const C_ANOMALO = "44444444-4444-4444-4444-444444444444"
const C_SUR = "55555555-5555-5555-5555-555555555555"
const P_ADULTO = "a1111111-1111-1111-1111-111111111111"
const P_MENOR = "a2222222-2222-2222-2222-222222222222"
const P_ANOMALO = "a3333333-3333-3333-3333-333333333333"
const P_SUR = "b1111111-1111-1111-1111-111111111111"
const CONN_A = "d1111111-1111-4111-8111-111111111111"
const V_GRUPO = "e1111111-1111-4111-8111-111111111111"
const V_DIRECTO = "e2222222-2222-4222-8222-222222222222"
const IDENT_TG = "f1111111-1111-4111-8111-111111111111"
// Caso de fallo: paciente de una org colgado de un contacto de otra.
const ORG_FALLO_A = "org_fallo_a"
const ORG_FALLO_B = "org_fallo_b"
const C_FALLO_OTRA = "99999999-9999-9999-9999-999999999999"
const P_FALLO = "a9999999-9999-4999-8999-999999999999"

let container: StartedTestContainer
let baseUri: string
let ownerDb: Db
let appDb: Db

/** Divide un archivo de migración en sentencias (mismo separador de drizzle-kit). */
function dividirSentencias(texto: string): string[] {
  return texto
    .split("--> statement-breakpoint")
    .map((bloque) =>
      bloque
        .split("\n")
        .filter((linea) => !linea.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((bloque) => bloque.length > 0)
}

/** Aplica un archivo SQL sentencia a sentencia, como el migrador en producción. */
async function aplicarArchivo(db: Db, ruta: string): Promise<void> {
  const texto = await readFile(ruta, "utf8")
  for (const sentencia of dividirSentencias(texto)) {
    await db.execute(sql.raw(sentencia))
  }
}

/** Aplica las migraciones base 0000..hastaIndice en orden. */
async function aplicarBase(db: Db, dir: string, hastaIndice: number): Promise<void> {
  const archivos = (await readdir(dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
  for (const archivo of archivos) {
    if (Number(archivo.slice(0, 4)) > hastaIndice) continue
    await aplicarArchivo(db, path.join(dir, archivo))
  }
}

function rutaMigracion(): string {
  return path.join(process.cwd(), "drizzle", MIGRACION_0017)
}

/** Inserta una organización mínima (igual que rls.test.ts). */
async function insertarOrg(db: Db, id: string, slug: string) {
  await db.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at")
        values (${id}, ${"Clínica " + slug}, ${slug}, now())`,
  )
}

/** Siembra el estado legado previo a 0017 sobre la base 0000..0016. */
async function sembrarLegado(db: Db) {
  await insertarOrg(db, ORG_A, "clinica-mig-a")
  await insertarOrg(db, ORG_B, "clinica-mig-b")
  await db.execute(
    sql`insert into "user" ("id", "name", "email")
        values (${OPERADOR}, 'Operadora Migración', 'operadora.mig@odentia.dev')`,
  )
  for (const [id, org, nombre] of [
    [C_ADULTO, ORG_A, "Adulto Uno"],
    [C_MENOR, ORG_A, "Menor Dos"],
    [C_MADRE, ORG_A, "Madre Tres"],
    [C_ANOMALO, ORG_A, "Anómalo Cuatro"],
    [C_SUR, ORG_B, "Beto Sur"],
  ] as const) {
    await db.execute(
      sql`insert into "contact" ("id", "organization_id", "display_name")
          values (${id}::uuid, ${org}, ${nombre})`,
    )
  }
  // created_at explícito: el snapshot legacy debe conservar la fecha original.
  await db.execute(
    sql`insert into "patient"
          ("id", "organization_id", "contact_id", "patient_number", "doc_type", "doc_number", "birth_date", "guardian_contact_id", "created_at")
        values (${P_ADULTO}::uuid, ${ORG_A}, ${C_ADULTO}::uuid, 1, 'DNI', '11111111', '1990-04-12', null, '2024-03-10T10:00:00Z')`,
  )
  await db.execute(
    sql`insert into "patient"
          ("id", "organization_id", "contact_id", "patient_number", "birth_date", "guardian_contact_id", "created_at")
        values (${P_MENOR}::uuid, ${ORG_A}, ${C_MENOR}::uuid, 2, '2020-05-05', ${C_MADRE}::uuid, '2024-06-15T12:00:00Z')`,
  )
  await db.execute(
    sql`insert into "patient"
          ("id", "organization_id", "contact_id", "patient_number", "guardian_contact_id", "created_at")
        values (${P_ANOMALO}::uuid, ${ORG_A}, ${C_ANOMALO}::uuid, 3, ${C_ANOMALO}::uuid, '2024-07-01T09:00:00Z')`,
  )
  await db.execute(
    sql`insert into "patient"
          ("id", "organization_id", "contact_id", "patient_number", "created_at")
        values (${P_SUR}::uuid, ${ORG_B}, ${C_SUR}::uuid, 1, '2024-04-01T08:00:00Z')`,
  )
  // Historia previa: debe sobrevivir con el mismo patient_id.
  await db.execute(
    sql`insert into "patient_allergy"
          ("organization_id", "patient_id", "substance", "severity", "is_active", "created_by")
        values (${ORG_A}, ${P_ADULTO}::uuid, 'Penicilina', 'severa', true, ${OPERADOR})`,
  )
  await db.execute(
    sql`insert into "patient_condition"
          ("organization_id", "patient_id", "name", "status", "created_by")
        values (${ORG_A}, ${P_ADULTO}::uuid, 'Asma', 'activa', ${OPERADOR})`,
  )
  await db.execute(
    sql`insert into "patient_anamnesis"
          ("organization_id", "patient_id", "version", "answers", "created_by")
        values (${ORG_A}, ${P_ADULTO}::uuid, 1, ${JSON.stringify({ alergias: ["penicilina"] })}::jsonb, ${OPERADOR})`,
  )
  // Conversaciones para el backfill de identidad: V_DIRECTO (hilo directo con
  // una sola identidad candidata → se resuelve) y V_GRUPO (hilo grupal
  // Telegram → conserva null aunque haya identidad del mismo contacto/canal).
  await db.execute(
    sql`insert into "channel_connection"
          ("id", "organization_id", "channel", "provider", "display_name", "config_encrypted", "webhook_secret")
        values (${CONN_A}::uuid, ${ORG_A}, 'telegram', 'telegram_bot_api', 'Bot', 'enc', 'secret')`,
  )
  await db.execute(
    sql`insert into "contact_identity" ("id", "organization_id", "contact_id", "channel", "external_user_id")
        values (${IDENT_TG}::uuid, ${ORG_A}, ${C_ADULTO}::uuid, 'telegram', '777001')`,
  )
  for (const [id, hilo] of [
    [V_GRUPO, "tg:-100500"],
    [V_DIRECTO, "tg:777001"],
  ] as const) {
    await db.execute(
      sql`insert into "conversation"
            ("id", "organization_id", "contact_id", "channel_connection_id", "external_thread_id")
          values (${id}::uuid, ${ORG_A}, ${C_ADULTO}::uuid, ${CONN_A}::uuid, ${hilo})`,
    )
  }
}

/** Mensaje combinado (drizzle envuelve el error pg en `cause`). */
function mensajeCombinado(error: unknown): string {
  const causa = (error as { cause?: { message?: string; detail?: string } })?.cause
  return `${(error as Error)?.message} | ${causa?.message} | ${causa?.detail}`
}

async function capturarError(promesa: Promise<unknown>): Promise<string> {
  try {
    await promesa
  } catch (error) {
    return mensajeCombinado(error)
  }
  return "SIN_ERROR"
}

beforeAll(async () => {
  // GenericContainer en lugar de PostgreSqlContainer: este último inyecta un
  // healthcheck en el CREATE y Podman lo rechaza (sin systemd en la máquina).
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: "dentalagent",
      POSTGRES_USER: "dentalagent",
      POSTGRES_PASSWORD: "dentalagent",
      POSTGRES_APP_PASSWORD: APP_PASSWORD,
    })
    // Esperar por log: el mensaje aparece dos veces (initdb temporal y final).
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    // pg_cron exige preload; el init hace CREATE EXTENSION.
    .withCommand([
      "postgres",
      "-c",
      "shared_preload_libraries=pg_cron",
      "-c",
      "cron.database_name=dentalagent",
    ])
    .start()
  baseUri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}`
  ownerDb = createOwnerDb(`${baseUri}/dentalagent`)
  const dir = path.join(process.cwd(), "drizzle")
  await aplicarBase(ownerDb, dir, 16)
  await sembrarLegado(ownerDb)
  await readFile(rutaMigracion(), "utf8").catch(() => {
    throw new Error(`Falta la migración ${MIGRACION_0017} en ./drizzle; la genera Main en el paso 2`)
  })
  await aplicarArchivo(ownerDb, rutaMigracion())
  appDb = createAppDb(
    `postgres://${APP_ROLE}:${APP_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  )
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

describe("migración 0017: pacientes separados de interlocutores", () => {
  it("conserva número, documento, nacimiento e historia con el mismo id", async () => {
    const filas = (await ownerDb.execute<{
      organization_id: string
      patient_number: number
      display_name: string
      doc_type: string | null
      doc_number: string | null
      birth_date: string | null
    }>(
      sql`select "organization_id", "patient_number", "display_name", "doc_type", "doc_number", "birth_date"
          from "patient" order by "organization_id", "patient_number"`,
    )) as unknown as {
      organization_id: string
      patient_number: number
      display_name: string
      doc_type: string | null
      doc_number: string | null
      birth_date: string | null
    }[]
    expect(filas).toEqual([
      {
        organization_id: ORG_A,
        patient_number: 1,
        display_name: "Adulto Uno",
        doc_type: "DNI",
        doc_number: "11111111",
        birth_date: "1990-04-12",
      },
      {
        organization_id: ORG_A,
        patient_number: 2,
        display_name: "Menor Dos",
        doc_type: null,
        doc_number: null,
        birth_date: "2020-05-05",
      },
      {
        organization_id: ORG_A,
        patient_number: 3,
        display_name: "Anómalo Cuatro",
        doc_type: null,
        doc_number: null,
        birth_date: null,
      },
      {
        organization_id: ORG_B,
        patient_number: 1,
        display_name: "Beto Sur",
        doc_type: null,
        doc_number: null,
        birth_date: null,
      },
    ])
    const alergias = (await ownerDb.execute(
      sql`select "substance", "severity", "is_active", "patient_id" from "patient_allergy"`,
    )) as unknown as { substance: string; severity: string; is_active: boolean; patient_id: string }[]
    expect(alergias).toEqual([
      { substance: "Penicilina", severity: "severa", is_active: true, patient_id: P_ADULTO },
    ])
    const condiciones = (await ownerDb.execute(
      sql`select "name", "status", "patient_id" from "patient_condition"`,
    )) as unknown as { name: string; status: string; patient_id: string }[]
    expect(condiciones).toEqual([{ name: "Asma", status: "activa", patient_id: P_ADULTO }])
    const anamnesis = (await ownerDb.execute(
      sql`select "version", "answers", "patient_id" from "patient_anamnesis"`,
    )) as unknown as { version: number; answers: unknown; patient_id: string }[]
    expect(anamnesis).toEqual([
      { version: 1, answers: { alergias: ["penicilina"] }, patient_id: P_ADULTO },
    ])
  })

  it("migra self y responsable con preferente en el responsable distinto", async () => {
    const filas = (await ownerDb.execute(
      sql`select "patient_id", "contact_id", "relationship", "is_preferred"
          from "patient_contact" order by "patient_id", "contact_id"`,
    )) as unknown as {
      patient_id: string
      contact_id: string
      relationship: string
      is_preferred: boolean
    }[]
    expect(filas).toEqual([
      { patient_id: P_ADULTO, contact_id: C_ADULTO, relationship: "self", is_preferred: true },
      { patient_id: P_MENOR, contact_id: C_MENOR, relationship: "self", is_preferred: false },
      { patient_id: P_MENOR, contact_id: C_MADRE, relationship: "guardian", is_preferred: true },
      { patient_id: P_ANOMALO, contact_id: C_ANOMALO, relationship: "self", is_preferred: true },
      { patient_id: P_SUR, contact_id: C_SUR, relationship: "self", is_preferred: true },
    ])
    // Sin pérdida: todos los contactos originales siguen existiendo.
    const total = (await ownerDb.execute<{ total: number }>(
      sql`select count(*)::int as "total" from "contact" where "organization_id" = ${ORG_A}`,
    )) as unknown as { total: number }[]
    expect(total[0].total).toBe(4)
  })

  it("audita la anomalía responsable igual a self sin inventar una persona", async () => {
    const filas = (await ownerDb.execute(
      sql`select "action", "entity", "entity_id", "metadata" from "audit_event"
          where "action" = 'migration.patient_guardian_same_as_self'`,
    )) as unknown as {
      action: string
      entity: string
      entity_id: string
      metadata: unknown
    }[]
    expect(filas).toHaveLength(1)
    expect(filas[0].entity).toBe("patient")
    expect(filas[0].entity_id).toBe(P_ANOMALO)
    expect(filas[0].metadata).toMatchObject({ contactId: C_ANOMALO, migration: "0017" })
  })

  it("crea snapshots legacy sin atribuir origen, autor ni consentimiento", async () => {
    const filas = (await ownerDb.execute(
      sql`select r."patient_id", r."entry_point", r."respondent", r."answers",
                r."actor_user_id", r."created_at", p."created_at" as "creado"
          from "patient_registration" r
          join "patient" p on p."id" = r."patient_id" and p."organization_id" = r."organization_id"
          order by r."patient_id"`,
    )) as unknown as {
      patient_id: string
      entry_point: string
      respondent: string | null
      answers: unknown
      actor_user_id: string | null
      created_at: Date
      creado: Date
    }[]
    expect(filas.map((f) => f.patient_id).sort()).toEqual(
      [P_ADULTO, P_MENOR, P_ANOMALO, P_SUR].sort(),
    )
    for (const fila of filas) {
      expect(fila.entry_point).toBe("legacy")
      expect(fila.respondent).toBeNull()
      expect(fila.answers).toEqual({})
      expect(fila.actor_user_id).toBeNull()
      // Fecha original de la ficha, no la fecha de la migración.
      expect(new Date(fila.created_at).getTime()).toBe(new Date(fila.creado).getTime())
    }
  })

  it("elimina columnas e índice heredados sin alias de compatibilidad", async () => {
    const columnas = (await ownerDb.execute(
      sql`select "column_name" from "information_schema"."columns"
          where "table_schema" = 'public' and "table_name" = 'patient'
            and "column_name" in ('contact_id', 'guardian_contact_id')`,
    )) as unknown as { column_name: string }[]
    expect(columnas).toHaveLength(0)
    const indice = (await ownerDb.execute(
      sql`select "relname" from "pg_class" where "relname" = 'patient_org_contact_uidx'`,
    )) as unknown as { relname: string }[]
    expect(indice).toHaveLength(0)
    // display_name obligatorio desde el nombre del contacto; blood_group admite null.
    const nulidad = (await ownerDb.execute(
      sql`select "column_name", "is_nullable" from "information_schema"."columns"
          where "table_schema" = 'public' and "table_name" = 'patient'
            and "column_name" in ('display_name', 'blood_group') order by "column_name"`,
    )) as unknown as { column_name: string; is_nullable: string }[]
    expect(nulidad).toEqual([
      { column_name: "blood_group", is_nullable: "YES" },
      { column_name: "display_name", is_nullable: "NO" },
    ])
  })

  it("el catálogo de grupo sanguíneo se aplica con CHECK sin inferencias", async () => {
    await expect(
      ownerDb.execute(sql`update "patient" set "blood_group" = 'X' where "id" = ${P_SUR}::uuid`),
    ).rejects.toMatchObject({ cause: { code: "23514" } })
    await ownerDb.execute(
      sql`update "patient" set "blood_group" = 'O+' where "id" = ${P_SUR}::uuid`,
    )
    await ownerDb.execute(sql`update "patient" set "blood_group" = null where "id" = ${P_SUR}::uuid`)
  })

  it("amplía contact con datos declarados y activo por defecto", async () => {
    const filas = (await ownerDb.execute(
      sql`select "is_active", "phone", "email" from "contact" where "id" = ${C_ADULTO}::uuid`,
    )) as unknown as { is_active: boolean; phone: string | null; email: string | null }[]
    expect(filas).toEqual([{ is_active: true, phone: null, email: null }])
    // El default cubre filas nuevas sin valor explícito (se usa org B para no
    // alterar los conteos de contactos de org A).
    await ownerDb.execute(
      sql`insert into "contact" ("id", "organization_id", "display_name")
          values ('66666666-6666-6666-6666-666666666666'::uuid, ${ORG_B}, 'Contacto Nuevo')`,
    )
    const nuevo = (await ownerDb.execute(
      sql`select "is_active" from "contact" where "display_name" = 'Contacto Nuevo'`,
    )) as unknown as { is_active: boolean }[]
    expect(nuevo).toEqual([{ is_active: true }])
  })

  it("resuelve identidad solo con candidato único y conserva null ambiguo", async () => {
    const filas = (await ownerDb.execute(
      sql`select "id", "contact_identity_id" from "conversation"
          where "organization_id" = ${ORG_A} order by "id"`,
    )) as unknown as { id: string; contact_identity_id: string | null }[]
    expect(filas).toEqual([
      { id: V_GRUPO, contact_identity_id: null },
      { id: V_DIRECTO, contact_identity_id: IDENT_TG },
    ])
  })

  it("rechaza referencias cruzadas de tenant en patient_contact", async () => {
    // Paciente de B con organización A.
    await expect(
      ownerDb.execute(
        sql`insert into "patient_contact" ("organization_id", "patient_id", "contact_id", "relationship")
            values (${ORG_A}, ${P_SUR}::uuid, ${C_ADULTO}::uuid, 'family')`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23503" } })
    // Contacto de B con organización A.
    await expect(
      ownerDb.execute(
        sql`insert into "patient_contact" ("organization_id", "patient_id", "contact_id", "relationship")
            values (${ORG_A}, ${P_ADULTO}::uuid, ${C_SUR}::uuid, 'family')`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23503" } })
  })

  it("aísla vínculos y snapshots por organización con FORCE RLS", async () => {
    const vinculosA = (await withOrgContext(appDb, ORG_A, (tx) =>
      tx.execute<{ total: number }>(sql`select count(*)::int as "total" from "patient_contact"`),
    )) as unknown as { total: number }[]
    expect(vinculosA[0].total).toBe(4)
    const vinculosB = (await withOrgContext(appDb, ORG_B, (tx) =>
      tx.execute<{ total: number }>(sql`select count(*)::int as "total" from "patient_contact"`),
    )) as unknown as { total: number }[]
    expect(vinculosB[0].total).toBe(1)
    const sinContexto = (await appDb.execute<{ total: number }>(
      sql`select count(*)::int as "total" from "patient_contact"`,
    )) as unknown as { total: number }[]
    expect(sinContexto[0].total).toBe(0)
    const snapshotsA = (await withOrgContext(appDb, ORG_A, (tx) =>
      tx.execute<{ total: number }>(
        sql`select count(*)::int as "total" from "patient_registration"`,
      ),
    )) as unknown as { total: number }[]
    expect(snapshotsA[0].total).toBe(3)
    const snapshotsB = (await withOrgContext(appDb, ORG_B, (tx) =>
      tx.execute<{ total: number }>(
        sql`select count(*)::int as "total" from "patient_registration"`,
      ),
    )) as unknown as { total: number }[]
    expect(snapshotsB[0].total).toBe(1)
  })

  it("patient_registration es append-only para el rol app", async () => {
    const alActualizar = await capturarError(
      withOrgContext(appDb, ORG_A, (tx) =>
        tx.execute(
          sql`update "patient_registration" set "privacy_notice" = 'revisado' where "patient_id" = ${P_ADULTO}::uuid`,
        ),
      ),
    )
    expect(alActualizar).toMatch(/permission denied/i)
    const alBorrar = await capturarError(
      withOrgContext(appDb, ORG_A, (tx) =>
        tx.execute(sql`delete from "patient_registration" where "patient_id" = ${P_ADULTO}::uuid`),
      ),
    )
    expect(alBorrar).toMatch(/permission denied/i)
  })

  it("impide duplicar vínculo, segundo self y segundo preferente", async () => {
    // Mismo triple (org, paciente, contacto).
    await expect(
      ownerDb.execute(
        sql`insert into "patient_contact" ("organization_id", "patient_id", "contact_id", "relationship")
            values (${ORG_A}, ${P_ADULTO}::uuid, ${C_ADULTO}::uuid, 'family')`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23505" } })
    // Un paciente no tiene dos self.
    await expect(
      ownerDb.execute(
        sql`insert into "patient_contact" ("organization_id", "patient_id", "contact_id", "relationship")
            values (${ORG_A}, ${P_ADULTO}::uuid, ${C_MADRE}::uuid, 'self')`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23505" } })
    // Un paciente no tiene dos preferentes.
    await expect(
      ownerDb.execute(
        sql`insert into "patient_contact" ("organization_id", "patient_id", "contact_id", "relationship", "is_preferred")
            values (${ORG_A}, ${P_MENOR}::uuid, ${C_ADULTO}::uuid, 'family', true)`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23505" } })
  })

  it("la configuración publica valores por defecto seguros y aislados", async () => {
    await ownerDb.execute(
      sql`insert into "patient_registration_config" ("organization_id", "fields")
          values (${ORG_A}, ${"{}"}::jsonb)`,
    )
    const filas = (await ownerDb.execute(
      sql`select "version", "enabled", "privacy_notice" from "patient_registration_config"
          where "organization_id" = ${ORG_A}`,
    )) as unknown as { version: number; enabled: boolean; privacy_notice: string }[]
    expect(filas).toEqual([{ version: 1, enabled: false, privacy_notice: "" }])
    const vistaB = (await withOrgContext(appDb, ORG_B, (tx) =>
      tx.execute(sql`select "organization_id" from "patient_registration_config"`),
    )) as unknown as { organization_id: string }[]
    expect(vistaB).toHaveLength(0)
  })

  it("el hash de enlace es único global", async () => {
    const expira = new Date(Date.now() + 72 * 3600 * 1000).toISOString()
    await ownerDb.execute(
      sql`insert into "patient_registration_link"
            ("organization_id", "contact_id", "conversation_id", "token_hash", "created_by", "expires_at")
          values (${ORG_A}, ${C_ADULTO}::uuid, ${V_DIRECTO}::uuid, 'hash-unico-1', ${OPERADOR}, ${expira}::timestamptz)`,
    )
    await expect(
      ownerDb.execute(
        sql`insert into "patient_registration_link"
              ("organization_id", "contact_id", "conversation_id", "token_hash", "created_by", "expires_at")
            values (${ORG_A}, ${C_MENOR}::uuid, ${V_DIRECTO}::uuid, 'hash-unico-1', ${OPERADOR}, ${expira}::timestamptz)`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23505" } })
  })
})

describe("migración 0017 con vínculos inválidos", () => {
  it("falla identificando el registro y revierte sin descartar datos", async () => {
    // Base efímera separada: no apuntar a DB de usuario ni reutilizar la ya migrada.
    await ownerDb.execute(sql.raw(`DROP DATABASE IF EXISTS "${DB_FALLO}" WITH (FORCE)`))
    await ownerDb.execute(sql.raw(`CREATE DATABASE "${DB_FALLO}"`))
    const falloDb = createOwnerDb(`${baseUri}/${DB_FALLO}`)
    // La base nueva no hereda extensiones del init: instalar las que exigen
    // las migraciones base (defaults gen_random_uuid y colas pgmq).
    await falloDb.execute(sql.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"'))
    await falloDb.execute(sql.raw('CREATE EXTENSION IF NOT EXISTS "pgmq"'))
    await aplicarBase(falloDb, path.join(process.cwd(), "drizzle"), 16)
    await insertarOrg(falloDb, ORG_FALLO_A, "clinica-fallo-a")
    await insertarOrg(falloDb, ORG_FALLO_B, "clinica-fallo-b")
    await falloDb.execute(
      sql`insert into "contact" ("id", "organization_id", "display_name")
          values (${C_FALLO_OTRA}::uuid, ${ORG_FALLO_B}, 'Contacto Otra Org')`,
    )
    // Vínculo cruzado: paciente de A colgado de un contacto de B.
    await falloDb.execute(
      sql`insert into "patient" ("id", "organization_id", "contact_id", "patient_number")
          values (${P_FALLO}::uuid, ${ORG_FALLO_A}, ${C_FALLO_OTRA}::uuid, 1)`,
    )

    const error = await aplicarArchivo(falloDb, rutaMigracion())
      .then(() => null)
      .catch((e) => e)
    expect(error).not.toBeNull()
    // La validación identifica el registro para corregirlo con datos verificados.
    expect(mensajeCombinado(error)).toContain(P_FALLO)

    // Reversión: columnas antiguas presentes, tablas nuevas ausentes, fila intacta.
    const columnas = (await falloDb.execute(
      sql`select "column_name" from "information_schema"."columns"
          where "table_schema" = 'public' and "table_name" = 'patient'
            and "column_name" in ('contact_id', 'guardian_contact_id')`,
    )) as unknown as { column_name: string }[]
    expect(columnas.map((c) => c.column_name).sort()).toEqual(["contact_id", "guardian_contact_id"])
    const tablas = (await falloDb.execute(
      sql`select "relname" from "pg_class" where "relname" in ('patient_contact', 'patient_registration')`,
    )) as unknown as { relname: string }[]
    expect(tablas).toHaveLength(0)
    const paciente = (await falloDb.execute(
      sql`select "contact_id", "patient_number" from "patient" where "id" = ${P_FALLO}::uuid`,
    )) as unknown as { contact_id: string; patient_number: number }[]
    expect(paciente).toEqual([{ contact_id: C_FALLO_OTRA, patient_number: 1 }])
  }, 180_000)
})
