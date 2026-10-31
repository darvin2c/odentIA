import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { agentProposal } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { patientContact, treatmentBudget, treatmentPlan } from "@odentia/db/schema/clinical"
import { conversation, contact, crmTask, message } from "@odentia/db/schema/crm"
import { opportunity } from "@odentia/db/schema/opportunities"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createConnection } from "./connections.js"
import { createContact, listContacts } from "./contacts.js"
import { applyStatus, listConversations, setAgentStatus } from "./conversations.js"
import { listContactActivity } from "./crm-workspace.js"
import {
  closeOpportunity,
  createOpportunity,
  getOpportunity,
  getOpportunitySummary,
  listOpportunities,
  moveOpportunity,
  reopenOpportunity,
  setOpportunityTask,
  updateOpportunity,
} from "./opportunities.js"
import { createPatient } from "./patients.js"
import { ensureDefaultPipeline } from "./pipelines.js"
import { completeTask, createTask, getTask, listTasks, updateTask } from "./tasks.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
import { secretsKeyFromEnv } from "./secrets.js"

setupTestDb()

const KEY = secretsKeyFromEnv("aa".repeat(32))
const ACTOR_A = randomUUID()
const ACTOR_B = randomUUID()
const TAG = randomUUID().slice(0, 8)

async function makeMember(orgId: string, userId: string, role: string): Promise<void> {
  await ownerDb.insert(user).values({
    id: userId,
    name: "Persona de prueba",
    email: `${userId}@crm.test`,
    emailVerified: true,
  })
  await ownerDb.insert(member).values({
    id: randomUUID(),
    organizationId: orgId,
    userId,
    role,
    createdAt: new Date(),
  })
}

async function makeConnection(orgId: string): Promise<string> {
  return withOrgContext(appDb, orgId, (tx) =>
    createConnection(
      tx,
      orgId,
      KEY,
      {
        channel: "telegram",
        provider: "telegram_bot_api",
        displayName: "Bot de prueba",
        config: { botToken: "T" },
      },
      { fetch, validateExternal: false },
    ).then((c) => c.id),
  )
}

let connA = ""
let connB = ""

async function setupMembers(): Promise<void> {
  await makeMember("org_a", ACTOR_A, "owner")
  await makeMember("org_b", ACTOR_B, "owner")
  connA = await makeConnection("org_a")
  connB = await makeConnection("org_b")
}

// Se ejecuta una vez por archivo (contenedor efímero propio).
let bootstrapped = false
async function bootstrap(): Promise<void> {
  if (bootstrapped) return
  bootstrapped = true
  await setupMembers()
}

async function makeContact(org: string, name: string) {
  await bootstrap()
  return withOrgContext(appDb, org, (tx) => createContact(tx, org, { displayName: name }))
}

async function makeConversationDirect(
  org: string,
  contactId: string,
  over: Partial<{ status: string; agentStatus: string; thread: string }> = {},
): Promise<string> {
  await bootstrap()
  const conn = org === "org_a" ? connA : connB
  const [row] = await ownerDb
    .insert(conversation)
    .values({
      organizationId: org,
      contactId,
      channelConnectionId: conn,
      externalThreadId: over.thread ?? `hilo-${randomUUID()}`,
      status: over.status ?? "open",
      agentStatus: over.agentStatus ?? "on",
    })
    .returning({ id: conversation.id })
  return row!.id
}

async function addMessage(
  org: string,
  conversationId: string,
  over: Partial<{
    direction: string
    senderKind: string
    status: string
    body: string
    createdAt: Date
  }> = {},
) {
  const [row] = await ownerDb
    .insert(message)
    .values({
      organizationId: org,
      conversationId,
      direction: over.direction ?? "in",
      senderKind: over.senderKind ?? "contact",
      body: over.body ?? "Hola",
      status: over.status ?? "received",
      createdAt: over.createdAt ?? new Date(),
    })
    .returning({ id: message.id })
  return row!.id
}

