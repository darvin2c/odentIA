import { eq, sql } from "drizzle-orm"
import { withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import {
  patient,
  patientContact,
  treatmentBudget,
  treatmentPlan,
} from "@odentia/db/schema/clinical"
import { crmTask, message } from "@odentia/db/schema/crm"
import { agentHandoff, agentProposal } from "@odentia/db/schema/agent"
import { auditEvent } from "@odentia/db/schema/org"
import { crmNote } from "@odentia/db/schema/crm-workspace"
import { expect, it } from "vitest"
import { upsertAgentConfig } from "./agentConfig.js"
import { addContactIdentity, createContact, getContact } from "./contacts.js"
import { createConnection } from "./connections.js"
import { closeConversation } from "./conversation-close.js"
import { startContactConversation } from "./conversations.js"
import {
  createContactNote,
  getContactWorkspace,
  listBudgetOptionsForContactPatient,
  listBudgetOptionsForOpportunity,
  listContactActivity,
  listContactNotes,
  type CrmCapabilities,
} from "./crm-workspace.js"
import { ServiceError } from "./errors.js"
import { createOpportunity, moveOpportunity } from "./opportunities.js"
import { ensureDefaultPipeline } from "./pipelines.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { createTask } from "./tasks.js"
import { appDb, ownerDb, retireWhatsApp, setupTestDb } from "./test-setup.js"

setupTestDb()
const KEY = secretsKeyFromEnv("ee".repeat(32))
const FULL: CrmCapabilities = { conversations: true, tasks: true, agent: true }
const NONE: CrmCapabilities = { conversations: false, tasks: false, agent: false }

let seq = 0
function tag(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError)
    expect((e as ServiceError).code).toBe(code)
    return
  }
  throw new Error(`Se esperaba error ${code}`)
}

async function makeContact(orgId: string, name: string): Promise<string> {
  return withOrgContext(appDb, orgId, async (tx) => {
    const created = await createContact(tx, orgId, { displayName: name })
    return created.id
  })
}

