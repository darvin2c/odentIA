import type { Db } from "@odentia/db"
import { agentRunLedger, aiUsage } from "@odentia/db/schema/agent"
import { encounter, encounterDictationSuggestion } from "@odentia/db/schema/clinical"
import { conversation } from "@odentia/db/schema/crm"
import { reportQuestion } from "@odentia/db/schema/reports"
import { saasAction } from "@odentia/db/schema/saas-billing"
import { and, eq, gte, inArray, lt, notInArray } from "drizzle-orm"
import { currentSaasPeriod } from "./saas-actions.js"

/**
 * Lo que costó cada acción del mes, para ver la ficha de la clínica en la
 * administración (lienzo «Gastos por organización»): las pausas de cada
 * atención dictada con lo que dejó hecho, cada respuesta de Sofi con lo que
 * hizo, las preguntas a Argos con su costo (las primeras, de antes de anotarse
 * por pregunta, quedan «repartidas») y lo que no se cobró. Costos de ejemplo
 * con los precios del agente; ningún proveedor los cobró. Sirve a cualquier
 * producto: solo usa las acciones que ya contó la semilla.
 */
export async function seedSaasCostDemo(
  tx: Db,
  input: { orgId: string; askers: Array<{ userId: string; weight: number }>; now?: Date },
): Promise<{ pauses: number; runs: number; questions: number }> {
  const now = input.now ?? new Date()
  const { orgId } = input
  const period = await currentSaasPeriod(tx, orgId, now)
  const end = period.end < now ? period.end : now
  const mark = (key: string) => {
    let hash = 2166136261
    for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
    return ((hash >>> 0) % 10_000) / 10_000
  }
  const at = (from: Date, minutes: number) =>
    new Date(Math.min(end.getTime() - 60_000, from.getTime() + minutes * 60_000))
  const usage: Array<typeof aiUsage.$inferInsert> = []
  const runs: Array<typeof agentRunLedger.$inferInsert> = []
  const suggestions: Array<typeof encounterDictationSuggestion.$inferInsert> = []

  const actions = await tx
    .select({
      id: saasAction.id,
      kind: saasAction.kind,
      tier: saasAction.tier,
      occurredAt: saasAction.occurredAt,
      contactId: saasAction.contactId,
      encounterId: saasAction.encounterId,
    })
    .from(saasAction)
    .where(
      and(
        eq(saasAction.organizationId, orgId),
        gte(saasAction.occurredAt, period.start),
        lt(saasAction.occurredAt, end),
      ),
    )

  // --- Clío: cada pausa es una llamada; al cerrar quedó confirmado lo de su tipo -----------
  const kindsOf: Record<string, string[]> = {
    simple: ["receta"],
    estandar: ["nota", "diagnostico", "control"],
    completa: ["nota", "diagnostico", "odontograma", "plan"],
  }
  const consultations = actions.filter((row) => row.kind === "consulta" && row.encounterId)
  const encounterIds = consultations.map((row) => row.encounterId as string)
  const freeEncounters = await tx
    .select({
      id: encounter.id,
      patientId: encounter.patientId,
      professionalUserId: encounter.professionalUserId,
      endedAt: encounter.endedAt,
      startedAt: encounter.startedAt,
    })
    .from(encounter)
    .where(
      and(
        eq(encounter.organizationId, orgId),
        eq(encounter.status, "finalizada"),
        gte(encounter.startedAt, period.start),
        lt(encounter.startedAt, end),
        encounterIds.length ? notInArray(encounter.id, encounterIds) : undefined,
      ),
    )
    .limit(3)
  const seen = encounterIds.length
    ? await tx
        .select({
          id: encounter.id,
          patientId: encounter.patientId,
          professionalUserId: encounter.professionalUserId,
        })
        .from(encounter)
        .where(and(eq(encounter.organizationId, orgId), inArray(encounter.id, encounterIds)))
    : []
  const encounterOf = new Map(seen.map((row) => [row.id, row]))
  const already = encounterIds.length
    ? new Set(
        (
          await tx
            .select({ id: encounterDictationSuggestion.encounterId })
            .from(encounterDictationSuggestion)
            .where(
              and(
                eq(encounterDictationSuggestion.organizationId, orgId),
                inArray(encounterDictationSuggestion.encounterId, encounterIds),
              ),
            )
        ).map((row) => row.id),
      )
    : new Set<string>()
  let pauses = 0
  const dictate = (
    encounterId: string,
    closedAt: Date,
    count: number,
    kinds: string[],
    who: { patientId: string; professionalUserId: string } | undefined,
  ) => {
    const startAt = new Date(closedAt.getTime() - (count * 2 + 3) * 60_000)
    for (let index = 0; index < count; index++) {
      const pauseAt = at(startAt, index * 2)
      const input = 1_700 + index * 120 + Math.round(mark(`${encounterId}:${index}`) * 600)
      const output = 120 + Math.round(mark(`${encounterId}:out:${index}`) * 300)
      usage.push({
        organizationId: orgId,
        origin: "dictado",
        provider: "openai",
        model: "gpt-6-luna",
        calls: 1,
        inputTokens: input,
        outputTokens: output,
        costMicros: Math.round(input * 0.1 + output * 0.4),
        encounterId,
        createdAt: pauseAt,
      })
      pauses += 1
      // Lo que sugirió esta pausa: un tipo por pausa mientras queden, guardado justo después de su gasto.
      const kind = kinds[index]
      if (kind && who && !already.has(encounterId)) {
        suggestions.push({
          organizationId: orgId,
          patientId: who.patientId,
          encounterId,
          professionalUserId: who.professionalUserId,
          kind: kind as never,
          payload: {},
          status: "confirmada",
          decidedBy: who.professionalUserId,
          decidedAt: closedAt,
          createdAt: new Date(pauseAt.getTime() + 2_000),
          updatedAt: closedAt,
        })
      }
    }
  }
  for (const row of consultations) {
    const kinds = kindsOf[row.tier ?? "simple"] ?? ["nota"]
    const count =
      kinds.length + 1 + Math.round(mark(`pausas:${row.id}`) * (row.tier === "completa" ? 9 : 5))
    dictate(
      row.encounterId as string,
      row.occurredAt,
      count,
      kinds,
      encounterOf.get(row.encounterId as string),
    )
  }
  // Escuchó y no se confirmó nada: no se cobra.
  for (const row of freeEncounters)
    dictate(
      row.id,
      row.endedAt ?? row.startedAt,
      2 + Math.round(mark(`libre:${row.id}`) * 3),
      [],
      undefined,
    )

  // --- Sofi: cada respuesta es una corrida con lo que hizo --------------------------------
  const scripts: Record<string, string[][]> = {
    informa: [["send_reply"], ["ver_sedes_y_servicios", "send_reply"], ["send_reply"]],
    gestiona: [
      ["send_reply"],
      ["ver_sedes_y_servicios", "send_reply"],
      ["buscar_huecos", "send_reply"],
      ["proponer_cita", "send_reply"],
      ["confirmar_propuesta", "send_reply"],
      ["send_reply"],
    ],
  }
  const conversationActions = actions.filter(
    (row) => (row.kind === "conversacion" && row.tier !== "agenda") || row.kind === "cita",
  )
  const contactIds = [
    ...new Set(conversationActions.map((row) => row.contactId).filter((id): id is string => !!id)),
  ]
  const threads = contactIds.length
    ? await tx
        .select({ id: conversation.id, contactId: conversation.contactId })
        .from(conversation)
        .where(
          and(eq(conversation.organizationId, orgId), inArray(conversation.contactId, contactIds)),
        )
    : []
  const threadOf = new Map<string, string>()
  for (const row of threads)
    if (row.contactId && !threadOf.has(row.contactId)) threadOf.set(row.contactId, row.id)
  const withRuns = new Set(
    threads.length
      ? (
          await tx
            .select({ id: agentRunLedger.conversationId })
            .from(agentRunLedger)
            .where(
              and(
                eq(agentRunLedger.organizationId, orgId),
                inArray(
                  agentRunLedger.conversationId,
                  threads.map((row) => row.id),
                ),
                gte(agentRunLedger.startedAt, period.start),
              ),
            )
        ).map((row) => row.id)
      : [],
  )
  let runCount = 0
  const answer = (conversationId: string, from: Date, steps: string[][], key: string) => {
    steps.forEach((tools, index) => {
      const startedAt = at(from, index * 1.5 + 0.2)
      const calls = tools.length > 1 ? 2 : 1
      const input = calls * (11_500 + Math.round(mark(`${key}:${index}`) * 2_500))
      const output = 60 + Math.round(mark(`${key}:o:${index}`) * 260)
      const cost = Math.round(input * 0.055 + output * 0.4)
      runs.push({
        organizationId: orgId,
        conversationId,
        model: "gpt-6-luna",
        status: "ok",
        startedAt,
        endedAt: new Date(startedAt.getTime() + 4_000),
        latencyMs: 4_000,
        inputTokens: input,
        outputTokens: output,
        llmCalls: calls,
        costMicros: cost,
        toolsUsed: tools,
      })
      usage.push({
        organizationId: orgId,
        origin: "recepcion",
        provider: "openai",
        model: "gpt-6-luna",
        calls,
        inputTokens: input,
        outputTokens: output,
        costMicros: cost,
        conversationId,
        createdAt: new Date(startedAt.getTime() + 4_500),
      })
      runCount += 1
    })
  }
  for (const row of conversationActions) {
    const thread = row.contactId ? threadOf.get(row.contactId) : undefined
    if (!thread || withRuns.has(thread)) continue
    withRuns.add(thread)
    if (row.kind === "cita") {
      // La cita recuperada: la conversación que llevó a reservar, antes de la visita.
      answer(
        thread,
        new Date(row.occurredAt.getTime() - 3 * 86_400_000),
        scripts.gestiona?.slice(2, 5) ?? [],
        `cita:${row.id}`,
      )
      continue
    }
    const script = scripts[row.tier === "informa" ? "informa" : "gestiona"] ?? []
    answer(
      thread,
      row.occurredAt,
      script.slice(0, Math.max(1, Math.round(script.length * (0.5 + mark(`largo:${row.id}`) / 2)))),
      row.id,
    )
  }
  // Lo que pasó al equipo o era spam: una respuesta sin cobro, en conversaciones del mes sin acción.
  const loose = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(
      and(
        eq(conversation.organizationId, orgId),
        contactIds.length ? notInArray(conversation.contactId, contactIds) : undefined,
        gte(conversation.lastMessageAt, period.start),
      ),
    )
    .limit(2)
  for (const row of loose) {
    if (withRuns.has(row.id)) continue
    answer(
      row.id,
      at(period.start, 60 * 24 * (1 + mark(row.id) * 5)),
      [["request_human_handoff", "send_reply"]],
      `suelta:${row.id}`,
    )
  }

  // --- Argos: preguntas con su costo; las de los primeros días, sin anotar (repartidas) ----
  const existing = await tx
    .select({ id: reportQuestion.id })
    .from(reportQuestion)
    .where(
      and(
        eq(reportQuestion.organizationId, orgId),
        gte(reportQuestion.createdAt, period.start),
        lt(reportQuestion.createdAt, end),
      ),
    )
    .limit(1)
  const questions: Array<{
    title: string | null
    outcome: string
    fuente?: "oficial" | "argos"
    pantalla?: string
    usedModel: boolean
  }> = [
    {
      title: "Pacientes nuevos por cómo nos conocieron · el mes pasado",
      outcome: "respondida",
      fuente: "oficial",
      pantalla: "pacientes",
      usedModel: true,
    },
    {
      title: "Lo cobrado por medio de pago · este mes",
      outcome: "respondida",
      fuente: "oficial",
      pantalla: "finanzas",
      usedModel: true,
    },
    {
      title: "Citas por canal · últimos 3 meses",
      outcome: "respondida",
      fuente: "argos",
      pantalla: "agenda",
      usedModel: true,
    },
    { title: null, outcome: "no_pudo", usedModel: true },
    { title: null, outcome: "no_sabe", usedModel: true },
    {
      title: "Presupuestos aceptados por profesional · este mes",
      outcome: "respondida",
      fuente: "argos",
      pantalla: "presupuestos",
      usedModel: true,
    },
    { title: null, outcome: "ayuda", usedModel: true },
    {
      title: "Inasistencias por profesional · este mes",
      outcome: "respondida",
      fuente: "oficial",
      pantalla: "agenda",
      usedModel: true,
    },
    {
      title: "Pacientes que faltaron y no reprogramaron · este mes",
      outcome: "parcial",
      fuente: "argos",
      pantalla: "pacientes",
      usedModel: true,
    },
    {
      title: "Servicios más vendidos · este mes",
      outcome: "respondida",
      fuente: "oficial",
      pantalla: "servicios",
      usedModel: true,
    },
  ]
  let questionCount = 0
  if (!existing.length && input.askers.length) {
    const span = Math.max(1, end.getTime() - period.start.getTime())
    const weights = input.askers.reduce((sum, item) => sum + item.weight, 0)
    const askerOf = (key: string) => {
      let pick = mark(key) * weights
      for (const item of input.askers) {
        pick -= item.weight
        if (pick <= 0) return item.userId
      }
      return input.askers[0]?.userId as string
    }
    for (const [index, item] of questions.entries()) {
      const askedAt = new Date(
        period.start.getTime() + Math.round(((index + 0.5) / questions.length) * span),
      )
      const plan = item.title
        ? {
            titulo: item.title,
            fuente: item.fuente,
            pantalla: item.pantalla,
            frase: "",
            frase_vacia: "",
            como: "",
            seguir: [],
          }
        : null
      const [row] = await tx
        .insert(reportQuestion)
        .values({
          organizationId: orgId,
          userId: askerOf(`asker:${index}`),
          outcome: item.outcome,
          usedModel: item.usedModel,
          plan,
          createdAt: askedAt,
        })
        .returning({ id: reportQuestion.id })
      if (!row) continue
      questionCount += 1
      // Las dos primeras son de antes de anotarse el costo por pregunta: su gasto no dice de qué pregunta es.
      const linked = index >= 2 ? row.id : null
      usage.push({
        organizationId: orgId,
        origin: "reportes",
        provider: "jev",
        model: "jev-1.13.0",
        calls: 1,
        inputTokens: 900,
        outputTokens: 6,
        costMicros: 60,
        reportQuestionId: linked,
        createdAt: new Date(askedAt.getTime() + 1_500),
      })
      if (item.outcome !== "ayuda" && item.outcome !== "no_pudo") {
        const input = 2_400 + Math.round(mark(`argos:${index}`) * 1_500)
        usage.push({
          organizationId: orgId,
          origin: "reportes",
          provider: "openai",
          model: "gpt-6-luna",
          calls: 1,
          inputTokens: input,
          outputTokens: 220,
          costMicros: Math.round(input * 0.06 + 220 * 0.4),
          reportQuestionId: linked,
          createdAt: new Date(askedAt.getTime() + 6_000),
        })
      }
    }
  }

  for (let index = 0; index < usage.length; index += 500)
    await tx.insert(aiUsage).values(usage.slice(index, index + 500))
  for (let index = 0; index < runs.length; index += 500)
    await tx.insert(agentRunLedger).values(runs.slice(index, index + 500))
  if (suggestions.length) await tx.insert(encounterDictationSuggestion).values(suggestions)
  return { pauses, runs: runCount, questions: questionCount }
}
