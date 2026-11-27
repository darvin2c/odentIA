import { withoutPersonData } from "@odentia/clinical"
import {
  HELP_GUIDE_MAX_OPTIONS,
  type HelpAskAnswer,
  type HelpAskQuestion,
  type HelpFeedback,
  type HelpGuideTopic,
} from "@odentia/contract"
import type { Db } from "@odentia/db"
import {
  APP_AI_USAGE_ORIGINS,
  type AppAiUsageOrigin,
  appAiUsage,
  appHelpAsk,
  type SaasAccountExternalApp,
} from "@odentia/db/schema/admin-accounts"
import { and, count, eq, gte, sql } from "drizzle-orm"
import type { AiUsageEntry } from "./ai-usage.js"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import { decideHelp, type HelpDecided, readHelpPrevious } from "./help.js"
import { type HelpDecider, type HelpOption, helpOptions, helpScreenName, type HelpWriter } from "./help-decision.js"
import type { HelpTopic } from "./help-guide.js"
import { NO_AGENT_TEXTS, type ProductAgentTexts } from "./product-agent.js"

/* ---------- Ariadna para las apps que son otro sistema (`CONTRACT_PATHS.help`) ---------- */

/**
 * La misma Ariadna de las clínicas, para una app que es otro sistema (gestorIA): la app manda su
 * guía con cada pregunta y recibe ids de esa guía; los textos los arma ella. Decide igual que en
 * las clínicas (`decideHelp`: Jev en dos pasos y, si hace falta, quien redacta), con las palabras
 * del producto de la app. No guarda la pregunta ni la guía: solo la app, cómo se decidió y qué
 * (`app_help_ask`). Lo que cuestan los modelos lo paga odentIA, por app (`app_ai_usage`, origen
 * `ayuda`); el tope diario de cada app protege el servicio.
 */

/**
 * Lo más que pregunta una app en 24 horas, todas sus cuentas juntas: la pregunta no dice de qué
 * tienda es. Es un freno contra un error o un abuso, no un límite de uso.
 */
export const APP_HELP_DAILY_LIMIT = 5000

/** Cómo se nombra cada app en lo que lee Jev: su nombre y lo que es para ella una «clínica». */
export const APP_HELP_TEXTS: Record<SaasAccountExternalApp, ProductAgentTexts> = {
  gestoria: { ...NO_AGENT_TEXTS, name: "gestorIA", clinic: { es: "tienda", en: "store" } },
}

/** La guía de la app como la lee Ariadna: los mismos temas y preguntas frecuentes, sin nada más. */
export function appHelpTopics(guide: readonly HelpGuideTopic[]): HelpTopic[] {
  return guide.map((topic) => ({
    id: topic.id,
    path: topic.path,
    title: topic.title,
    parent: topic.parent,
    purpose: topic.purpose,
    terms: [...topic.terms],
    faqs: topic.faqs.map((faq) => ({ id: faq.id, q: faq.q, a: faq.a, ...(faq.forms ? { forms: [...faq.forms] } : {}) })),
  }))
}

/** Una respuesta de la guía por su id, como va en el acuerdo. */
export const appHelpRef = (option: HelpOption): string =>
  option.kind === "faq" ? `faq:${option.faq.id}` : `tema:${option.topic.id}`

/**
 * Reserva la pregunta antes de decidir: con el bloqueo de la app, dos preguntas a la vez no pasan
 * juntas del tope. La fila se completa al responder.
 */
async function reserveAppAsk(ownerDb: Db, app: SaasAccountExternalApp, now: Date): Promise<string> {
  return ownerDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ayuda-app:${app}`}))`)
    const since = new Date(now.getTime() - 86_400_000)
    const [row] = await tx
      .select({ total: count() })
      .from(appHelpAsk)
      .where(and(eq(appHelpAsk.app, app), gte(appHelpAsk.createdAt, since)))
    if (Number(row?.total ?? 0) >= APP_HELP_DAILY_LIMIT) {
      throw new ServiceError("HELP_LIMIT", 429, "La app llegó al tope de preguntas a la Ayuda de las últimas 24 horas.")
    }
    const [reserved] = await tx.insert(appHelpAsk).values({ app, createdAt: now }).returning({ id: appHelpAsk.id })
    if (!reserved) throw new Error("No se pudo registrar la consulta")
    return reserved.id
  })
}