async function makeConversation(orgId: string, contactId: string): Promise<string> {
  return withOrgContext(appDb, orgId, async (tx) => {
    await retireWhatsApp(orgId)
    const connection = await createConnection(
      tx,
      orgId,
      KEY,
      {
        channel: "whatsapp",
        provider: "whatsapp_cloud_api",
        displayName: "WA",
        config: { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S", templates: [] },
      },
      { fetch, validateExternal: false },
    )
    seq += 1
    const identity = await addContactIdentity(tx, orgId, null, contactId, {
      channel: "whatsapp",
      externalUserId: `987${String(100000 + seq)}`,
    })
    const started = await startContactConversation(tx, orgId, null, contactId, {
      identityId: identity.id,
      connectionId: connection.id,
    })
    return started.id
  })
}

async function makeOpportunity(orgId: string, contactId: string, patientId?: string): Promise<string> {
  return withOrgContext(appDb, orgId, async (tx) => {
    const { stages } = await ensureDefaultPipeline(tx, orgId)
    const open = stages.filter((s) => s.kind === "open")
    const created = await createOpportunity(
      tx,
      orgId,
      { contactId, patientId: patientId ?? null, stageId: open[0]!.id, title: tag("Oportunidad") },
      { userId: null },
    )
    return created.id
  })
}

it("notas: crea con vínculos, rechaza cruces y aparece en el timeline", async () => {
  const contactId = await makeContact("org_a", tag("Contacto notas"))
  const otherId = await makeContact("org_a", tag("Contacto otro"))
  const convId = await makeConversation("org_a", contactId)
  const otherConv = await makeConversation("org_a", otherId)
  const oppId = await makeOpportunity("org_a", contactId)
  const otherOpp = await makeOpportunity("org_a", otherId)

  const note = await withOrgContext(appDb, "org_a", (tx) =>
    createContactNote(
      tx,
      "org_a",
      contactId,
      { body: "Llamar mañana a primera hora", conversationId: convId, opportunityId: oppId },
      { userId: null },
    ),
  )
  expect(note.kind).toBe("note")
  expect(note.body).toBe("Llamar mañana a primera hora")
  expect(note.conversationId).toBe(convId)
  expect(note.opportunityId).toBe(oppId)

  // Invariantes de vínculo: nada de otro contacto entra al timeline propio.
  await withOrgContext(appDb, "org_a", (tx) =>
    expectCode(
      createContactNote(tx, "org_a", contactId, { body: "x", conversationId: otherConv }, { userId: null }),
      "VALIDATION",
    ),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    expectCode(
      createContactNote(tx, "org_a", contactId, { body: "x", opportunityId: otherOpp }, { userId: null }),
      "VALIDATION",
    ),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    expectCode(createContactNote(tx, "org_a", contactId, { body: "   " }, { userId: null }), "VALIDATION"),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    expectCode(
      createContactNote(tx, "org_a", "00000000-0000-0000-0000-000000000000", { body: "x" }, { userId: null }),
      "NOT_FOUND",
    ),
  )

  const { items } = await withOrgContext(appDb, "org_a", (tx) =>
    listContactActivity(tx, "org_a", contactId, { capabilities: FULL }),
  )
  expect(items.some((i) => i.id === note.id && i.kind === "note")).toBe(true)
})

it("notas: append-only, no pisan el campo libre del contacto", async () => {
  const contactId = await makeContact("org_a", tag("Contacto append"))
  await withOrgContext(appDb, "org_a", (tx) =>
    createContactNote(tx, "org_a", contactId, { body: "Primera nota" }, { userId: null }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    createContactNote(tx, "org_a", contactId, { body: "Segunda nota" }, { userId: null }),
  )
  const { items } = await withOrgContext(appDb, "org_a", (tx) =>
    listContactActivity(tx, "org_a", contactId, { capabilities: FULL }),
  )
  const notes = items.filter((i) => i.kind === "note")
  expect(notes).toHaveLength(2)
  expect(new Set(notes.map((n) => n.body))).toEqual(new Set(["Primera nota", "Segunda nota"]))
  const full = await withOrgContext(appDb, "org_a", (tx) => getContact(tx, "org_a", contactId))
  expect(full.contact.notes).toBeNull()
})

it("timeline: keyset por contacto y capacidades, sin fugas entre contactos ni orgs", async () => {
  const mine = await makeContact("org_a", tag("Contacto keyset"))
  const alien = await makeContact("org_a", tag("Contacto ajeno"))
  const base = Date.now()
  await withOrgContext(appDb, "org_a", async (tx) => {
    for (let i = 0; i < 5; i += 1) {
      await tx.insert(crmNote).values({
        organizationId: "org_a",
        contactId: mine,
        body: `Nota ${i}`,
        createdAt: new Date(base + i * 1000),
      })
    }
    await tx.insert(crmNote).values({
      organizationId: "org_a",
      contactId: alien,
      body: "Nota ajena",
      createdAt: new Date(base + 999_000),
    })
  })
  // Aislamiento por contacto: la nota ajena (más reciente) no aparece.
  const first = await withOrgContext(appDb, "org_a", (tx) =>
    listContactActivity(tx, "org_a", mine, { limit: 2, capabilities: FULL }),
  )
  expect(first.items).toHaveLength(2)
  expect(first.items.every((i) => i.body !== "Nota ajena")).toBe(true)
  expect(first.nextCursor).not.toBeNull()

  // Paginación completa sin duplicados ni pérdidas.
  const seen = new Map<string, string | null>()
  let cursor: string | null = first.nextCursor
  for (const item of first.items) seen.set(item.id, item.body)
  for (let page = 0; page < 4 && cursor; page += 1) {
    const current = cursor
    const res = await withOrgContext(appDb, "org_a", (tx) =>
      listContactActivity(tx, "org_a", mine, { limit: 2, cursor: current, capabilities: FULL }),
    )
    for (const item of res.items) {
      expect(seen.has(item.id)).toBe(false)
      seen.set(item.id, item.body)
    }
    cursor = res.nextCursor
  }
  expect(cursor).toBeNull()
  expect(seen.size).toBe(5)

  // El cursor no vale con otras capacidades ni es reutilizable entre contactos.
  await withOrgContext(appDb, "org_a", (tx) =>
    expectCode(
      listContactActivity(tx, "org_a", mine, { cursor: first.nextCursor!, capabilities: NONE }),
      "VALIDATION",
    ),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    expectCode(
      listContactActivity(tx, "org_a", alien, { cursor: first.nextCursor!, capabilities: FULL }),
      "VALIDATION",
    ),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    expectCode(listContactActivity(tx, "org_a", mine, { cursor: "no-es-cursor", capabilities: FULL }), "VALIDATION"),
  )

  // Aislamiento entre organizaciones: el contacto no existe en otra org.
  await withOrgContext(appDb, "org_b", (tx) =>
    expectCode(listContactActivity(tx, "org_b", mine, { capabilities: FULL }), "NOT_FOUND"),
  )
})
it("timeline: 75 notas del mismo milisegundo con microsegundos distintos no pierden ninguna", async () => {
  const contactId = await makeContact("org_a", tag("Contacto micro"))
  // Mismo milisegundo, microsegundos 000001..000075: Date/toISOString los
  // truncaría y el keyset por ms omitiría filas.
  await withOrgContext(appDb, "org_a", async (tx) => {
    for (let i = 1; i <= 75; i += 1) {
      const micros = `2026-03-01T10:00:00.${String(i).padStart(6, "0")}Z`
      await tx.execute(
        sql`insert into "crm_note" ("organization_id", "contact_id", "body", "created_at") values (${"org_a"}, ${contactId}, ${`Micro ${i}`}, ${micros}::timestamptz)`,
      )
    }
  })
  const seen = new Set<string>()
  let cursor: string | null = null
  let pages = 0
  do {
    const res = await withOrgContext(appDb, "org_a", (tx) =>
      listContactActivity(tx, "org_a", contactId, { limit: 30, cursor: cursor ?? undefined, capabilities: FULL }),
    )
    pages += 1
    for (const item of res.items) {
      expect(seen.has(item.id)).toBe(false)
      seen.add(item.id)
      expect(item.kind).toBe("note")
    }
    cursor = res.nextCursor
  } while (cursor !== null && pages < 10)
  expect(cursor).toBeNull()
  expect(seen.size).toBe(75)
})

it("contexto del agente: notas paginadas con precisión y sin mezclar interlocutores ni organizaciones", async () => {
  const mine = await makeContact("org_a", tag("Notas del caso"))
  const other = await makeContact("org_a", tag("Otro interlocutor"))
  await withOrgContext(appDb, "org_a", async tx => {
    await tx.execute(sql`insert into crm_note (organization_id, contact_id, body, created_at) values
      ('org_a', ${mine}, 'Anterior', '2026-03-01T10:00:00.000001Z'),
      ('org_a', ${mine}, 'Reciente', '2026-03-01T10:00:00.000002Z'),
      ('org_a', ${other}, 'Ajena', '2026-03-01T10:00:00.000003Z')`)
  })
  const first = await withOrgContext(appDb, "org_a", tx =>
    listContactNotes(tx, "org_a", mine, { limit: 1 }))
  expect(first.items.map(n => n.body)).toEqual(["Reciente"])
  const second = await withOrgContext(appDb, "org_a", tx =>
    listContactNotes(tx, "org_a", mine, { limit: 1, cursor: first.nextCursor! }))
  expect(second.items.map(n => n.body)).toEqual(["Anterior"])
  expect(second.nextCursor).toBeNull()
  await withOrgContext(appDb, "org_a", tx =>
    expectCode(listContactNotes(tx, "org_a", other, { cursor: first.nextCursor! }), "VALIDATION"))
  await withOrgContext(appDb, "org_b", tx =>
    expectCode(listContactNotes(tx, "org_b", mine), "NOT_FOUND"))
})

it("notas: el rol app no puede editar ni borrar; otra org no las ve", async () => {
  const contactId = await makeContact("org_a", tag("Contacto inmutable"))
  await withOrgContext(appDb, "org_a", (tx) =>
    createContactNote(tx, "org_a", contactId, { body: "No tocar" }, { userId: null }),
  )
  // La migración revoca UPDATE/DELETE al rol app: ambos deben fallar.
  await expect(withOrgContext(appDb, "org_a", tx =>
    tx.update(crmNote).set({ body: "Editada" }).where(eq(crmNote.contactId, contactId)),
  )).rejects.toThrow()
  await expect(withOrgContext(appDb, "org_a", tx =>
    tx.delete(crmNote).where(eq(crmNote.contactId, contactId)),
  )).rejects.toThrow()
  const after = await withOrgContext(appDb, "org_a", (tx) =>
    listContactActivity(tx, "org_a", contactId, { capabilities: FULL }),
  )
  expect(after.items.filter((i) => i.kind === "note").map((i) => i.body)).toEqual(["No tocar"])
  // RLS por organización: desde otra org no hay filas visibles.
  const alien = await withOrgContext(appDb, "org_b", (tx) =>
    tx.select().from(crmNote).where(eq(crmNote.organizationId, "org_a")),
  )
  expect(alien).toEqual([])
})
it("timeline: la transición nueva de una tarea vieja aparece aunque su creación quede fuera de la primera página", async () => {
  const contactId = await makeContact("org_a", tag("Contacto transiciones"))
  // Tres tareas con creación lejana entre sí.
  const taskIds = await withOrgContext(appDb, "org_a", async (tx) => {
    const out: string[] = []
    for (const stamp of ["2026-01-05T10:00:00Z", "2026-02-05T10:00:00Z", "2026-03-05T10:00:00Z"]) {
      const [row] = await tx
        .insert(crmTask)
        .values({
          organizationId: "org_a",
          contactId,
          title: `Seguimiento ${stamp.slice(5, 7)}`,
          status: "open",
          createdBy: "user",
          createdAt: new Date(stamp),
          updatedAt: new Date(stamp),
        })
        .returning({ id: crmTask.id })
      out.push(row!.id)
    }
    return out
  })
  // Transición nueva con formato del dominio sobre la tarea más vieja.
  await withOrgContext(appDb, "org_a", (tx) =>
    tx.insert(auditEvent).values({
      organizationId: "org_a",
      actorUserId: null,
      action: "task.updated",
      entity: "task",
      entityId: taskIds[0],
      metadata: {
        title: "Seguimiento 01",
        statusPrev: "open",
        statusNext: "done",
        dueAtPrev: null,
        dueAtNext: null,
        contactId,
        conversationId: null,
        opportunityId: null,
      },
    }),
  )
  // La transición (ahora) encabeza la primera página aunque su creación sea la más vieja.
  const first = await withOrgContext(appDb, "org_a", (tx) =>
    listContactActivity(tx, "org_a", contactId, { limit: 2, capabilities: FULL }),
  )
  expect(first.items).toHaveLength(2)
  expect(first.nextCursor).not.toBeNull()
  const transition = first.items.find((i) => i.id.startsWith("task-audit:"))
  expect(transition).toMatchObject({
    kind: "task",
    taskId: taskIds[0],
    status: "done",
    title: "Tarea completada: Seguimiento 01",
  })
  // Recorrido completo: 3 creaciones (status null, sin estado inventado) + 1 transición, sin duplicados.
  const seen = new Map(first.items.map((i) => [i.id, i]))
  let cursor: string | null = first.nextCursor
  while (cursor !== null) {
    const current = cursor
    const res = await withOrgContext(appDb, "org_a", (tx) =>
      listContactActivity(tx, "org_a", contactId, { limit: 2, cursor: current, capabilities: FULL }),
    )
    for (const item of res.items) {
      expect(seen.has(item.id)).toBe(false)
      seen.set(item.id, item)
    }
    cursor = res.nextCursor
  }
  const tasks = [...seen.values()].filter((i) => i.kind === "task")
  expect(tasks).toHaveLength(4)
  const creations = tasks.filter((i) => i.id.startsWith("task:"))
  expect(creations).toHaveLength(3)
  for (const item of creations) {
    expect(item.title.startsWith("Tarea creada: ")).toBe(true)
    expect(item.body).toBe("Creación de tarea")
    expect(item.status).toBeNull()
  }
})

it("timeline: reúne mensajes, tareas, oportunidad, propuesta y derivación según permisos", async () => {
  const contactId = await makeContact("org_a", tag("Contacto fuentes"))
  const convId = await makeConversation("org_a", contactId)
  const task = await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", { title: "Seguimiento", contactId, createdBy: "user" }),
  )
  const oppId = await makeOpportunity("org_a", contactId)
  await withOrgContext(appDb, "org_a", async (tx) => {
    const { stages } = await ensureDefaultPipeline(tx, "org_a")
    const second = stages.filter((s) => s.kind === "open")[1] ?? stages[0]!
    await moveOpportunity(tx, "org_a", oppId, second.id, { userId: null })
  })
  const at = new Date()
  await withOrgContext(appDb, "org_a", async (tx) => {
    await tx.insert(message).values({
      organizationId: "org_a",
      conversationId: convId,
      direction: "in",
      senderKind: "contact",
      body: "Hola, quiero info",
      createdAt: at,
    })
    await tx.insert(agentProposal).values({
      organizationId: "org_a",
      conversationId: convId,
      contactId,
      action: "reservar_cita",
      payload: {},
      reason: "El contacto pide cita",
      idempotencyKey: tag("prop"),
    })
    await tx.insert(agentHandoff).values({
      organizationId: "org_a",
      conversationId: convId,
      contactId,
      reason: "Pide hablar con una persona",
      summary: "Derivación solicitada",
      taskId: task.id,
    })
  })
  const full = await withOrgContext(appDb, "org_a", (tx) =>
    listContactActivity(tx, "org_a", contactId, { limit: 50, capabilities: FULL }),
  )
  const kinds = new Set(full.items.map((i) => i.kind))
  for (const expected of ["message", "task", "opportunity", "proposal", "handoff"] as const) {
    expect(kinds.has(expected)).toBe(true)
  }
  const msg = full.items.find((i) => i.kind === "message")!
  expect(msg.channel).toBe("whatsapp")
  expect(msg.title).toBe("Mensaje entrante")
  expect(msg.conversationId).toBe(convId)
  const opp = full.items.find((i) => i.kind === "opportunity")!
  expect(opp.opportunityId).toBe(oppId)

  // Sin capabilities no hay mensajes, tareas, propuestas ni derivaciones.
  const blind = await withOrgContext(appDb, "org_a", (tx) =>
    listContactActivity(tx, "org_a", contactId, { limit: 50, capabilities: NONE }),
  )
  expect(blind.items.some((i) => i.kind === "message")).toBe(false)
  expect(blind.items.some((i) => i.kind === "task")).toBe(false)
  expect(blind.items.some((i) => i.kind === "proposal")).toBe(false)
  expect(blind.items.some((i) => i.kind === "handoff")).toBe(false)
  expect(blind.items.some((i) => i.kind === "opportunity")).toBe(true)

  // Sin agent.read la propuesta no aparece en el timeline.
  const noAgent = await withOrgContext(appDb, "org_a", (tx) =>
    listContactActivity(tx, "org_a", contactId, {
      limit: 50,
      capabilities: { ...FULL, agent: false },
    }),
  )
  expect(noAgent.items.some((i) => i.kind === "proposal")).toBe(false)
  expect(noAgent.items.some((i) => i.kind === "handoff")).toBe(true)
})

it("contexto: workspace con estado del agente verdadero y capacidades", async () => {
  const contactId = await makeContact("org_a", tag("Contacto contexto"))
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { enabled: true }))

  // Sin conversación: humano con nulos, sin fingir atención.
  const empty = await withOrgContext(appDb, "org_a", (tx) =>
    getContactWorkspace(tx, "org_a", contactId, { capabilities: FULL }),
  )
  expect(empty.contact.contact.id).toBe(contactId)
  expect(empty.agent).toMatchObject({ state: "human", conversationId: null, enabled: true })
  expect(empty.agent.pendingProposalIds).toEqual([])

  const convId = await makeConversation("org_a", contactId)
  await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", { title: "Llamar", contactId, createdBy: "user" }),
  )
  await makeOpportunity("org_a", contactId)

  const active = await withOrgContext(appDb, "org_a", (tx) =>
    getContactWorkspace(tx, "org_a", contactId, { capabilities: FULL }),
  )
  expect(active.agent).toMatchObject({ state: "agent", conversationId: convId, enabled: true })
  expect(active.opportunities.items).toHaveLength(1)
  expect(active.tasks).toHaveLength(1)
  expect(active.tasks[0]).toMatchObject({ kind: "manual", status: "open", contactId })
  expect(active.tasks[0]?.contactName).toBe(active.contact.contact.displayName)
  expect(active.activity.items.length).toBeGreaterThan(0)

  // Sin permiso de tareas ni conversaciones, esos bloques se vacían,
  // incluido el detalle heredado y el estado de hilos del agente.
  const restricted = await withOrgContext(appDb, "org_a", (tx) =>
    getContactWorkspace(tx, "org_a", contactId, { capabilities: NONE }),
  )
  expect(restricted.tasks).toEqual([])
  expect(restricted.activity.items.some((i) => i.kind === "message")).toBe(false)
  expect(restricted.contact.openTasks).toEqual([])
  expect(restricted.contact.conversations).toEqual([])
  expect(restricted.contact.identities).toEqual([])
  expect(restricted.agent).toMatchObject({
    state: "human",
    conversationId: null,
    reason: "Sin acceso a conversaciones",
  })

  // Propuesta pendiente: estado de aprobación con ids solo si hay permiso.
  await withOrgContext(appDb, "org_a", (tx) =>
    tx.insert(agentProposal).values({
      organizationId: "org_a",
      conversationId: convId,
      contactId,
      action: "reservar_cita",
      payload: {},
      idempotencyKey: tag("prop"),
    }),
  )
  const approval = await withOrgContext(appDb, "org_a", (tx) =>
    getContactWorkspace(tx, "org_a", contactId, { capabilities: FULL }),
  )
  expect(approval.agent.state).toBe("approval")
  expect(approval.agent.pendingProposalIds).toHaveLength(1)
  const approvalBlind = await withOrgContext(appDb, "org_a", (tx) =>
    getContactWorkspace(tx, "org_a", contactId, {
      capabilities: { ...FULL, agent: false },
    }),
  )
  expect(approvalBlind.agent.state).toBe("approval")
  expect(approvalBlind.agent.pendingProposalIds).toEqual([])

  // Conversación ajena y cerrada: validación y estado real.
  const other = await makeContact("org_a", tag("Contacto contexto otro"))
  const otherConv = await makeConversation("org_a", other)
  await withOrgContext(appDb, "org_a", (tx) =>
    expectCode(
      getContactWorkspace(tx, "org_a", contactId, {
        conversationId: otherConv,
        capabilities: FULL,
      }),
      "VALIDATION",
    ),
  )
  await withOrgContext(appDb, "org_a", (tx) => closeConversation(tx, "org_a", otherConv))
  const closed = await withOrgContext(appDb, "org_a", (tx) =>
    getContactWorkspace(tx, "org_a", other, {
      conversationId: otherConv,
      capabilities: FULL,
    }),
  )
  expect(closed.agent).toMatchObject({ state: "closed", conversationId: otherConv })
})