it("contactos: orden global por nombre recorre todas las páginas y el cursor ata al sort", async () => {
  const prefix = `Orden ${TAG}`
  const names = ["Ana", "Beto", "Carlos", "Diana", "Elena"].map((n) => `${prefix} ${n}`)
  for (const name of names) await makeContact("org_a", name)
  const asc: string[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await withOrgContext(appDb, "org_a", (tx) =>
      listContacts(tx, "org_a", { q: prefix, sort: "nombre", limit: 2, cursor }),
    )
    asc.push(...page.items.map((c) => c.displayName))
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  expect(asc).toEqual([...names].sort((a, b) => (a < b ? -1 : 1)))
  const desc: string[] = []
  cursor = undefined
  for (;;) {
    const page = await withOrgContext(appDb, "org_a", (tx) =>
      listContacts(tx, "org_a", { q: prefix, sort: "-nombre", limit: 2, cursor }),
    )
    desc.push(...page.items.map((c) => c.displayName))
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  expect(desc).toEqual([...names].sort((a, b) => (a < b ? 1 : -1)))
  // El cursor de un sort no sirve en otro.
  const first = await withOrgContext(appDb, "org_a", (tx) =>
    listContacts(tx, "org_a", { q: prefix, sort: "nombre", limit: 1 }),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      listContacts(tx, "org_a", {
        q: prefix,
        sort: "-nombre",
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      }),
    ),
  ).rejects.toThrow("filtros actuales")
})

it("contactos: actividad con >30 marcas en el mismo ms no pierde filas (keyset con micros UTC)", async () => {
  const prefix = `Micro ${TAG}`
  const ids: string[] = []
  for (let i = 0; i < 35; i++) {
    const c = await makeContact("org_a", `${prefix} ${String(i).padStart(2, "0")}`)
    ids.push(c.id)
    // Marcas separadas por microsegundos dentro del mismo milisegundo.
    await ownerDb.execute(
      sql`update "contact" set "last_interaction_at" =
        '2026-09-20T10:00:00+00'::timestamptz + (${i} || ' microseconds')::interval
        where "id" = ${c.id}`,
    )
  }
  for (const sort of ["-actividad", "actividad"] as const) {
    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await withOrgContext(appDb, "org_a", (tx) =>
        listContacts(tx, "org_a", { q: prefix, sort, limit: 10, cursor }),
      )
      seen.push(...page.items.map((c) => c.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(new Set(seen).size).toBe(35)
    expect(seen.sort()).toEqual([...ids].sort())
  }
})

it("contactos: openOpportunityCount es agregado completo aunque la página trunque", async () => {
  const a = await makeContact("org_a", `Conteo ${TAG} Alfa`)
  const b = await makeContact("org_a", `Conteo ${TAG} Beta`)
  await withOrgContext(appDb, "org_a", (tx) => ensureDefaultPipeline(tx, "org_a"))
  for (let i = 0; i < 2; i++) {
    await withOrgContext(appDb, "org_a", (tx) =>
      createOpportunity(tx, "org_a", { contactId: a.id, title: `Caso ${TAG} ${i}` }),
    )
  }
  const won = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: a.id, title: `Cerrado ${TAG}` }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    closeOpportunity(tx, "org_a", won.id, { outcome: "won", reason: "acepto" }),
  )
  // Página de 1: el conteo del contacto sigue siendo completo (2 abiertas, la cerrada no cuenta).
  // «Alfa» y «Beta» no caben en el TAG (hexadecimal): la búsqueda por partes no confunde los dos.
  const page = await withOrgContext(appDb, "org_a", (tx) =>
    listContacts(tx, "org_a", { q: `Conteo ${TAG} Alfa`, sort: "nombre", limit: 1 }),
  )
  expect(page.items).toHaveLength(1)
  expect(page.items[0]?.openOpportunityCount).toBe(2)
  const other = await withOrgContext(appDb, "org_a", (tx) =>
    listContacts(tx, "org_a", { q: `Conteo ${TAG} Beta`, sort: "nombre", limit: 10 }),
  )
  expect(other.items[0]?.openOpportunityCount).toBe(0)
  expect(b.id).toBeTruthy()
})

it("oportunidades: hilo origen del mismo contacto y rechazo entre contactos y tenants", async () => {
  const a = await makeContact("org_a", `Hilo ${TAG} A`)
  const b = await makeContact("org_a", `Hilo ${TAG} B`)
  const convA = await makeConversationDirect("org_a", a.id)
  const opp = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(
      tx,
      "org_a",
      { contactId: a.id, title: `Negocio ${TAG}`, conversationId: convA },
      { userId: ACTOR_A },
    ),
  )
  expect(opp.conversationId).toBe(convA)
  expect(opp.createdAt).toBeTruthy()
  expect(opp.moment).toBe("interesado")
  const listed = await withOrgContext(appDb, "org_a", (tx) =>
    listOpportunities(tx, "org_a", { contactId: a.id, limit: 10 }),
  )
  const found = listed.items.find((o) => o.id === opp.id)
  expect(found?.conversationId).toBe(convA)
  expect(found?.createdAt).toBeTruthy()
  // Hilo de otro contacto: se rechaza.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createOpportunity(tx, "org_a", { contactId: b.id, title: `Cruce ${TAG}`, conversationId: convA }),
    ),
  ).rejects.toThrow("otro contacto")
  // Hilo de otro tenant: no se ve (aislamiento).
  const ext = await makeContact("org_b", `Hilo ${TAG} Ext`)
  const convB = await makeConversationDirect("org_b", ext.id)
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createOpportunity(tx, "org_a", { contactId: a.id, title: `Fuga ${TAG}`, conversationId: convB }),
    ),
  ).rejects.toThrow("Conversación")
  // Cambiar de contacto con hilo vigente se rechaza.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      updateOpportunity(tx, "org_a", opp.id, { contactId: b.id }, { userId: ACTOR_A }),
    ),
  ).rejects.toThrow("otro contacto")
})

