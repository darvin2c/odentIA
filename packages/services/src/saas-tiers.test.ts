import { randomUUID } from "node:crypto"
import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { withOrgContext } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { agentProposal } from "@odentia/db/schema/agent"
import { automationJob } from "@odentia/db/schema/automation"
import {
  encounter,
  encounterDictationSuggestion,
  patientContact,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { conversation } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { reportQuestion } from "@odentia/db/schema/reports"
import {
  saasAction,
  saasPlan,
  saasSubscription,
  storageUsageDay,
} from "@odentia/db/schema/saas-billing"
import { and, eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { recordAgentRun } from "./agent-operations.js"
import { upsertAgentConfig } from "./agentConfig.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createConnection } from "./connections.js"
import { type IngestDeps, ingestInbound } from "./conversations.js"
import { finalizeEncounter } from "./encounters.js"
import {
  consultationTierOf,
  currentSaasPeriod,
  listPeriodActions,
  refreshConversationTier,
  STORAGE_GB_BYTES,
} from "./saas-actions.js"
import {
  addArgosPack,
  countStorageAction,
  ensureArgosQuestion,
  getArgosAllowance,
  setArgosAutoPack,
  storageDayOf,
} from "./saas-included.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/** Cobro por tipo (ADR 0085): qué tipo es cada acción, Argos con preguntas incluidas y el almacenamiento. */
setupTestDb()
const ORG = "org_a"
const KEY = secretsKeyFromEnv("cd".repeat(32))
const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, ORG, fn)
const HOUR = 3_600_000
const DAY = 24 * HOUR

const unused = async (): Promise<never> => {
  throw new Error("no usado")
}
const storage: Storage = {
  putAvatar: unused,
  deleteByUrl: async () => {},
  putAttachment: unused,
  attachmentUrl: async (key) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: unused,
  putPatientAvatar: unused,
}
const deps: IngestDeps = { storage, fetch, secretsKey: KEY }
const adapter: ChannelAdapter = {
  provider: "telegram_bot_api",
  capabilities: {
    templates: false,
    media: false,
    interactive: false,
    readReceipts: false,
    edit: true,
  },
  verifyWebhook: () => true,
  parseWebhook: () => ({ messages: [], statuses: [] }),
  sendMessage: async () => ({ externalId: "x" }),
  validateConnection: async () => ({ externalId: "bot", displayName: "Bot" }),
}
let connectionId: string

async function inbound(sender: string): Promise<string> {
  const event: NormalizedInbound = {
    externalEventId: randomUUID(),
    externalMessageId: randomUUID(),
    externalThreadId: sender,
    senderExternalId: sender,
    senderDisplayName: "Lucía Ramos",
    content: { type: "text", text: "Hola" },
    sentAt: new Date().toISOString(),
  }
  return (await run((tx) => ingestInbound(tx, { orgId: ORG, connectionId, event }, adapter, deps)))
    .conversationId
}

const ran = (conversationId: string, at: Date) =>
  run((tx) =>
    recordAgentRun(tx, ORG, {
      conversationId,
      model: "gpt-6-luna",
      status: "ok",
      startedAt: at,
      llmCalls: 1,
    }),
  )

const actionsOf = (kind: string) =>
  run((tx) =>
    tx
      .select()
      .from(saasAction)
      .where(and(eq(saasAction.organizationId, ORG), eq(saasAction.kind, kind))),
  )

/** Sofi reservó, movió o canceló una cita en esa conversación. */
async function executed(conversationId: string, action: string, at: Date) {
  const [conv] = await ownerDb
    .select({ contactId: conversation.contactId })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
  await ownerDb.insert(agentProposal).values({
    organizationId: ORG,
    conversationId,
    contactId: conv!.contactId,
    action,
    status: "ejecutada",
    payload: {},
    idempotencyKey: randomUUID(),
    executedAt: at,
  })
  return conv!.contactId
}

beforeAll(async () => {
  // Los precios del lienzo «Cobro por tipo», con un 10 % negociado para la clínica.
  await ownerDb.insert(saasPlan).values({
    code: "odentia-prueba-tipos",
    name: "Plan odentIA",
    currency: "USD",
    priceCents: 2900,
    creditCents: 2900,
    conversationInformMicros: 100_000,
    conversationMicros: 500_000,
    conversationAgendaMicros: 1_000_000,
    consultationSimpleMicros: 100_000,
    consultationStandardMicros: 200_000,
    consultationMicros: 500_000,
    recoveryMicros: 2_000_000,
    argosIncludedQuestions: 3,
    argosPackQuestions: 2,
    argosPackMicros: 3_000_000,
    storageIncludedGb: 20,
    storageGbMicros: 200_000,
    fixedPriceTiers: ["informa", "simple", "estandar", "preguntas"],
    trialCreditCents: 5000,
    trialMaxCreditCents: 13000,
    isDefault: true,
  })
  const period = {
    status: "activa",
    discountBps: 1000,
    currentPeriodStart: new Date(Date.now() - 10 * DAY),
    currentPeriodEnd: new Date(Date.now() + 20 * DAY),
  }
  await ownerDb
    .insert(saasSubscription)
    .values({ organizationId: ORG, ...period })
    .onConflictDoUpdate({ target: saasSubscription.organizationId, set: period })
  connectionId = (
    await run((tx) =>
      createConnection(
        tx,
        ORG,
        KEY,
        {
          channel: "telegram",
          provider: "telegram_bot_api",
          displayName: "Bot",
          config: { botToken: "T" },
        },
        { fetch, validateExternal: false },
      ),
    )
  ).id
})

describe("Sofi, según lo que pasó en la agenda", () => {
  it("«Informa» a su precio fijo y sube a «Gestiona» si después reserva en la misma ventana", async () => {
    const conv = await inbound("tg:informa")
    const start = new Date(Date.now() - 5 * HOUR)
    await ran(conv, start)
    const [first] = (await actionsOf("conversacion")).filter((row) => row.conversationId === conv)
    // Informa no admite descuento: siempre USD 0,10.
    expect(first).toMatchObject({
      tier: "informa",
      basePriceMicros: 100_000,
      priceMicros: 100_000,
      discountBps: 0,
    })
    // Una hora después Sofi reservó: la conversación pasa a Gestiona, con el 10 % negociado.
    const contactId = await executed(conv, "reservar_cita", new Date(start.getTime() + HOUR))
    await run((tx) =>
      refreshConversationTier(tx, ORG, { contactId, at: new Date(start.getTime() + HOUR) }),
    )
    const [upgraded] = (await actionsOf("conversacion")).filter(
      (row) => row.conversationId === conv,
    )
    expect(upgraded).toMatchObject({
      id: first!.id,
      tier: "gestiona",
      basePriceMicros: 500_000,
      priceMicros: 450_000,
      discountBps: 1000,
    })
    expect(upgraded?.detail).toContain("gestionó una cita")
  })

  it("nace «Gestiona» si Sofi ya movió la agenda, y la propuesta solo informativa no cuenta", async () => {
    const conv = await inbound("tg:gestiona")
    const start = new Date(Date.now() - 3 * HOUR)
    await executed(conv, "enviar_mensaje", start)
    await executed(conv, "cancelar_cita", new Date(start.getTime() + 10 * 60_000))
    await ran(conv, start)
    const [row] = (await actionsOf("conversacion")).filter((item) => item.conversationId === conv)
    expect(row).toMatchObject({ tier: "gestiona" })
  })

  it("la madre reservó desde el enlace para su hijo: su conversación pasa a «Gestiona»", async () => {
    const conv = await inbound("tg:madre-enlace")
    const start = new Date(Date.now() - 2 * HOUR)
    await ran(conv, start)
    const [mother] = await ownerDb.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conv))
    const fx = await clinicalFixture()
    const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: `Sede ${randomUUID().slice(0, 6)}` }).returning()
    const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: ORG, branchId: site!.id, name: "Unidad dental" }).returning()
    const startsAt = new Date(Date.now() + 3 * DAY)
    // La cita es del hijo; el enlace lo abrió la madre desde su conversación.
    await ownerDb.insert(appointment).values({
      organizationId: ORG, branchId: site!.id, roomId: room!.id, professionalUserId: fx.actor, patientId: fx.patient.id,
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status: "programada", source: "enlace",
      conversationId: conv, createdAt: new Date(start.getTime() + HOUR),
    })
    await run((tx) => refreshConversationTier(tx, ORG, { contactId: mother!.contactId, at: new Date(start.getTime() + HOUR) }))
    const [row] = (await actionsOf("conversacion")).filter((item) => item.conversationId === conv)
    expect(row).toMatchObject({ tier: "gestiona", contactId: mother!.contactId })
  })

  it("lo cobrado no cambia de tipo ni de precio: la base lo impide", async () => {
    const conv = await inbound("tg:cobrada")
    const start = new Date(Date.now() - 4 * HOUR)
    await ran(conv, start)
    const [row] = (await actionsOf("conversacion")).filter((item) => item.conversationId === conv)
    await ownerDb
      .update(saasAction)
      .set({ chargeId: randomUUID() })
      .where(eq(saasAction.id, row!.id))
    const contactId = await executed(conv, "reprogramar_cita", new Date(start.getTime() + HOUR))
    await run((tx) =>
      refreshConversationTier(tx, ORG, { contactId, at: new Date(start.getTime() + HOUR) }),
    )
    const [after] = (await actionsOf("conversacion")).filter((item) => item.id === row!.id)
    expect(after).toMatchObject({ tier: "informa", priceMicros: 100_000 })
    await expect(
      ownerDb.update(saasAction).set({ tier: "gestiona" }).where(eq(saasAction.id, row!.id)),
    ).rejects.toThrow()
    await expect(
      ownerDb.update(saasAction).set({ priceMicros: 1 }).where(eq(saasAction.id, row!.id)),
    ).rejects.toThrow()
  })
})