it("nota: registra el nombre del autor miembro sin fugar otras orgs", async () => {
  const uid = tag("user")
  await ownerDb.insert(user).values({ id: uid, name: "Recepción Norte", email: `${uid}@example.com` })
  await ownerDb
    .insert(member)
    .values({ id: tag("member"), organizationId: "org_a", userId: uid, role: "reception", createdAt: new Date() })
  const contactId = await makeContact("org_a", tag("Contacto autor"))
  const note = await withOrgContext(appDb, "org_a", (tx) =>
    createContactNote(tx, "org_a", contactId, { body: "Nota firmada" }, { userId: uid }),
  )
  expect(note.actorName).toBe("Recepción Norte")
})

async function makePatientSetup(orgId: string, contactId: string, n: number) {
  return withOrgContext(appDb, orgId, async (tx) => {
    const [p] = await tx
      .insert(patient)
      .values({ organizationId: orgId, displayName: tag("Paciente"), patientNumber: n })
      .returning()
    await tx.insert(patientContact).values({
      organizationId: orgId,
      patientId: p!.id,
      contactId,
      relationship: "family",
    })
    const [plan] = await tx
      .insert(treatmentPlan)
      .values({ organizationId: orgId, patientId: p!.id, title: "Plan inicial" })
      .returning()
    const statuses = ["presentado", "aceptado", "borrador", "cancelado"]
    for (let i = 0; i < statuses.length; i += 1) {
      await tx.insert(treatmentBudget).values({
        organizationId: orgId,
        patientId: p!.id,
        planId: plan!.id,
        budgetNumber: 100 + i,
        title: `Presupuesto ${statuses[i]}`,
        currency: "PEN",
        status: statuses[i]!,
      })
    }
    return p!.id
  })
}

