// Prueba de regresión del backfill clínico-económico (0020 sobre el esquema 0019).
// Convenciones de contenedores (igual que rls.test.ts): Testcontainers usa el
// socket Podman compartido en /mnt/wsl; DOCKER_HOST puede sobreescribirse.
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createAppDb, createOwnerDb, type Db } from "./client.js"
import { withOrgContext } from "./context.js"

const IMAGE = "dentalagent-postgres:18.6"
const ORG = "org_clinica_mig"
const OPERADOR = "u_mig_clinico"
const CONTACTO = "aaaaaaaa-1111-4111-8111-111111111111"
const PACIENTE = "bbbbbbbb-1111-4111-8111-111111111111"
const ATENCION = "cccccccc-1111-4111-8111-111111111111"
const PLAN = "dddddddd-1111-4111-8111-111111111111"
const PRESUPUESTO = "eeeeeeee-1111-4111-8111-111111111111"
const ITEM_REALIZADO = "ffffffff-1111-4111-8111-111111111111"
const ITEM_PENDIENTE = "11111111-2222-4111-8111-111111111111"
const PROCEDIMIENTO = "22222222-2222-4111-8111-111111111111"
// Fechas fijas: el backfill debe conservar el instante real, no la fecha de migración.
const SESION = "2026-02-03T14:30:00Z"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

/** Divide un archivo de migración en sentencias (mismo separador que drizzle-kit). */
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

async function aplicarArchivo(db: Db, ruta: string): Promise<void> {
  const texto = await readFile(ruta, "utf8")
  for (const sentencia of dividirSentencias(texto)) await db.execute(sql.raw(sentencia))
}