it("oportunidades: paciente vinculado estricto y presupuesto coherente al cambiar paciente", async () => {
  const a = await makeContact("org_a", `Paciente ${TAG} A`)
  const c = await makeContact("org_a", `Paciente ${TAG} C`)
  const p1 = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR_A, {
      displayName: `Ficha ${TAG} 1`,
      contacts: [{ contactId: a.id, relationship: "self", isPreferred: true }],
    }),
  )
  const p2 = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR_A, {
      displayName: `Ficha ${TAG} 2`,
      contacts: [{ contactId: a.id, relationship: "guardian", isPreferred: false }],
    }),
  )
  // Paciente no vinculado al contacto: se rechaza.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createOpportunity(tx, "org_a", { contactId: c.id, title: `Sin vínculo ${TAG}`, patientId: p1.id }),
    ),
  ).rejects.toThrow("vinculado")
  // Presupuesto del paciente 1 atado a la oportunidad.
  const [plan] = await ownerDb
    .insert(treatmentPlan)
    .values({ organizationId: "org_a", patientId: p1.id, title: `Plan ${TAG}` })
    .returning({ id: treatmentPlan.id })
  const [budget] = await ownerDb
    .insert(treatmentBudget)
    .values({
      organizationId: "org_a",
      patientId: p1.id,
      planId: plan!.id,
      budgetNumber: 1,
      title: `Presupuesto ${TAG}`,
      currency: "PEN",
      status: "presentado",
    })
    .returning({ id: treatmentBudget.id })
  const opp = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(
      tx,
      "org_a",
      { contactId: a.id, title: `Con presupuesto ${TAG}`, patientId: p1.id, budgetId: budget!.id },
      { userId: ACTOR_A },
    ),
  )
  expect(opp.budgetId).toBe(budget!.id)
  // Cambiar solo el paciente deja el presupuesto incoherente: se rechaza.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      updateOpportunity(tx, "org_a", opp.id, { patientId: p2.id }, { userId: ACTOR_A }),
    ),
  ).rejects.toThrow("otro paciente")
  // Cambiar paciente y limpiar presupuesto a la vez sí procede.
  const moved = await withOrgContext(appDb, "org_a", (tx) =>
    updateOpportunity(
      tx,
      "org_a",
      opp.id,
      { patientId: p2.id, budgetId: null },
      { userId: ACTOR_A },
    ),
  )
  expect(moved.patientId).toBe(p2.id)
  expect(moved.budgetId).toBeNull()
})

it("oportunidades: summary agregado por filtros; el valor solo suma lo abierto", async () => {
  const s = await makeContact("org_a", `Resumen ${TAG}`)
  const pipe = await withOrgContext(appDb, "org_a", (tx) => ensureDefaultPipeline(tx, "org_a"))
  const first = pipe.stages.find((st) => st.moment === "interesado")!
  const second = pipe.stages.find((st) => st.moment === "evaluacion_agendada")!
  const decided = pipe.stages.find((st) => st.moment === "decidio")!
  await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: s.id, title: `R1 ${TAG}`, amountCents: 10000 }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: s.id, title: `R2 ${TAG}`, amountCents: 20000 }),
  )
  const r3 = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: s.id, title: `R3 ${TAG}`, amountCents: 50000 }),
  )
  await withOrgContext(appDb, "org_a", (tx) => moveOpportunity(tx, "org_a", r3.id, second.id, { userId: ACTOR_A }))
  const closed = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: s.id, title: `R4 ${TAG}`, amountCents: 70000 }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    closeOpportunity(tx, "org_a", closed.id, { outcome: "lost", reason: "no_lo_necesita" }),
  )
  const summary = await withOrgContext(appDb, "org_a", (tx) =>
    getOpportunitySummary(tx, "org_a", { contactId: s.id }),
  )
  expect(summary.total).toBe(4)
  expect(summary.open).toBe(3)
  // El total del tablero suma solo lo abierto: la perdida no cuenta.
  expect(summary.openAmounts).toEqual([{ currency: "PEN", amountCents: "80000" }])
  const byStage = new Map(summary.stages.map((st) => [st.stageId, st]))
  expect(byStage.get(first.id)?.count).toBe(2)
  expect(byStage.get(first.id)?.amounts).toContainEqual({ currency: "PEN", amountCents: "30000" })
  expect(byStage.get(decided.id)).toMatchObject({ count: 1, amounts: [] })
  // Solo abiertas excluye la cerrada.
  const openOnly = await withOrgContext(appDb, "org_a", (tx) =>
    getOpportunitySummary(tx, "org_a", { contactId: s.id, status: "open" }),
  )
  expect(openOnly.total).toBe(3)
  // Sin coincidencias: total 0 y sin etapas (no 100% ni nulos).
  const empty = await withOrgContext(appDb, "org_a", (tx) =>
    getOpportunitySummary(tx, "org_a", { contactId: randomUUID() }),
  )
  expect(empty).toEqual({ total: 0, open: 0, won: 0, lost: 0, openAmounts: [], stages: [] })
  // Paginación recorre todo el conjunto del contacto.
  const all: string[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await withOrgContext(appDb, "org_a", (tx) =>
      listOpportunities(tx, "org_a", { contactId: s.id, limit: 2, cursor }),
    )
    all.push(...page.items.map((o) => o.id))
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  expect(new Set(all).size).toBe(4)
})