describe("la cita que reservó Sofi", () => {
  async function scene(input: {
    source: string
    adminMessageDaysAgo?: number
    adminKind?: string
    /** Quien conversa y recibe los mensajes es otra persona: la madre que reserva para su hijo. */
    byGuardian?: boolean
  }) {
    const fx = await clinicalFixture()
    const [self] = await ownerDb
      .select({ contactId: patientContact.contactId })
      .from(patientContact)
      .where(
        and(eq(patientContact.patientId, fx.patient.id), eq(patientContact.relationship, "self")),
      )
    let contactId = self!.contactId
    let conversationId: string | null = null
    if (input.byGuardian) {
      conversationId = await inbound(`tg:madre-${randomUUID().slice(0, 8)}`)
      const [conv] = await ownerDb
        .select({ contactId: conversation.contactId })
        .from(conversation)
        .where(eq(conversation.id, conversationId))
      contactId = conv!.contactId
    }
    const [site] = await ownerDb
      .insert(branch)
      .values({ organizationId: ORG, name: `Sede ${randomUUID().slice(0, 6)}` })
      .returning()
    const [room] = await ownerDb
      .insert(scheduleRoom)
      .values({ organizationId: ORG, branchId: site!.id, name: "Unidad dental" })
      .returning()
    const bookedAt = new Date(Date.now() - 2 * DAY)
    if (input.adminMessageDaysAgo !== undefined) {
      await ownerDb.insert(automationJob).values({
        organizationId: ORG,
        kind: input.adminKind ?? "seguimiento_presupuesto",
        status: "enviado",
        dedupeKey: randomUUID(),
        scheduledFor: bookedAt,
        contactId,
        // El mensaje es por el paciente, aunque lo reciba quien habla por él.
        patientId: fx.patient.id,
        updatedAt: new Date(Date.now() - input.adminMessageDaysAgo * DAY),
      })
    }
    // La conversación «Gestiona» con que Sofi la reservó, una hora antes.
    const [conversationAction] = await ownerDb
      .insert(saasAction)
      .values({
        organizationId: ORG,
        kind: "conversacion",
        tier: "gestiona",
        occurredAt: new Date(bookedAt.getTime() - HOUR),
        contactId,
        conversationId,
        channel: "telegram",
        detail: "Atendió una conversación y gestionó una cita por Telegram",
        currency: "USD",
        basePriceMicros: 500_000,
        priceMicros: 450_000,
        discountBps: 1000,
        dedupeKey: randomUUID(),
      })
      .returning()
    const startsAt = new Date(Date.now() + DAY + Math.floor(Math.random() * 1_000) * HOUR)
    const [appt] = await ownerDb
      .insert(appointment)
      .values({
        organizationId: ORG,
        branchId: site!.id,
        roomId: room!.id,
        professionalUserId: fx.actor,
        patientId: fx.patient.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        durationMin: 30,
        status: "programada",
        source: input.source,
        conversationId,
        createdAt: bookedAt,
      })
      .returning()
    return {
      fx,
      contactId,
      appointmentId: appt!.id,
      conversationActionId: conversationAction!.id,
      room: room!,
      site: site!,
    }
  }

  async function attend(item: Awaited<ReturnType<typeof scene>>) {
    await ownerDb
      .update(encounter)
      .set({ appointmentId: item.appointmentId })
      .where(eq(encounter.id, item.fx.encounter.id))
    await item.fx.ready(item.fx.encounter.id)
    await item.fx.run((tx) => finalizeEncounter(tx, ...item.fx.args, item.fx.encounter.id))
  }

  const ofAppointment = async (appointmentId: string) =>
    await run((tx) =>
      tx
        .select()
        .from(saasAction)
        .where(
          and(eq(saasAction.organizationId, ORG), eq(saasAction.appointmentId, appointmentId)),
        ),
    )

  it("si el paciente viene, sube a «Agenda» con una fila aparte por la diferencia", async () => {
    const item = await scene({ source: "agent" })
    expect(await ofAppointment(item.appointmentId)).toHaveLength(0)
    await attend(item)
    const rows = await ofAppointment(item.appointmentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: "conversacion",
      tier: "agenda",
      basePriceMicros: 500_000,
      priceMicros: 450_000,
      contactId: item.contactId,
    })
    // Gestiona (0,45) + la diferencia (0,45) = Agenda con el 10 %: 0,90.
    const period = await run(async (tx) =>
      listPeriodActions(tx, ORG, await currentSaasPeriod(tx, ORG)),
    )
    expect(period.find((row) => row.id === rows[0]!.id)?.state).not.toBe("anulada")
  })

  it("la madre reservó para su hijo: si el hijo viene, sube a «Agenda» la conversación de la madre", async () => {
    const item = await scene({ source: "agent", byGuardian: true })
    await attend(item)
    const rows = await ofAppointment(item.appointmentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "conversacion", tier: "agenda", contactId: item.contactId })
  })

  it("la madre recibió el mensaje de Argos por su hijo: la cita recuperada cuenta y su conversación va dentro", async () => {
    const item = await scene({ source: "agent", adminMessageDaysAgo: 3, byGuardian: true })
    await attend(item)
    const rows = await ofAppointment(item.appointmentId)
    expect(rows.map((row) => row.kind)).toEqual(["cita"])
    expect(rows[0]).toMatchObject({ contactId: item.contactId })
    const period = await run(async (tx) => listPeriodActions(tx, ORG, await currentSaasPeriod(tx, ORG)))
    expect(period.find((row) => row.id === item.conversationActionId)?.state).toBe("dentro_de_cita")
  })

  it("la que agendó el equipo no sube: no la reservó Sofi", async () => {
    const item = await scene({ source: "recepcion" })
    await attend(item)
    expect(await ofAppointment(item.appointmentId)).toHaveLength(0)
  })

  it("si además es una cita recuperada, se cobra solo la cita: ni «Agenda» ni la conversación", async () => {
    const item = await scene({ source: "agent", adminMessageDaysAgo: 3 })
    await attend(item)
    const rows = await ofAppointment(item.appointmentId)
    expect(rows.map((row) => row.kind)).toEqual(["cita"])
    expect(rows[0]).toMatchObject({ basePriceMicros: 2_000_000, priceMicros: 1_800_000 })
    const period = await run(async (tx) =>
      listPeriodActions(tx, ORG, await currentSaasPeriod(tx, ORG)),
    )
    const cita = period.find((row) => row.id === rows[0]!.id)
    // La conversación que la reservó va dentro de la cita.
    expect(period.find((row) => row.id === item.conversationActionId)?.state).toBe("dentro_de_cita")
    expect(cita?.refunds ?? []).toEqual([])
  })

  describe("cita recuperada: lo decide si ya tenía su cita", () => {
    it("no cuenta si tenía otra cita por venir cuando Argos le escribió", async () => {
      const item = await scene({ source: "agent", adminMessageDaysAgo: 3 })
      const startsAt = new Date(Date.now() + 5 * DAY)
      await ownerDb.insert(appointment).values({
        organizationId: ORG,
        branchId: item.site.id,
        roomId: item.room.id,
        professionalUserId: item.fx.actor,
        patientId: item.fx.patient.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        durationMin: 30,
        status: "programada",
        source: "recepcion",
        createdAt: new Date(Date.now() - 20 * DAY),
      })
      await attend(item)
      // Sin cita recuperada, la conversación que la reservó sube a Agenda.
      expect((await ofAppointment(item.appointmentId)).map((row) => row.tier ?? row.kind)).toEqual([
        "agenda",
      ])
    })

    it("no cuenta si tenía un tratamiento aceptado sin terminar", async () => {
      const item = await scene({ source: "agent", adminMessageDaysAgo: 3 })
      await ownerDb.insert(treatmentPlanItem).values({
        organizationId: ORG,
        patientId: item.fx.patient.id,
        planId: item.fx.plan.id,
        title: "Ortodoncia",
        currency: "PEN",
        decisionStatus: "aceptado",
        decidedAt: new Date(Date.now() - 60 * DAY),
        status: "en_curso",
      })
      await attend(item)
      expect((await ofAppointment(item.appointmentId)).map((row) => row.kind)).not.toContain("cita")
    })

    it("el saldo vencido no recupera a nadie; el aviso de un control sin cita sí", async () => {
      const debt = await scene({
        source: "agent",
        adminMessageDaysAgo: 3,
        adminKind: "cobranza_vencida",
      })
      await attend(debt)
      expect((await ofAppointment(debt.appointmentId)).map((row) => row.kind)).not.toContain("cita")
      const control = await scene({
        source: "enlace",
        adminMessageDaysAgo: 3,
        adminKind: "recordatorio_control",
      })
      await attend(control)
      expect((await ofAppointment(control.appointmentId)).map((row) => row.kind)).toEqual(["cita"])
    })
  })
})