/** Aplica las migraciones del rango (desde, hasta] en orden. */
async function aplicarRango(db: Db, dir: string, desde: number, hasta: number): Promise<void> {
  const archivos = (await readdir(dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
  for (const archivo of archivos) {
    const indice = Number(archivo.slice(0, 4))
    if (indice <= desde || indice > hasta) continue
    await aplicarArchivo(db, path.join(dir, archivo))
  }
}

/** Siembra clínica previa a 0020: propuesta aceptada, una sesión y un ítem terminado. */
async function sembrarLegado(db: Db) {
  await db.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at")
        values (${ORG}, 'Clínica Migración', 'clinica-migracion', now())`,
  )
  await db.execute(
    sql`insert into "user" ("id", "name", "email")
        values (${OPERADOR}, 'Odontóloga Migración', 'migracion@odentia.dev')`,
  )
  await db.execute(
    sql`insert into "contact" ("id", "organization_id", "display_name")
        values (${CONTACTO}::uuid, ${ORG}, 'Paciente Migración')`,
  )
  await db.execute(
    sql`insert into "patient" ("id", "organization_id", "patient_number", "display_name", "created_at")
        values (${PACIENTE}::uuid, ${ORG}, 7, 'Paciente Migración', '2026-01-05T09:00:00Z')`,
  )
  await db.execute(
    sql`insert into "patient_contact" ("organization_id", "patient_id", "contact_id", "relationship", "is_preferred")
        values (${ORG}, ${PACIENTE}::uuid, ${CONTACTO}::uuid, 'self', true)`,
  )
  await db.execute(
    sql`insert into "encounter" ("id", "organization_id", "patient_id", "dentist_user_id", "reason", "status", "finalized_at", "created_at")
        values (${ATENCION}::uuid, ${ORG}, ${PACIENTE}::uuid, ${OPERADOR}, 'Dolor molar', 'finalizada', ${SESION}::timestamptz, ${SESION}::timestamptz)`,
  )
  await db.execute(
    sql`insert into "treatment_plan" ("id", "organization_id", "patient_id", "title", "origin_encounter_id", "created_at")
        values (${PLAN}::uuid, ${ORG}, ${PACIENTE}::uuid, 'Plan migrado', ${ATENCION}::uuid, '2026-01-06T10:00:00Z')`,
  )
  await db.execute(
    sql`insert into "treatment_budget" ("id", "organization_id", "patient_id", "plan_id", "budget_number", "title", "currency", "status", "created_by", "created_at")
        values (${PRESUPUESTO}::uuid, ${ORG}, ${PACIENTE}::uuid, ${PLAN}::uuid, 1, 'Propuesta migrada', 'PEN', 'borrador', ${OPERADOR}, '2026-01-07T11:00:00Z')`,
  )
  // Ítem terminado con una sesión registrada: el backfill debe recuperar inicio y cierre.
  await db.execute(
    sql`insert into "treatment_plan_item" ("id", "organization_id", "patient_id", "plan_id", "budget_id", "title", "scope", "price_cents", "currency", "status", "created_by", "created_at", "updated_at")
        values (${ITEM_REALIZADO}::uuid, ${ORG}, ${PACIENTE}::uuid, ${PLAN}::uuid, ${PRESUPUESTO}::uuid,
                'Obturación migrada', 'tooth', 45000, 'PEN', 'realizado', ${OPERADOR},
                '2026-01-07T11:05:00Z', '2026-02-03T15:00:00Z')`,
  )
  await db.execute(
    sql`insert into "treatment_budget_item" ("organization_id", "patient_id", "plan_id", "budget_id", "plan_item_id", "title", "scope", "price_cents", "currency", "decision", "created_by", "created_at")
        values (${ORG}, ${PACIENTE}::uuid, ${PLAN}::uuid, ${PRESUPUESTO}::uuid, ${ITEM_REALIZADO}::uuid,
                'Obturación migrada', 'tooth', 45000, 'PEN', 'aceptado', ${OPERADOR}, '2026-01-07T11:05:00Z')`,
  )
  // La línea se crea en borrador (el guardián lo exige) y luego se presenta y acepta.
  await ownerDb.execute(
    sql`update "treatment_budget" set "status" = 'aceptado', "accepted_by_name" = 'Paciente Migración', "decided_at" = '2026-01-09T10:00:00Z'
        where "id" = ${PRESUPUESTO}::uuid`,
  )
  await db.execute(
    sql`insert into "encounter_procedure" ("organization_id", "encounter_id", "plan_item_id", "description", "created_at")
        values (${ORG}, ${ATENCION}::uuid, ${ITEM_REALIZADO}::uuid,
                'Obturación migrada', ${SESION}::timestamptz)`,
  )
  // Ítem sin propuesta: debe quedar pendiente y sin fechas inventadas.
  await db.execute(
    sql`insert into "treatment_plan_item" ("id", "organization_id", "patient_id", "plan_id", "title", "scope", "price_cents", "currency", "status", "created_by", "created_at")
        values (${ITEM_PENDIENTE}::uuid, ${ORG}, ${PACIENTE}::uuid, ${PLAN}::uuid,
                'Blanqueamiento futuro', 'general', 30000, 'PEN', 'pendiente', ${OPERADOR}, '2026-01-08T09:00:00Z')`,
  )
  expect(PROCEDIMIENTO).toBe("22222222-2222-4111-8111-111111111111")
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
  const uri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(uri)
  appDb = createAppDb(
    `postgres://dentalagent_app:dentalagent_app@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  )
  await aplicarRango(ownerDb, path.join(process.cwd(), "drizzle"), -1, 19)
  await sembrarLegado(ownerDb)
  // La migración clínica y sus vecinas se aplican sobre datos reales.
  await aplicarRango(ownerDb, path.join(process.cwd(), "drizzle"), 19, 22)
}, 300_000)

afterAll(async () => {
  await container?.stop()
})

it("conserva la propuesta y reconstruye decisión, inicio y cierre sin inventar datos", async () => {
  const [presupuesto] = (await ownerDb.execute(
    sql`select "id", "budget_number", "revision_number", "status", "title"
        from "treatment_budget" where "id" = ${PRESUPUESTO}::uuid`,
  )) as unknown as Array<{
    id: string
    budget_number: number
    revision_number: number
    status: string
    title: string
  }>
  // La migración no borra ni reescribe la historia económica.
  expect(presupuesto).toMatchObject({
    id: PRESUPUESTO,
    budget_number: 1,
    revision_number: 1,
    status: "aceptado",
    title: "Propuesta migrada",
  })

  const items = (await ownerDb.execute(
    sql`select "id", "decision_status", "started_at", "completed_at"
        from "treatment_plan_item" where "organization_id" = ${ORG} order by "created_at"`,
  )) as unknown as Array<{
    id: string
    decision_status: string
    started_at: Date | null
    completed_at: Date | null
  }>
  const realizado = items.find((row) => row.id === ITEM_REALIZADO)
  const pendiente = items.find((row) => row.id === ITEM_PENDIENTE)
  expect(realizado?.decision_status).toBe("aceptado")
  expect(realizado?.started_at ? new Date(realizado.started_at).toISOString() : null).toBe(
    new Date(SESION).toISOString(),
  )
  expect(realizado?.completed_at).not.toBeNull()
  // Sin línea aceptada no se inventa decisión ni ejecución.
  expect(pendiente).toMatchObject({
    decision_status: "pendiente",
    started_at: null,
    completed_at: null,
  })
})

it("versiona el número de presupuesto sin perder el original", async () => {
  await ownerDb.execute(
    sql`insert into "treatment_budget" ("organization_id", "patient_id", "plan_id", "budget_number", "revision_number", "title", "currency", "status", "created_by")
        values (${ORG}, ${PACIENTE}::uuid, ${PLAN}::uuid, 1, 2, 'Propuesta migrada', 'PEN', 'borrador', ${OPERADOR})`,
  )
  const filas = (await ownerDb.execute(
    sql`select "revision_number" from "treatment_budget"
        where "organization_id" = ${ORG} and "budget_number" = 1 order by "revision_number"`,
  )) as unknown as Array<{ revision_number: number }>
  expect(filas.map((f) => f.revision_number)).toEqual([1, 2])
  // La misma revisión no puede repetirse: el índice único ahora incluye la versión.
  await expect(
    ownerDb.execute(
      sql`insert into "treatment_budget" ("organization_id", "patient_id", "plan_id", "budget_number", "revision_number", "title", "currency", "status")
          values (${ORG}, ${PACIENTE}::uuid, ${PLAN}::uuid, 1, 2, 'Duplicada', 'PEN', 'borrador')`,
    ),
  ).rejects.toMatchObject({ cause: { code: "23505" } })
})

it("aísla las tablas nuevas por tenant y no admite borrado", async () => {
  await ownerDb.execute(
    sql`insert into "treatment_option_group" ("organization_id", "patient_id", "plan_id", "title")
        values (${ORG}, ${PACIENTE}::uuid, ${PLAN}::uuid, 'Alternativas migradas')`,
  )
  const consulta = sql`select "id" from "treatment_option_group"`
  expect(await withOrgContext(appDb, ORG, (tx) => tx.execute(consulta))).toHaveLength(1)
  expect(await withOrgContext(appDb, "org_otra", (tx) => tx.execute(consulta))).toHaveLength(0)
  expect(await appDb.execute(consulta)).toHaveLength(0)
  await expect(
    withOrgContext(appDb, ORG, (tx) => tx.execute(sql`delete from "treatment_option_group"`)),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
  // Las tablas de controles, recetas y cuenta llegaron con la cadena de migraciones.
  const tablas = (await ownerDb.execute(
    sql`select "relname" from "pg_class" where "relname" in
        ('clinical_follow_up', 'prescription', 'prescription_item', 'patient_charge',
         'patient_payment', 'patient_payment_application', 'patient_payment_refund',
         'patient_responsibility', 'treatment_option_group')`,
  )) as unknown as Array<{ relname: string }>
  expect(tablas).toHaveLength(9)
})