it("oportunidades: el tablero muestra lo abierto y lo cerrado de los últimos 30 días", async () => {
  const s = await makeContact("org_a", `Tablero ${TAG}`)
  const open = await withOrgContext(appDb, "org_a", (tx) => createOpportunity(tx, "org_a", { contactId: s.id, title: `Abierta ${TAG}` }))
  const recent = await withOrgContext(appDb, "org_a", (tx) => createOpportunity(tx, "org_a", { contactId: s.id, title: `Reciente ${TAG}` }))
  const old = await withOrgContext(appDb, "org_a", (tx) => createOpportunity(tx, "org_a", { contactId: s.id, title: `Vieja ${TAG}` }))
  for (const id of [recent.id, old.id]) {
    await withOrgContext(appDb, "org_a", (tx) => closeOpportunity(tx, "org_a", id, { outcome: "lost", reason: "precio" }, { userId: ACTOR_A }))
  }
  await ownerDb.execute(sql`update opportunity set closed_at = now() - interval '31 days' where id = ${old.id}`)
  const board = await withOrgContext(appDb, "org_a", (tx) => listOpportunities(tx, "org_a", { contactId: s.id, recent: true, limit: 10 }))
  expect(board.items.map((o) => o.id).sort()).toEqual([open.id, recent.id].sort())
  expect(board.items.find((o) => o.id === recent.id)?.why).toBe("Perdida: «Precio»")
  const summary = await withOrgContext(appDb, "org_a", (tx) => getOpportunitySummary(tx, "org_a", { contactId: s.id, recent: true }))
  expect(summary).toMatchObject({ total: 2, open: 1 })
})

it("tareas: vínculos hilo/oportunidad con autovinculado y rechazos cross-tenant", async () => {
  const a = await makeContact("org_a", `Tarea ${TAG} A`)
  const b = await makeContact("org_a", `Tarea ${TAG} B`)
  const convA = await makeConversationDirect("org_a", a.id)
  const convB = await makeConversationDirect("org_a", b.id)
  const oppA = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: a.id, title: `Opp tarea ${TAG}` }),
  )
  const oppB = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: b.id, title: `Opp tarea ${TAG} B` }),
  )
  // Vínculo completo coherente con nombres comerciales.
  const full = await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", {
      title: `Llamar ${TAG}`,
      contactId: a.id,
      conversationId: convA,
      opportunityId: oppA.id,
      createdBy: "user",
    }),
  )
  expect(full.contactName).toBeTruthy()
  expect(full.opportunityTitle).toContain(TAG)
  // Solo hilo: autovincula al contacto del hilo.
  const auto = await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", { title: `Auto ${TAG}`, conversationId: convA, createdBy: "user" }),
  )
  expect(auto.contactId).toBe(a.id)
  // Una oportunidad tiene una sola tarea abierta: la segunda se rechaza con su nombre.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createTask(tx, "org_a", { title: `Otra ${TAG}`, opportunityId: oppA.id, createdBy: "user" }),
    ),
  ).rejects.toMatchObject({ code: "OPPORTUNITY_HAS_TASK", status: 409 })
  // Solo oportunidad: autovincula al contacto de la oportunidad y, sin responsable, va a Recepción.
  const oppA2 = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: a.id, title: `Opp tarea 2 ${TAG}` }),
  )
  const autoOpp = await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", { title: `Auto opp ${TAG}`, opportunityId: oppA2.id, createdBy: "user" }),
  )
  expect(autoOpp).toMatchObject({ contactId: a.id, area: "recepcion" })
  // Hilo y oportunidad de distintos contactos: se rechaza.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createTask(tx, "org_a", {
        title: `Cruce ${TAG}`,
        conversationId: convA,
        opportunityId: oppB.id,
        createdBy: "user",
      }),
    ),
  ).rejects.toThrow("distintos")
  // Contacto A con hilo de B: se rechaza.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createTask(tx, "org_a", {
        title: `Cruce 2 ${TAG}`,
        contactId: a.id,
        conversationId: convB,
        createdBy: "user",
      }),
    ),
  ).rejects.toThrow("distintos")
  // Tenant ajeno: no se ve.
  const ext = await makeContact("org_b", `Tarea ${TAG} Ext`)
  const convExt = await makeConversationDirect("org_b", ext.id)
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createTask(tx, "org_a", { title: `Fuga ${TAG}`, conversationId: convExt, createdBy: "user" }),
    ),
  ).rejects.toThrow("Conversación")
  // Asignado debe ser miembro de la org.
  const ok = await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", {
      title: `Asignada ${TAG}`,
      assigneeUserId: ACTOR_A,
      createdBy: "user",
    }),
  )
  expect(ok.assigneeUserId).toBe(ACTOR_A)
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createTask(tx, "org_a", {
        title: `Asignada mal ${TAG}`,
        assigneeUserId: ACTOR_B,
        createdBy: "user",
      }),
    ),
  ).rejects.toThrow("miembro")
})