describe("Clío, según lo que dejó hecho", () => {
  it("un bloque es Simple; diagnóstico, odontograma o dos bloques, Estándar; un presupuesto, Completa", () => {
    const tier = (...kinds: string[]) => consultationTierOf(new Set(kinds))
    expect(tier("receta")).toBe("simple")
    expect(tier("nota")).toBe("simple")
    expect(tier("control")).toBe("simple")
    expect(tier("diagnostico")).toBe("estandar")
    expect(tier("odontograma")).toBe("estandar")
    expect(tier("nota", "receta")).toBe("estandar")
    expect(tier("plan")).toBe("completa")
    expect(tier("plan", "nota", "odontograma")).toBe("completa")
  })

  it("se cobra al cerrar la atención con el tipo de lo confirmado: Simple fijo, Completa con el descuento", async () => {
    await run((tx) => upsertAgentConfig(tx, ORG, { clinicalAssistantEnabled: true }))
    async function closed(kinds: string[]) {
      const fx = await clinicalFixture()
      for (const kind of kinds) {
        await ownerDb.insert(encounterDictationSuggestion).values({
          organizationId: ORG,
          patientId: fx.patient.id,
          encounterId: fx.encounter.id,
          professionalUserId: fx.actor,
          kind: kind as "nota",
          payload: {},
          status: "confirmada",
        })
      }
      // Una descartada no cuenta para el tipo.
      await ownerDb.insert(encounterDictationSuggestion).values({
        organizationId: ORG,
        patientId: fx.patient.id,
        encounterId: fx.encounter.id,
        professionalUserId: fx.actor,
        kind: "plan",
        payload: {},
        status: "descartada",
      })
      await fx.ready(fx.encounter.id)
      await fx.run((tx) => finalizeEncounter(tx, ...fx.args, fx.encounter.id))
      return (await actionsOf("consulta")).find((row) => row.encounterId === fx.encounter.id)
    }
    expect(await closed(["receta"])).toMatchObject({
      tier: "simple",
      basePriceMicros: 100_000,
      priceMicros: 100_000,
      discountBps: 0,
    })
    expect(await closed(["odontograma"])).toMatchObject({
      tier: "estandar",
      basePriceMicros: 200_000,
      priceMicros: 200_000,
    })
    expect(await closed(["plan", "nota"])).toMatchObject({
      tier: "completa",
      basePriceMicros: 500_000,
      priceMicros: 450_000,
      discountBps: 1000,
    })
  })
})