it("presupuestos mínimos: solo presentados/decididos, sin importes, con vínculo verificado", async () => {
  const contactId = await makeContact("org_a", tag("Contacto presupuesto"))
  const patientId = await makePatientSetup("org_a", contactId, 710001 + seq)
  const oppId = await makeOpportunity("org_a", contactId, patientId)

  const visible = await withOrgContext(appDb, "org_a", (tx) =>
    listBudgetOptionsForOpportunity(tx, "org_a", oppId, { includeDrafts: false }),
  )
  expect(visible.map((b) => b.status).sort()).toEqual(["aceptado", "presentado"])
  for (const option of visible) {
    expect(Object.keys(option).sort()).toEqual(["id", "status", "title"])
  }
  const withDrafts = await withOrgContext(appDb, "org_a", (tx) =>
    listBudgetOptionsForOpportunity(tx, "org_a", oppId, { includeDrafts: true }),
  )
  expect(withDrafts.map((b) => b.status).sort()).toEqual(["aceptado", "borrador", "presentado"])

  const byPatient = await withOrgContext(appDb, "org_a", (tx) =>
    listBudgetOptionsForContactPatient(tx, "org_a", contactId, patientId, { includeDrafts: false }),
  )
  expect(byPatient).toHaveLength(2)

  // Oportunidad sin paciente y paciente no vinculado: error, no lista vacía silenciosa.
  const bareOpp = await makeOpportunity("org_a", contactId)
  await withOrgContext(appDb, "org_a", (tx) =>
    expectCode(listBudgetOptionsForOpportunity(tx, "org_a", bareOpp, { includeDrafts: false }), "VALIDATION"),
  )
  const stranger = await makeContact("org_a", tag("Contacto extraño"))
  await withOrgContext(appDb, "org_a", (tx) =>
    expectCode(
      listBudgetOptionsForContactPatient(tx, "org_a", stranger, patientId, { includeDrafts: false }),
      "VALIDATION",
    ),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    expectCode(
      listBudgetOptionsForOpportunity(tx, "org_a", "00000000-0000-0000-0000-000000000000", {
        includeDrafts: false,
      }),
      "NOT_FOUND",
    ),
  )
})