it("tareas: filtros por vínculos, vencidas y responsable", async () => {
  const a = await makeContact("org_a", `Filtro ${TAG} A`)
  const conv = await makeConversationDirect("org_a", a.id)
  const opp = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: a.id, title: `Opp filtro ${TAG}` }),
  )
  const past = new Date(Date.now() - 3600_000).toISOString()
  const future = new Date(Date.now() + 3600_000).toISOString()
  const overdue = await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", {
      title: `Vencida ${TAG}`,
      contactId: a.id,
      dueAt: past,
      assigneeUserId: ACTOR_A,
      createdBy: "user",
    }),
  )
  const upcoming = await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", { title: `Futura ${TAG}`, contactId: a.id, dueAt: future, createdBy: "user" }),
  )
  const donePast = await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", { title: `Hecha ${TAG}`, contactId: a.id, dueAt: past, createdBy: "user" }),
  )
  await withOrgContext(appDb, "org_a", (tx) => completeTask(tx, "org_a", donePast.id))
  const onlyOverdue = await withOrgContext(appDb, "org_a", (tx) =>
    listTasks(tx, "org_a", { contactId: a.id, overdue: true }),
  )
  expect(onlyOverdue.map((t) => t.id)).toContain(overdue.id)
  expect(onlyOverdue.map((t) => t.id)).not.toContain(upcoming.id)
  expect(onlyOverdue.map((t) => t.id)).not.toContain(donePast.id)
  const notOverdue = await withOrgContext(appDb, "org_a", (tx) =>
    listTasks(tx, "org_a", { contactId: a.id, overdue: false }),
  )
  expect(notOverdue.map((t) => t.id)).not.toContain(overdue.id)
  const linked = await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", { title: `Ligada ${TAG}`, opportunityId: opp.id, createdBy: "user" }),
  )
  const byOpp = await withOrgContext(appDb, "org_a", (tx) =>
    listTasks(tx, "org_a", { opportunityId: opp.id }),
  )
  expect(byOpp.map((t) => t.id)).toContain(linked.id)
  expect(byOpp.map((t) => t.id)).not.toContain(overdue.id)
  const byConv = await withOrgContext(appDb, "org_a", (tx) =>
    listTasks(tx, "org_a", { conversationId: conv }),
  )
  expect(byConv).toEqual([])
  const byAssignee = await withOrgContext(appDb, "org_a", (tx) =>
    listTasks(tx, "org_a", { assignee: ACTOR_A }),
  )
  expect(byAssignee.map((t) => t.id)).toContain(overdue.id)
})

it("la próxima acción es una tarea, y solo una: sigue a quien la lleva y se cierra sola al cerrarse", async () => {
  const a = await makeContact("org_a", `Tarea única ${TAG}`)
  const conv = await makeConversationDirect("org_a", a.id)
  const d1 = new Date("2026-10-10T15:00:00.000Z").toISOString()
  const d2 = new Date("2026-10-11T15:00:00.000Z").toISOString()
  const opp = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(tx, "org_a", { contactId: a.id, title: `Comercial ${TAG}`, conversationId: conv }, { userId: ACTOR_A }),
  )
  // Sin responsable es de Recepción: su tarea también.
  const first = await withOrgContext(appDb, "org_a", (tx) =>
    setOpportunityTask(tx, "org_a", opp.id, { title: `Llamar ${TAG}`, dueAt: d1 }, { userId: ACTOR_A, createdBy: "user" }),
  )
  expect((await withOrgContext(appDb, "org_a", (tx) => getTask(tx, "org_a", first.taskId)))).toMatchObject({
    assigneeUserId: null, area: "recepcion", opportunityId: opp.id, dueAt: d1,
  })
  // Cambiarla no crea otra: es la misma tarea.
  const again = await withOrgContext(appDb, "org_a", (tx) =>
    setOpportunityTask(tx, "org_a", opp.id, { dueAt: d2 }, { userId: ACTOR_A, createdBy: "user" }),
  )
  expect(again.taskId).toBe(first.taskId)
  const open = await withOrgContext(appDb, "org_a", (tx) => listTasks(tx, "org_a", { opportunityId: opp.id, status: "open" }))
  expect(open.map((t) => [t.id, t.dueAt])).toEqual([[first.taskId, d2]])
  // La oportunidad la muestra como su siguiente tarea.
  const detail = await withOrgContext(appDb, "org_a", (tx) => getOpportunity(tx, "org_a", opp.id))
  expect(detail.nextTask).toMatchObject({ id: first.taskId, title: `Llamar ${TAG}`, dueAt: d2 })
  // Tomarla: la tarea sin responsable pasa a quien la toma.
  await withOrgContext(appDb, "org_a", (tx) => updateOpportunity(tx, "org_a", opp.id, { assignedUserId: ACTOR_A }, { userId: ACTOR_A }))
  expect((await withOrgContext(appDb, "org_a", (tx) => getTask(tx, "org_a", first.taskId))).assigneeUserId).toBe(ACTOR_A)
  // Reabrir una tarea hecha cuando ya hay otra abierta se rechaza.
  await withOrgContext(appDb, "org_a", (tx) => completeTask(tx, "org_a", first.taskId))
  const second = await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", { title: `Segunda ${TAG}`, opportunityId: opp.id, createdBy: "user" }),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) => updateTask(tx, "org_a", first.taskId, { status: "open" })),
  ).rejects.toMatchObject({ code: "OPPORTUNITY_HAS_TASK" })
  // Cerrar la oportunidad cierra sola su tarea, diciendo por qué.
  await withOrgContext(appDb, "org_a", (tx) =>
    closeOpportunity(tx, "org_a", opp.id, { outcome: "won", reason: "acepto" }, { userId: ACTOR_A }),
  )
  expect(await withOrgContext(appDb, "org_a", (tx) => getTask(tx, "org_a", second.id))).toMatchObject({
    status: "done", settledReason: "la oportunidad se ganó",
  })
  // Cerrada, no admite otra tarea.
  await expect(
    withOrgContext(appDb, "org_a", (tx) => createTask(tx, "org_a", { title: `Tarde ${TAG}`, opportunityId: opp.id, createdBy: "user" })),
  ).rejects.toThrow("se cerró")
})