describe("Argos: preguntas incluidas y paquetes", () => {
  const asked = async (outcome: string, usedModel = true) => {
    const [anyUser] = (await ownerDb.execute(
      sql`select id from "user" limit 1`,
    )) as unknown as Array<{ id: string }>
    await ownerDb
      .insert(reportQuestion)
      .values({ organizationId: ORG, userId: anyUser!.id, outcome, usedModel })
  }

  it("cuentan las que pasan por el modelo y respondió; al acabarse, pide permiso para sumar un paquete", async () => {
    await asked("respondida")
    await asked("parcial")
    // No cuentan: lo que no pudo, la Ayuda y lo que no llamó al modelo.
    await asked("no_pudo")
    await asked("ayuda")
    await asked("respondida", false)
    expect(await run((tx) => getArgosAllowance(tx, ORG))).toMatchObject({
      limited: true,
      included: 3,
      added: 0,
      used: 2,
      remaining: 1,
    })
    await run((tx) => ensureArgosQuestion(tx, ORG))
    await asked("respondida")
    // Usó las 3: pregunta antes de sumar, con el precio fijo del paquete.
    await expect(run((tx) => ensureArgosQuestion(tx, ORG))).rejects.toMatchObject({
      code: "ARGOS_QUESTIONS_USED",
    })
    // El mes es el del día en que cierra el de la clínica: «Usaste las 3 preguntas de noviembre».
    await expect(run((tx) => ensureArgosQuestion(tx, ORG))).rejects.toThrow(
      /^Usaste las 3 preguntas de \p{L}+\. ¿Sumo 2 más por USD 3\? Las uso para responder esta pregunta y las que vengan hasta el \d+ de \p{L}+\.$/u,
    )
    const after = await run((tx) => addArgosPack(tx, ORG, { automatic: false }))
    expect(after).toMatchObject({ added: 2, remaining: 2, packAdded: true })
    // Un doble clic (o dos preguntas a la vez con «Sumar solas») no suma otro paquete por el mismo agotamiento.
    expect(await run((tx) => addArgosPack(tx, ORG, { automatic: false }))).toMatchObject({ added: 2, remaining: 2, packAdded: false })
    expect(await actionsOf("preguntas")).toHaveLength(1)
    const [pack] = await actionsOf("preguntas")
    expect(pack).toMatchObject({
      units: 2,
      tier: null,
      basePriceMicros: 3_000_000,
      priceMicros: 3_000_000,
      discountBps: 0,
    })
  })

  it("con «Sumar solas» encendido, suma el paquete sin preguntar y lo dice en el detalle", async () => {
    await asked("respondida")
    await asked("respondida")
    await run((tx) => setArgosAutoPack(tx, ORG, true))
    await run((tx) => ensureArgosQuestion(tx, ORG))
    const packs = await actionsOf("preguntas")
    expect(packs).toHaveLength(2)
    expect(packs.find((row) => row.detail.includes("solas"))).toBeDefined()
    expect(await run((tx) => getArgosAllowance(tx, ORG))).toMatchObject({
      added: 4,
      used: 5,
      remaining: 2,
      autoPack: true,
    })
  })
})