/**
 * Responde la pregunta de una app con la guía que mandó (ADR 0211 y 0146). Lo que puede ser el
 * dato de una persona no viaja a Jev, ni en la pregunta ni en la anterior; si no queda nada de la
 * pregunta, no está en la guía y no se le pregunta. Usa la conexión propietaria: la app no tiene
 * clínica aquí, solo su firma.
 */
export async function answerAppHelp(
  ownerDb: Db,
  app: SaasAccountExternalApp,
  input: HelpAskQuestion,
  decider: HelpDecider | null,
  writer: HelpWriter | null = null,
  now = new Date(),
): Promise<HelpAskAnswer> {
  const topics = appHelpTopics(input.guide)
  // Lo mismo que exige el acuerdo, por si llega por otro lado: más opciones serían más tandas a Jev.
  if (helpOptions(topics).length > HELP_GUIDE_MAX_OPTIONS) {
    throw invalidField("guide", `La guía lleva como mucho ${HELP_GUIDE_MAX_OPTIONS} respuestas entre temas y preguntas frecuentes.`)
  }
  const askId = await reserveAppAsk(ownerDb, app, now)
  const forModel = withoutPersonData(input.question.trim())
  const decided: HelpDecided = forModel
    ? await decideHelp(
        forModel,
        input.screen ? helpScreenName(input.screen, topics) : null,
        topics,
        APP_HELP_TEXTS[app],
        decider,
        writer,
        readHelpPrevious(input.previous, topics),
      )
    : { via: "respaldo", selection: { verdict: "ninguna", shown: [], offered: [], top: null }, why: "dato" }
  // `exacta` no sale de `decideHelp`: lo escrito igual que en la guía lo reconoce la app con la suya.
  const via = decided.via === "jev" ? "jev" : "respaldo"
  const { selection } = decided
  await ownerDb
    .update(appHelpAsk)
    .set({ via, verdict: via !== "jev" ? null : decided.written ? "redactada" : selection.verdict })
    .where(eq(appHelpAsk.id, askId))
  return {
    askId,
    via,
    verdict: selection.verdict,
    shown: selection.shown.map(appHelpRef),
    offered: selection.offered.map(appHelpRef),
    written: decided.written ?? null,
  }
}

/**
 * Lo que dijo la persona de una respuesta en el panel de la app (`CONTRACT_PATHS.helpFeedback`):
 * «¿Te sirvió?» o «Ninguna es lo que busco», sin texto, sobre la fila de esa pregunta, como
 * `rateHelp` y `markHelpNoneFits` en las clínicas. Solo una pregunta de esa misma app.
 */
export async function rateAppHelp(ownerDb: Db, app: SaasAccountExternalApp, input: HelpFeedback): Promise<void> {
  const [row] = await ownerDb
    .update(appHelpAsk)
    .set(input.noneFits ? { noneFits: true } : { helpful: input.helpful ?? null })
    .where(and(eq(appHelpAsk.app, app), eq(appHelpAsk.id, input.askId)))
    .returning({ id: appHelpAsk.id })
  if (!row) throw notFound("Consulta de ayuda")
}

const cleanInt = (v: number | null | undefined) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null

/**
 * Anota lo que costaron los modelos de una operación hecha para una app (lo que mide `withAiMeter`
 * del agente): gasto de odentIA, por app, nunca en la cuenta de una clínica.
 */
export async function recordAppAiUsage(
  tx: Db,
  app: SaasAccountExternalApp,
  origin: AppAiUsageOrigin,
  entries: readonly AiUsageEntry[],
): Promise<void> {
  if (!(APP_AI_USAGE_ORIGINS as readonly string[]).includes(origin)) throw validation("origen de uso inválido")
  const rows = entries.filter((entry) => entry.calls > 0)
  if (!rows.length) return
  await tx.insert(appAiUsage).values(
    rows.map((entry) => ({
      app,
      origin,
      provider: entry.provider.slice(0, 60),
      model: entry.model.slice(0, 120),
      calls: Math.max(1, Math.round(entry.calls)),
      inputTokens: cleanInt(entry.inputTokens),
      cachedInputTokens: cleanInt(entry.cachedInputTokens),
      cacheWriteTokens: cleanInt(entry.cacheWriteTokens),
      outputTokens: cleanInt(entry.outputTokens),
      audioSeconds: cleanInt(entry.audioSeconds),
      costMicros: cleanInt(entry.costMicros),
    })),
  )
}