it("conversaciones: las vistas «Por atender» y «Esperan al paciente» filtran en SQL antes de paginar", async () => {
  const prefix = `Vista ${TAG}`
  const cUn = await makeContact("org_a", `${prefix} Un`)
  const cOk = await makeContact("org_a", `${prefix} Ok`)
  const cQueued = await makeContact("org_a", `${prefix} Cola`)
  const convUn = await makeConversationDirect("org_a", cUn.id)
  const convOk = await makeConversationDirect("org_a", cOk.id)
  const convQueued = await makeConversationDirect("org_a", cQueued.id)
  const t0 = new Date("2026-09-20T10:00:00.000Z")
  const t1 = new Date("2026-09-20T11:00:00.000Z")
  const t2 = new Date("2026-09-20T12:00:00.000Z")
  await addMessage("org_a", convUn, { direction: "in", status: "received", createdAt: t1 })
  await addMessage("org_a", convOk, { direction: "in", status: "received", createdAt: t0 })
  await addMessage("org_a", convOk, {
    direction: "out",
    senderKind: "user",
    status: "delivered",
    createdAt: t2,
  })
  await addMessage("org_a", convQueued, { direction: "in", status: "received", createdAt: t1 })
  await addMessage("org_a", convQueued, {
    direction: "out",
    senderKind: "user",
    status: "queued",
    createdAt: t2,
  })
  // Lo que no salió pide a una persona, con el agente encendido en el hilo.
  const cFailed = await makeContact("org_a", `${prefix} Falló`)
  const convFailed = await makeConversationDirect("org_a", cFailed.id)
  await addMessage("org_a", convFailed, { direction: "in", status: "received", createdAt: t0 })
  await addMessage("org_a", convFailed, { direction: "out", senderKind: "agent", status: "sent", createdAt: t1 })
  await addMessage("org_a", convFailed, { direction: "out", senderKind: "agent", status: "failed", createdAt: t2 })
  // «Por atender» (ADR 0050): sin responder y sin el agente a cargo; un
  // saliente que sigue en cola todavía no es respuesta.
  await withOrgContext(appDb, "org_a", (tx) => setAgentStatus(tx, "org_a", convUn, false))
  await withOrgContext(appDb, "org_a", (tx) => setAgentStatus(tx, "org_a", convQueued, false))
  const attend = await withOrgContext(appDb, "org_a", (tx) =>
    listConversations(tx, "org_a", { view: "attend", q: prefix, limit: 100 }),
  )
  const unIds = attend.items.map((c) => c.id)
  expect(unIds).toContain(convUn)
  expect(unIds).toContain(convQueued)
  expect(unIds).toContain(convFailed)
  expect(unIds).not.toContain(convOk)
  // Esperan al paciente: una propuesta espera su sí, o se le respondió y no contesta;
  // un saliente que sigue en cola todavía no es respuesta.
  await ownerDb.insert(agentProposal).values({
    organizationId: "org_a",
    conversationId: convUn,
    contactId: cUn.id,
    action: "reservar_cita",
    status: "propuesta",
    payload: {},
    reason: "Propuesta de prueba",
    idempotencyKey: `vista-${TAG}-1`,
  })
  const approval = await withOrgContext(appDb, "org_a", (tx) =>
    listConversations(tx, "org_a", { view: "awaiting_patient", q: prefix, limit: 100 }),
  )
  // Con una propuesta que espera su sí, espera al paciente aunque el agente esté apagado.
  expect(approval.items.map((c) => c.id)).toContain(convUn)
  expect(approval.items.map((c) => c.id)).toContain(convOk)
  expect(approval.items.map((c) => c.id)).not.toContain(convQueued)
  expect(approval.items.map((c) => c.id)).not.toContain(convFailed)
  // Paginación recorre la vista sin duplicar ni colar otras.
  const paged: string[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await withOrgContext(appDb, "org_a", (tx) =>
      listConversations(tx, "org_a", { view: "attend", q: prefix, limit: 1, cursor }),
    )
    paged.push(...page.items.map((c) => c.id))
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  expect(new Set(paged).size).toBe(paged.length)
  expect(paged).toContain(convQueued)
  expect(paged).not.toContain(convOk)
})

it("mensajes: applyStatus registra el primer sent/delivered/read sin inventar histórico", async () => {
  const c = await makeContact("org_a", `Envío ${TAG}`)
  const conv = await makeConversationDirect("org_a", c.id)
  const ext = `ext-${TAG}`
  const [out] = await ownerDb
    .insert(message)
    .values({
      organizationId: "org_a",
      conversationId: conv,
      direction: "out",
      senderKind: "user",
      body: "Hola",
      status: "queued",
      externalId: ext,
    })
    .returning({ id: message.id })
  const before = await ownerDb
    .select({ sentAt: message.sentAt })
    .from(message)
    .where(and(eq(message.id, out!.id), eq(message.organizationId, "org_a")))
    .limit(1)
  expect(before[0]?.sentAt).toBeNull()
  await withOrgContext(appDb, "org_a", (tx) =>
    applyStatus(tx, "org_a", [{ externalMessageId: ext, status: "delivered" }]),
  )
  const after = await ownerDb
    .select({ sentAt: message.sentAt, status: message.status })
    .from(message)
    .where(and(eq(message.id, out!.id), eq(message.organizationId, "org_a")))
    .limit(1)
  expect(after[0]?.status).toBe("delivered")
  expect(after[0]?.sentAt).not.toBeNull()
  const firstSent = after[0]?.sentAt?.toISOString()
  await withOrgContext(appDb, "org_a", (tx) =>
    applyStatus(tx, "org_a", [{ externalMessageId: ext, status: "read" }]),
  )
  const kept = await ownerDb
    .select({ sentAt: message.sentAt })
    .from(message)
    .where(and(eq(message.id, out!.id), eq(message.organizationId, "org_a")))
    .limit(1)
  expect(kept[0]?.sentAt?.toISOString()).toBe(firstSent)
})

it("aislamiento: ningún dato CRM cruza de org", async () => {
  const a = await makeContact("org_a", `Aisla ${TAG} A`)
  const b = await makeContact("org_b", `Aisla ${TAG} B`)
  const oppB = await withOrgContext(appDb, "org_b", (tx) =>
    createOpportunity(tx, "org_b", { contactId: b.id, title: `Opp ${TAG}` }),
  )
  const listA = await withOrgContext(appDb, "org_a", (tx) =>
    listOpportunities(tx, "org_a", { contactId: b.id, limit: 10 }),
  )
  expect(listA.items).toEqual([])
  const tasksB = await withOrgContext(appDb, "org_b", (tx) =>
    createTask(tx, "org_b", { title: `T ${TAG}`, contactId: b.id, createdBy: "user" }),
  )
  const tasksA = await withOrgContext(appDb, "org_a", (tx) => listTasks(tx, "org_a", {}))
  expect(tasksA.map((t) => t.id)).not.toContain(tasksB.id)
  const convsB = await withOrgContext(appDb, "org_b", (tx) => listConversations(tx, "org_b", {}))
  expect(convsB.items.map((c) => c.contact.id)).not.toContain(a.id)
  expect(oppB.id).toBeTruthy()
  // Paciente de otra org no se vincula.
  const pB = await withOrgContext(appDb, "org_b", (tx) =>
    createPatient(tx, "org_b", ACTOR_B, { displayName: `Ficha ${TAG} B` }),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createOpportunity(tx, "org_a", { contactId: a.id, title: `Fuga ${TAG}`, patientId: pB.id }),
    ),
  ).rejects.toThrow()
})