describe("el paquete comprado a fin de mes (D3)", () => {
  it("lo que quedó de un paquete de los últimos 7 días sigue en el mes siguiente", async () => {
    const period = await run((tx) => currentSaasPeriod(tx, ORG))
    const [anyUser] = (await ownerDb.execute(sql`select id from "user" limit 1`)) as unknown as Array<{ id: string }>
    // El mes anterior: usó 4 de sus 3 incluidas y el paquete de 2 que sumó dos días antes del cierre.
    await ownerDb.insert(saasAction).values({
      organizationId: ORG,
      kind: "preguntas",
      units: 2,
      occurredAt: new Date(period.start.getTime() - 2 * DAY),
      detail: "Sumó 2 preguntas a Argos",
      currency: "USD",
      basePriceMicros: 3_000_000,
      priceMicros: 3_000_000,
      dedupeKey: randomUUID(),
    })
    await ownerDb.insert(reportQuestion).values(
      Array.from({ length: 4 }, () => ({ organizationId: ORG, userId: anyUser!.id, outcome: "respondida", usedModel: true, createdAt: new Date(period.start.getTime() - 5 * DAY) })),
    )
    expect(await run((tx) => getArgosAllowance(tx, ORG))).toMatchObject({ carried: 1, added: 5, used: 5, remaining: 3 })
  })
})

