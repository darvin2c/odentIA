/**
 * Buscador rápido (ADR 0066): sin tildes, cada resultado debajo de su dueño y
 * cada tipo con el permiso de su pantalla. Buscar nunca identifica.
 */
import { randomUUID } from "node:crypto"
import { canAccess, type Permission } from "@odentia/auth/permissions"
import { type Db, withOrgContext } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import { clinicalNote, serviceCatalog } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { createRoom } from "./appointments.js"
import { type GlobalSearchResult, searchEverything, searchMeaningOwners } from "./global-search.js"
import { insertTestPatients } from "./test-patient.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ORG = `org_${randomUUID().slice(0, 8)}`
const OTHER = `org_${randomUUID().slice(0, 8)}`
const USER = `u-${ORG}`
const PROFESSIONAL = `d-${ORG}`
let luciaPersonId = ""
let luciaPatientId = ""
let madrePersonId = ""
let leadPersonId = ""
let serviceId = ""
const OTHER_PROFESSIONAL = `d2-${ORG}`

const run = <T>(orgId: string, fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
const as = (role: string, q: string, orgId = ORG) =>
  run(orgId, (tx) =>
    searchEverything(tx, orgId, {
      q,
      can: (permission) => canAccess(role, permission as Permission),
      viewer: { userId: USER, role },
      now: new Date("2026-10-19T12:00:00Z"),
    }),
  )
const owner = (result: GlobalSearchResult, title: string) =>
  result.owners.find((o) => o.title === title)

beforeAll(async () => {
  await insertOrg(ownerDb, ORG, ORG)
  await insertOrg(ownerDb, OTHER, OTHER)
  await ownerDb.insert(user).values([
    { id: USER, name: "Recepción Uno", email: `${USER}@buscar.test` },
    { id: PROFESSIONAL, name: "Dra. Ana Pruebas", email: `${PROFESSIONAL}@buscar.test` },
    { id: OTHER_PROFESSIONAL, name: "Dr. Otro", email: `${OTHER_PROFESSIONAL}@buscar.test` },
  ])
  await ownerDb.execute(sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
    (${`m-${USER}`}, ${ORG}, ${USER}, 'reception', now()), (${`m-${PROFESSIONAL}`}, ${ORG}, ${PROFESSIONAL}, 'clinician', now())`)

  const [lucia] = await insertTestPatients(ownerDb, {
    organizationId: ORG,
    displayName: "Lucía Quispe",
    patientNumber: 1,
    phone: "+51987654321",
    docNumber: "87654321",
  })
  luciaPatientId = lucia!.id
  luciaPersonId = lucia!.personId
  // Su madre comparte el teléfono; aún no es paciente.
  const [madre] = await ownerDb
    .insert(contact)
    .values({ organizationId: ORG, displayName: "Rosa Huamán", phone: "+51 987 654 321" })
    .returning()
  madrePersonId = madre!.id
  const [lead] = await ownerDb
    .insert(contact)
    .values({ organizationId: ORG, displayName: "Lucía Ramos" })
    .returning()
  leadPersonId = lead!.id
  // Otra clínica con el mismo nombre: nunca aparece.
  await insertTestPatients(ownerDb, {
    organizationId: OTHER,
    displayName: "Lucía Otra Clínica",
    patientNumber: 1,
  })

  const [sede] = await ownerDb
    .insert(branch)
    .values({ organizationId: ORG, name: "Sede Centro", timezone: "America/Lima" })
    .returning({ id: branch.id })
  const room = await run(ORG, (tx) =>
    createRoom(tx, ORG, { branchId: sede!.id, name: "Unidad dental Uno" }),
  )
  const [service] = await ownerDb
    .insert(serviceCatalog)
    .values({
      organizationId: ORG,
      name: "Profilaxis (limpieza)",
      source: "custom",
      priceCents: 12000,
      currency: "PEN",
      durationMin: 30,
    })
    .returning({ id: serviceCatalog.id })
  serviceId = service!.id
  // Un presupuesto que preparó otro odontólogo: el odontólogo que busca no lo ve.
  await ownerDb.execute(sql`with plan as (
      insert into treatment_plan (organization_id, patient_id, title) values (${ORG}, ${luciaPatientId}, 'Plan') returning id)
    insert into treatment_budget (organization_id, patient_id, plan_id, budget_number, title, currency, created_by)
    select ${ORG}, ${luciaPatientId}, plan.id, 45, 'Ortodoncia de Lucía', 'PEN', ${OTHER_PROFESSIONAL} from plan`)
  await ownerDb.insert(appointment).values({
    organizationId: ORG,
    branchId: sede!.id,
    patientId: luciaPatientId,
    professionalUserId: PROFESSIONAL,
    roomId: room.id,
    serviceName: "Profilaxis (limpieza)",
    startsAt: new Date("2026-10-20T15:00:00Z"),
    endsAt: new Date("2026-10-20T15:30:00Z"),
    durationMin: 30,
  })
  const [connection] = await ownerDb
    .insert(channelConnection)
    .values({
      organizationId: ORG,
      channel: "telegram",
      provider: "telegram_bot_api",
      displayName: "Canal",
      configEncrypted: "c",
      webhookSecret: "s",
      status: "active",
    })
    .returning()
  const [thread] = await ownerDb
    .insert(conversation)
    .values({
      organizationId: ORG,
      contactId: leadPersonId,
      channelConnectionId: connection!.id,
      externalThreadId: `t:${randomUUID()}`,
    })
    .returning()
  await ownerDb.insert(message).values({
    organizationId: ORG,
    conversationId: thread!.id,
    direction: "in",
    senderKind: "contact",
    body: "Hola, ¿cuánto cuesta el blanqueamiento? Lo quiero antes de mi boda",
  })
  await ownerDb.insert(clinicalNote).values({
    organizationId: ORG,
    patientId: luciaPatientId,
    authorUserId: PROFESSIONAL,
    note: "Dolor molar inferior derecho. Refiere bruxismo nocturno.",
  })
}, 180_000)

describe("buscar sin tildes y con su dueño", () => {
  it("«lucia» encuentra a Lucía Quispe, con lo pendiente debajo, y nada de otra clínica", async () => {
    const result = await as("reception", "lucia")
    const lucia = owner(result, "Lucía Quispe")
    expect(lucia).toMatchObject({ kind: "persona", matched: true, badge: "Paciente" })
    expect(lucia?.items.some((item) => item.kind === "cita")).toBe(true)
    expect(result.owners.some((o) => o.title === "Lucía Otra Clínica")).toBe(false)
    // Recepción ve a quien aún no es paciente.
    expect(owner(result, "Lucía Ramos")).toMatchObject({ badge: "Aún no es paciente" })
  })

  it("un pedazo de palabra basta y la cita aparece debajo de su persona", async () => {
    const result = await as("reception", "profilax")
    expect(result.owners.find((o) => o.kind === "servicio")?.title).toBe("Profilaxis (limpieza)")
    const lucia = owner(result, "Lucía Quispe")
    expect(lucia?.matched).toBe(false)
    expect(lucia?.items.map((item) => item.kind)).toEqual(["cita"])
  })

  it("buscar por teléfono trae a madre e hija: nunca elige a una", async () => {
    const result = await as("reception", "987 654")
    const ids = result.owners.map((o) => o.id)
    expect(ids).toContain(luciaPersonId)
    expect(ids).toContain(madrePersonId)
  })

  it("lo que dicen los mensajes aparece debajo de quien lo escribió", async () => {
    const result = await as("reception", "blanqueamiento")
    const lead = result.owners.find((o) => o.id === leadPersonId)
    expect(lead?.items[0]).toMatchObject({
      kind: "mensaje",
      type: "conversacion",
      detail: "Telegram",
    })
    expect(lead?.items[0]?.title).toContain("blanqueamiento")
  })

  it("por número de historia, con su prefijo o sin él", async () => {
    expect(owner(await as("reception", "HC-000001"), "Lucía Quispe")).toBeDefined()
    expect(owner(await as("reception", "hc 1"), "Lucía Quispe")).toBeDefined()
  })

  it("dice si encontró a una persona o algo de la historia, para que esa frase no vaya a los vectores", async () => {
    expect((await as("reception", "lucia")).personal).toBe(true)
    expect((await as("clinician", "bruxismo")).personal).toBe(true)
    expect((await as("reception", "profilax")).personal).toBe(false)
  })

  it("lo que encontró el significado y no las letras, con el permiso de su pantalla", async () => {
    const ranked = { services: [serviceId], promotions: [], answers: [] }
    const meaning = (role: string, exclude: string[] = []) =>
      run(ORG, (tx) =>
        searchMeaningOwners(tx, ORG, {
          can: (p) => canAccess(role, p as Permission),
          ranked,
          exclude: new Set(exclude),
        }),
      )
    expect((await meaning("reception")).map((o) => o.title)).toEqual(["Profilaxis (limpieza)"])
    expect(await meaning("reception", [`servicio:${serviceId}`])).toEqual([])
    expect(await meaning("member")).toEqual([])
  })

  it("`%` y `_` valen como letras", async () => {
    const result = await as("owner", "%%")
    expect(result.owners).toEqual([])
  })
})

describe("cada rol ve lo de su pantalla", () => {
  it("la historia clínica solo para quien la ve, y queda anotado lo que se mostró", async () => {
    const professional = await as("clinician", "bruxismo")
    expect(owner(professional, "Lucía Quispe")?.items[0]).toMatchObject({
      kind: "nota",
      type: "clinica",
    })
    expect(professional.clinicalReads).toEqual([{ patientId: luciaPatientId, resource: "notas" }])

    const reception = await as("reception", "bruxismo")
    expect(reception.owners).toEqual([])
    expect(reception.clinicalReads).toEqual([])
  })

  it("caja no recibe citas ni mensajes; el odontólogo no ve como dueño a quien aún no es paciente", async () => {
    const cashier = await as("cashier", "lucia")
    expect(owner(cashier, "Lucía Quispe")?.items.some((item) => item.kind === "cita")).toBe(false)
    expect(owner(cashier, "Lucía Ramos")).toBeUndefined()
    expect((await as("cashier", "blanqueamiento")).owners).toEqual([])

    const professional = await as("clinician", "lucia")
    expect(owner(professional, "Lucía Quispe")).toBeDefined()
    expect(owner(professional, "Lucía Ramos")).toBeUndefined()
  })

  it("el odontólogo solo ve los presupuestos que preparó o indicó, como en la ficha", async () => {
    expect(owner(await as("owner", "ortodoncia"), "Lucía Quispe")?.items[0]).toMatchObject({
      kind: "presupuesto",
    })
    expect(await as("clinician", "ortodoncia")).toMatchObject({ owners: [] })
  })

  it("el filtro quita un tipo entero", async () => {
    const result = await run(ORG, (tx) =>
      searchEverything(tx, ORG, {
        q: "profilax",
        can: (permission) => canAccess("owner", permission as Permission),
        viewer: { userId: USER, role: "owner" },
        types: ["persona", "cita"],
      }),
    )
    expect(result.owners.some((o) => o.kind === "servicio")).toBe(false)
  })
})
