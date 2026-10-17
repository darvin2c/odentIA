process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { patientAllergy, patientContact } from "@odentia/db/schema/clinical"
import {
  createContact,
  createPatient,
  secretsKeyFromEnv,
  setPatientContact,
} from "@odentia/services"
import { and, eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { CrmDeps } from "./helpers.js"
import { createPatientsRoute } from "./patients.js"
import { createPeopleRoute } from "./people.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ab".repeat(32))

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db
let patientId = ""
let personId = ""
let guardianId = ""
let leadId = ""

const storageStub = {
  putAvatar: async () => {
    throw new Error("no usado")
  },
  deleteByUrl: async () => {},
  putAttachment: async () => {
    throw new Error("no usado")
  },
  attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async () => {
    throw new Error("no usado")
  },
  putPatientAvatar: async () => {
    throw new Error("no usado")
  },
}

function buildApp(role: string): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    c.set("orgId", "org_a")
    c.set("userId", "u-1")
    c.set("memberRole", role)
    await next()
  })
  app.route("/people", createPeopleRoute(deps))
  app.route("/patients", createPatientsRoute(deps))
  return app
}

const get = (role: string, path: string) => buildApp(role).request(path, { method: "GET" })
const send = (role: string, method: string, path: string, body: unknown) =>
  buildApp(role).request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
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
  const uri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(uri)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(
    `postgres://dentalagent_app:dentalagent_app@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  )
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_a', 'Clínica', 'norte', now())`,
  )
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
        values ('org_a', 'Clínica', 'PE', 'PEN', 'America/Lima', 'es-PE')`,
  )
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values ('u-1', 'Ana', 'ana@test.dev')`,
  )
  const created = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", "u-1", {
      displayName: "Sofía Salas",
      docType: "DNI",
      docNumber: "70214589",
    }),
  )
  patientId = created.id
  const [own] = await ownerDb
    .select({ id: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.patientId, patientId), eq(patientContact.relationship, "self")))
  personId = own!.id
  await ownerDb.insert(patientAllergy).values({
    organizationId: "org_a",
    patientId,
    substance: "Penicilina",
    severity: "severa",
  })
  await withOrgContext(appDb, "org_a", async (tx) => {
    const guardian = await createContact(tx, "org_a", { displayName: "Martín Salas", phone: "+51987650001" })
    guardianId = guardian.id
    await setPatientContact(tx, "org_a", "u-1", patientId, {
      contactId: guardian.id,
      relationship: "guardian",
      isPreferred: true,
    })
    const lead = await createContact(tx, "org_a", {
      displayName: "Rosa Quispe",
      phone: "+51987654100",
    })
    leadId = lead.id
  })
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