describe("almacenamiento por GB", () => {
  it("cobra el promedio del mes por encima de lo incluido, al GB de arriba, una sola vez", async () => {
    const period = await run((tx) => currentSaasPeriod(tx, ORG))
    const day = (offset: number) => storageDayOf(new Date(period.start.getTime() + offset * DAY))
    // 10 días con 30 GB y 10 con 10 GB: 20 GB de promedio, nada que cobrar.
    for (let index = 0; index < 20; index++) {
      await ownerDb
        .insert(storageUsageDay)
        .values({
          organizationId: ORG,
          day: day(index),
          bytes: (index < 10 ? 30 : 10) * STORAGE_GB_BYTES,
        })
    }
    expect(await ownerDb.transaction((tx) => countStorageAction(tx, ORG, period))).toBe(false)
    // Diez días más con 45 GB: (300 + 100 + 450) / 30 = 28,3 GB → 9 GB extra.
    for (let index = 20; index < 30; index++) {
      await ownerDb
        .insert(storageUsageDay)
        .values({ organizationId: ORG, day: day(index), bytes: 45 * STORAGE_GB_BYTES })
    }
    expect(await ownerDb.transaction((tx) => countStorageAction(tx, ORG, period))).toBe(true)
    expect(await ownerDb.transaction((tx) => countStorageAction(tx, ORG, period))).toBe(false)
    const [row] = await actionsOf("almacenamiento")
    // USD 0,20 por GB con el 10 % negociado (no es un precio fijo).
    expect(row).toMatchObject({
      units: 9,
      basePriceMicros: 1_800_000,
      priceMicros: 1_620_000,
      discountBps: 1000,
    })
    expect(row?.detail).toContain("9 GB por encima de los 20 incluidos")
    expect(row!.occurredAt.getTime()).toBe(period.end.getTime() - 1)
  })
})