it("cerrar: una sola forma, con motivos de una lista; reabrir vuelve al paso en que estaba", async () => {
  const person = await makeContact("org_a", `Cierre ${TAG}`)
  const pipe = await withOrgContext(appDb, "org_a", (tx) => ensureDefaultPipeline(tx, "org_a"))
  const budgetStage = pipe.stages.find((st) => st.moment === "presupuesto_enviado")!
  const decided = pipe.stages.find((st) => st.moment === "decidio")!
  const row = await withOrgContext(appDb, "org_a", (tx) => createOpportunity(tx, "org_a", { contactId: person.id, title: `Cierre ${TAG}` }))
  await withOrgContext(appDb, "org_a", (tx) => moveOpportunity(tx, "org_a", row.id, budgetStage.id, { userId: ACTOR_A }))
  // «Decidió» no se alcanza moviendo.
  await expect(withOrgContext(appDb, "org_a", (tx) => moveOpportunity(tx, "org_a", row.id, decided.id, { userId: ACTOR_A })))
    .rejects.toThrow("Ganada o Perdida")
  // Un motivo fuera de la lista, o uno que solo pone el sistema, se rechaza.
  for (const reason of ["Se mudó", "rechazo_presupuesto"]) {
    await expect(withOrgContext(appDb, "org_a", (tx) => closeOpportunity(tx, "org_a", row.id, { outcome: "lost", reason }, { userId: ACTOR_A })))
      .rejects.toMatchObject({ status: 400 })
  }
  const lost = await withOrgContext(appDb, "org_a", (tx) =>
    closeOpportunity(tx, "org_a", row.id, { outcome: "lost", reason: "otra_clinica", note: "Le quedaba más cerca" }, { userId: ACTOR_A }),
  )
  expect(lost).toMatchObject({ status: "lost", moment: "decidio", closeReason: "otra_clinica", closeNote: "Le quedaba más cerca", why: "Perdida: «Eligió otra clínica»" })
  const reopened = await withOrgContext(appDb, "org_a", (tx) => reopenOpportunity(tx, "org_a", row.id, { userId: ACTOR_A }))
  expect(reopened).toMatchObject({ status: "open", stageId: budgetStage.id, closeReason: null, closeNote: null })
  expect(reopened.history.map((h) => h.who)).toContain("Persona de prueba")
})