describe("la página de la persona: cada bloque con su propio permiso", () => {
  it("todos los roles que ven personas abren la página; quien no, recibe 403", async () => {
    for (const role of ["reception", "dentist", "cashier", "owner"]) {
      const res = await get(role, `/people/${personId}`)
      expect(res.status, role).toBe(200)
      const body = (await res.json()) as {
        data: { kind: string; patient: { id: string } | null; spokenForBy: { personId: string }[] }
      }
      expect(body.data).toMatchObject({ kind: "paciente", patient: { id: patientId } })
      expect(body.data.spokenForBy.map((row) => row.personId)).toEqual([guardianId])
    }
    expect((await get("member", `/people/${personId}`)).status).toBe(403)
    const guardian = (await (await get("reception", `/people/${guardianId}`)).json()) as {
      data: { kind: string }
    }
    expect(guardian.data.kind).toBe("responsable")
  })

  it("caja y odontología solo ven pacientes: quien aún no lo es no existe para ellos", async () => {
    for (const role of ["cashier", "dentist"]) {
      // Ni su página ni sus bloques: 404, como si no existiera.
      expect((await get(role, `/people/${leadId}`)).status, role).toBe(404)
      expect((await get(role, `/people/${guardianId}`)).status, role).toBe(404)
      // Ni las vistas de quien aún no es paciente; en las demás, solo pacientes.
      expect((await get(role, "/people?ver=por_registrar")).status, role).toBe(403)
      expect((await get(role, "/people?ver=responsables")).status, role).toBe(403)
      const all = (await (await get(role, "/people?ver=todos")).json()) as {
        data: { id: string }[]
        counts: { porRegistrar: number }
      }
      expect(all.data.map((row) => row.id), role).toEqual([personId])
      expect(all.counts.porRegistrar, role).toBe(0)
      const found = (await (await get(role, "/people?ver=activos&q=Rosa")).json()) as { data: unknown[] }
      expect(found.data, role).toEqual([])
    }
    // Odontología lee conversaciones, pero no las de quien no es paciente.
    expect((await get("dentist", `/people/${leadId}/conversations`)).status).toBe(404)
    expect((await get("dentist", `/people/${personId}/conversations`)).status).toBe(200)
    // Recepción y quien dirige sí.
    for (const role of ["reception", "owner"]) {
      expect((await get(role, `/people/${leadId}`)).status, role).toBe(200)
      expect((await get(role, "/people?ver=por_registrar")).status, role).toBe(200)
    }
    // La página del paciente dice si quien habla por ella es paciente (su enlace) y su teléfono.
    const page = (await (await get("dentist", `/people/${personId}`)).json()) as {
      data: { spokenForBy: { personId: string; isPatient: boolean; phone: string | null }[] }
    }
    expect(page.data.spokenForBy).toEqual([
      expect.objectContaining({ personId: guardianId, isPatient: false, phone: "+51987650001" }),
    ])
  })

  it("recepción: datos, alergias, conversaciones, notas y el presupuesto; nada clínico ni de caja", async () => {
    const ficha = (await (await get("reception", `/patients/${patientId}`)).json()) as {
      data: { activeAllergies: { substance: string }[]; activeConditions: unknown[] }
    }
    expect(ficha.data.activeAllergies.map((row) => row.substance)).toEqual(["Penicilina"])
    expect((await get("reception", `/people/${personId}/conversations`)).status).toBe(200)
    expect((await get("reception", `/people/${personId}/notes`)).status).toBe(200)
    expect((await get("reception", `/patients/${patientId}/summary`)).status).toBe(403)
    expect((await get("reception", `/patients/${patientId}/plans`)).status).toBe(403)
    // El presupuesto como documento de la persona (decisión 4), sin la historia clínica.
    expect((await get("reception", `/patients/${patientId}/budgets`)).status).toBe(200)
    expect((await get("reception", `/patients/${patientId}/account`)).status).toBe(403)
  })

  it("odontología: sin el CRM ve sus conversaciones, sin 403, y su clínica y su plan; no las notas ni la caja", async () => {
    const ficha = (await (await get("dentist", `/patients/${patientId}`)).json()) as {
      data: { activeAllergies: { substance: string }[] }
    }
    expect(ficha.data.activeAllergies.map((row) => row.substance)).toEqual(["Penicilina"])
    expect((await get("dentist", `/people/${personId}/conversations`)).status).toBe(200)
    expect((await get("dentist", `/people/${personId}/notes`)).status).toBe(403)
    expect((await get("dentist", `/patients/${patientId}/summary`)).status).toBe(200)
    expect((await get("dentist", `/patients/${patientId}/plans`)).status).toBe(200)
    expect((await get("dentist", `/patients/${patientId}/budgets`)).status).toBe(200)
    expect((await get("dentist", `/patients/${patientId}/account`)).status).toBe(403)
    // No edita la identidad ni archiva: es de quien lleva la filiación.
    expect(
      (await send("dentist", "PATCH", `/people/${personId}/identity`, { phone: "+51911111111" }))
        .status,
    ).toBe(403)
    expect(
      (await send("dentist", "PUT", `/people/${personId}/archived`, { archived: true })).status,
    ).toBe(403)
  })

  it("caja: resumen, datos, cobros y solo los presupuestos; ni alergias ni conversaciones", async () => {
    const ficha = (await (await get("cashier", `/patients/${patientId}`)).json()) as {
      data: { activeAllergies: unknown[]; contacts: unknown[] }
    }
    expect(ficha.data.activeAllergies).toEqual([])
    expect((await get("cashier", `/people/${personId}/conversations`)).status).toBe(403)
    expect((await get("cashier", `/people/${personId}/notes`)).status).toBe(403)
    expect((await get("cashier", `/patients/${patientId}/summary`)).status).toBe(403)
    expect((await get("cashier", `/patients/${patientId}/plans`)).status).toBe(403)
    expect((await get("cashier", `/patients/${patientId}/budgets`)).status).toBe(200)
    expect((await get("cashier", `/patients/${patientId}/account`)).status).toBe(200)
    // En la lista, caja no recibe cuándo escribió ni la próxima cita.
    const list = (await (await get("cashier", "/people?ver=todos")).json()) as {
      data: { id: string; lastInteractionAt: string | null; nextAppointmentAt: string | null }[]
    }
    // Caja solo ve pacientes: ni a Rosa (por registrar) ni a Martín (responsable).
    expect(list.data.map((row) => row.id)).toEqual([personId])
    expect(
      list.data.every((row) => row.lastInteractionAt === null && row.nextAppointmentAt === null),
    ).toBe(true)
  })

  it("propietario: todos los bloques", async () => {
    for (const path of [
      `/people/${personId}/conversations`,
      `/people/${personId}/notes`,
      `/patients/${patientId}/summary`,
      `/patients/${patientId}/plans`,
      `/patients/${patientId}/budgets`,
      `/patients/${patientId}/account`,
    ])
      expect((await get("owner", path)).status, path).toBe(200)
  })

  it("abrir la página no deja traza clínica; abrir Clínica sí", async () => {
    const hits = async () => {
      const log = (await (await get("owner", `/patients/${patientId}/access-log`)).json()) as {
        data: { resource: string; hits: number }[]
      }
      return Object.fromEntries(log.data.map((row) => [row.resource, row.hits]))
    }
    const before = await hits()
    expect((await get("dentist", `/people/${personId}`)).status).toBe(200)
    expect((await get("dentist", `/patients/${patientId}`)).status).toBe(200)
    expect(await hits()).toEqual(before)
    expect((await get("dentist", `/patients/${patientId}/summary`)).status).toBe(200)
    const after = await hits()
    expect(after.resumen ?? 0).toBe((before.resumen ?? 0) + 1)
  })

  it("la ficha lleva a su persona y la lista separa pacientes, por registrar y responsables", async () => {
    const res = await get("dentist", `/people/by-patient/${patientId}`)
    expect(((await res.json()) as { data: { personId: string } }).data.personId).toBe(personId)
    const view = async (ver: string) =>
      (await (await get("reception", `/people?ver=${ver}`)).json()) as {
        data: { id: string }[]
        counts: { porRegistrar: number }
      }
    expect((await view("pacientes")).data.map((row) => row.id)).toEqual([personId])
    expect((await view("por_registrar")).data.map((row) => row.id)).toEqual([leadId])
    expect((await view("responsables")).data.map((row) => row.id)).toEqual([guardianId])
    expect((await view("pacientes")).counts.porRegistrar).toBe(1)
    expect((await get("reception", "/people?ver=otra")).status).toBe(400)
  })

  it("un solo formulario y un solo «Archivar»: con las reglas de la ficha", async () => {
    const wrong = await send("reception", "PATCH", `/people/${leadId}/identity`, {
      docType: "PASAPORTE",
      docNumber: "AB1234",
    })
    expect(wrong.status).toBe(400)
    const ok = await send("reception", "PATCH", `/people/${leadId}/identity`, {
      docType: "PASAPORTE",
      docNumber: "AB1234",
      docCountry: "VE",
      givenNames: "Rosa",
      paternalSurname: "Quispe",
    })
    expect(ok.status).toBe(200)
    expect(
      (await send("reception", "PUT", `/people/${personId}/archived`, { archived: true })).status,
    ).toBe(200)
    const archived = (await (await get("reception", "/people?ver=archivados")).json()) as {
      data: { id: string }[]
    }
    expect(archived.data.map((row) => row.id)).toEqual([personId])
    expect(
      (await send("reception", "PUT", `/people/${personId}/archived`, { archived: false })).status,
    ).toBe(200)
  })
})

describe("la Bandeja crea y busca a la persona con lo mismo que «Nueva persona»", () => {
  it("crea con `createPerson` (nombres y apellidos separados) y la encuentra por su teléfono escrito con espacios", async () => {
    // Lo que envía «Nueva conversación» de la Bandeja.
    const created = await send("reception", "POST", "/people", {
      givenNames: "Carmen",
      paternalSurname: "Ruiz",
      maternalSurname: null,
      phone: "+51987650777",
    })
    expect(created.status).toBe(201)
    const { data } = (await created.json()) as { data: { id: string } }
    const [row] = await ownerDb.execute<{ given_names: string; paternal_surname: string; display_name: string }>(
      sql`select given_names, paternal_surname, display_name from contact where id = ${data.id}`,
    )
    expect(row).toMatchObject({ given_names: "Carmen", paternal_surname: "Ruiz", display_name: "Carmen Ruiz" })
    // El mismo buscador que la lista de personas: compara los dígitos del teléfono.
    const found = (await (await get("reception", `/people?ver=todos&q=${encodeURIComponent("987 650 777")}`)).json()) as {
      data: { id: string }[]
    }
    expect(found.data.map((item) => item.id)).toContain(data.id)
  })
})