it("oportunidades: el cursor conserva filas con marcas distintas dentro del mismo milisegundo", async () => {
  const person = await makeContact("org_a", `Paginación de oportunidades ${TAG}`)
  const expected = new Set<string>()
  for (let index = 1; index <= 35; index += 1) {
    const row = await withOrgContext(appDb, "org_a", tx => createOpportunity(tx, "org_a", {
      contactId: person.id, title: `Interés ${index}`,
    }))
    expected.add(row.id)
    const at = `2026-10-20T15:30:00.${String(index).padStart(6, "0")}Z`
    await ownerDb.execute(sql`update opportunity set updated_at=${at}::timestamptz where id=${row.id}`)
  }
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await withOrgContext(appDb, "org_a", tx => listOpportunities(tx, "org_a", {
      contactId: person.id, limit: 10, cursor,
    }))
    for (const row of page.items) {
      expect(seen.has(row.id)).toBe(false)
      seen.add(row.id)
    }
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(seen).toEqual(expected)
})

it("tarea de una oportunidad: reprogramarla y que se cierre sola conservan transición y autor en actividad", async () => {
  const person = await makeContact("org_a", `Historia de la tarea ${TAG}`)
  const firstDue = "2026-11-10T15:00:00.000Z"
  const nextDue = "2026-11-12T16:30:00.000Z"
  const row = await withOrgContext(appDb, "org_a", tx => createOpportunity(tx, "org_a", {
    contactId: person.id, title: "Coordinar evaluación",
  }, { userId: ACTOR_A }))
  const created = await withOrgContext(appDb, "org_a", tx => setOpportunityTask(tx, "org_a", row.id, { title: "Llamar", dueAt: firstDue }, { userId: ACTOR_A, createdBy: "user" }))
  await withOrgContext(appDb, "org_a", tx => setOpportunityTask(tx, "org_a", row.id, { dueAt: nextDue }, { userId: ACTOR_A, createdBy: "user" }))
  await withOrgContext(appDb, "org_a", tx => closeOpportunity(tx, "org_a", row.id, {
    outcome: "lost", reason: "no_responde",
  }, { userId: ACTOR_A }))
  const updates = await ownerDb.select().from(auditEvent).where(and(
    eq(auditEvent.organizationId, "org_a"), eq(auditEvent.entityId, created.taskId), eq(auditEvent.action, "task.updated"),
  ))
  expect(updates.map(event => event.metadata)).toEqual([
    expect.objectContaining({ statusPrev: "open", statusNext: "open", dueAtPrev: firstDue, dueAtNext: nextDue }),
  ])
  expect(updates.every(event => event.actorUserId === ACTOR_A)).toBe(true)
  const settled = await ownerDb.select().from(auditEvent).where(and(
    eq(auditEvent.organizationId, "org_a"), eq(auditEvent.entityId, created.taskId), eq(auditEvent.action, "task.settled"),
  ))
  expect(settled).toHaveLength(1)
  expect(settled[0]?.actorUserId).toBeNull()
})

it("oportunidad legada: permite su tarea sin inventar representación y rechaza nuevos vínculos no verificados", async () => {
  const person = await makeContact("org_a", `Interlocutor legado ${TAG}`)
  const other = await makeContact("org_a", `Otro interlocutor ${TAG}`)
  const patient = await withOrgContext(appDb, "org_a", tx => createPatient(tx, "org_a", ACTOR_A, {
    displayName: `Paciente legado ${TAG}`,
  }))
  const row = await withOrgContext(appDb, "org_a", tx => createOpportunity(tx, "org_a", {
    contactId: person.id, title: "Registro anterior a la validación del vínculo",
  }))
  await ownerDb.update(opportunity).set({ patientId: patient.id }).where(eq(opportunity.id, row.id))
  const edited = await withOrgContext(appDb, "org_a", tx => updateOpportunity(tx, "org_a", row.id, {
    title: "Llamar para revisar representación", patientId: patient.id,
  }))
  expect(edited).toMatchObject({ patientId: patient.id, title: "Llamar para revisar representación" })
  await withOrgContext(appDb, "org_a", tx => setOpportunityTask(tx, "org_a", row.id, { dueAt: "2026-11-15T15:00:00.000Z" }, { userId: null, createdBy: "user" }))
  const links = await ownerDb.select().from(patientContact).where(and(
    eq(patientContact.patientId, patient.id), eq(patientContact.contactId, person.id),
  ))
  expect(links).toEqual([])
  await expect(withOrgContext(appDb, "org_a", tx => updateOpportunity(tx, "org_a", row.id, {
    contactId: other.id,
  }))).rejects.toMatchObject({ code: "VALIDATION" })
})

