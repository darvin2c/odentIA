import type {
  KairosSellBooked,
  KairosSeller,
  KairosSellResult,
  KairosSellTools,
  KairosToolContext,
} from "@odentia/agent"
import type { ClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { saasChat } from "@odentia/db/schema/admin-arm"
import type { Mailer } from "@odentia/mail"
import {
  type AdminChannels,
  type ChatReply,
  chatSenderOf,
  claimKairosTurn,
  finishKairosTurn,
  INSTAGRAM_TEXT_BYTES,
  KAIROS_FALLBACK_TEXT,
  type KairosBookRefused,
  type KairosGuideAnswer,
  kairosBook,
  kairosCancel,
  kairosChatBlocked,
  kairosChatContext,
  kairosChatsToAnswer,
  kairosChooseChatProduct,
  kairosClinicData,
  kairosMove,
  kairosPresentationNotices,
  kairosPropose,
  kairosSalesFacts,
  kairosSaveContact,
  kairosSlots,
  kairosTurnCap,
  markKairosMailSent,
  outreachEmail,
  outreachMailMessage,
  prepareKairosChatReply,
  reserveKairosNotice,
  ServiceError,
  sendChatOutreach,
} from "@odentia/services"
import { eq } from "drizzle-orm"

/**
 * Kairós vende en los chats de la administración (ADR 0189 y el lienzo «Kairós
 * vende»), en su propio ciclo del worker: cada pasada responde, uno a la vez,
 * los mensajes nuevos sin respuesta de quien todavía no tiene su app
 * (`kairosChatsToAnswer`: solo con el interruptor prendido, sin «Lo atiendo
 * yo», no «No es una clínica», sin la app de una clínica y dentro de las 24
 * h), y después los avisos de las presentaciones que agendó (recordatorio del
 * día anterior, pedir otra hora, un cambio hecho por una persona).
 *
 * Cada mensaje, una vez: se reclama su turno con el candado de la conversación
 * (`claimKairosTurn`), el modelo responde con sus herramientas fuera de toda
 * transacción, la respuesta se reserva junto con el cierre del turno (con en qué
 * se basó, `basis`) y sale después del commit por el mismo envío que la de una
 * persona (`sendChatOutreach`): enviado, no salió o incierto, nunca se reintenta. Si el
 * worker se cae a mitad, el turno queda «en curso» y a los 10 minutos Hoy lo
 * muestra: nunca se responde dos veces el mismo mensaje.
 */

/** Cada cuánto mira si hay algo que responder. */
export const KAIROS_SELLS_TICK_MS = 15_000
/** Cuántas conversaciones responde por pasada como mucho. */
export const KAIROS_SELLS_PER_PASS = 10

/** La guía de la Ayuda a la que Kairós le pregunta por una función (`askGuideForSale`, ADR 0194). */
export interface KairosGuide {
  ask: (product: ClinicalProduct, question: string) => Promise<KairosGuideAnswer>
}

export interface KairosSellsDeps {
  ownerDb: Db
  seller: KairosSeller
  /** Sin ella, Kairós no encuentra nada en la guía y no afirma ninguna función que no esté en la web. */
  guide?: KairosGuide | undefined
  /** Los canales de la administración (`adminChannelsFromEnv`); sin el del chat, no responde (queda para el equipo). */
  channels?: AdminChannels | undefined
  /** Por dónde salen los avisos por correo (el canal de las conversaciones o, sin él, el de siempre). */
  mailer?: Pick<Mailer, "send"> | undefined
  fetch?: typeof fetch
  /** Las pruebas fijan la hora. */
  now?: () => Date
}

export interface KairosSellsResult {
  answered: number
  handedOver: number
  failed: number
  omitted: number
  notices: number
  errors: string[]
}

const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300)

const OUTCOME: Record<KairosSellResult["kind"], "respondio" | "paso" | "fallo"> = {
  respondio: "respondio",
  paso: "paso",
  paciente: "paso",
  fallo: "fallo",
}

/** Se acabó el tiempo del turno: lo que iba a escribir no se escribe. */
function stopped(): ServiceError {
  return new ServiceError("KAIROS_STOPPED", 409, "Se acabó el tiempo de este turno")
}

/** Lo que la hora ya no puede dar sale como error para el modelo, con lo vencido ya guardado. */
function bookedOrThrow(result: KairosSellBooked | KairosBookRefused): KairosSellBooked {
  if ("refused" in result) throw new ServiceError(result.refused.code, 409, result.refused.message)
  return result
}

/**
 * Las herramientas del modelo sobre los servicios: cada una en su transacción, a nombre de
 * Kairós. Las que escriben vuelven a mirar, con la conversación bloqueada, que Kairós todavía
 * pueda actuar (`kairosChatBlocked`: prendido, sin pausa, no «No es una clínica», sin la app ni
 * archivado, dentro de las 24 h) y que el turno no se cortó: si el tiempo se acabó mientras
 * escribía, la transacción se deshace antes de confirmarse.
 */
export function toolsFor(
  deps: KairosSellsDeps,
  chatId: string,
  now: Date,
  initial: ClinicalProduct | null = null,
): KairosSellTools {
  // La app con la que sigue el turno: la de la conversación o la que anotó con `elegir_app` (A1).
  let product = initial
  const read = <T>(fn: (tx: Db) => Promise<T>, ctx: KairosToolContext) => {
    if (ctx.signal.aborted) throw stopped()
    return deps.ownerDb.transaction((tx) => fn(tx as Db))
  }
  const write = <T>(fn: (tx: Db) => Promise<T>, ctx: KairosToolContext) => {
    if (ctx.signal.aborted) throw stopped()
    return deps.ownerDb.transaction(async (raw) => {
      const tx = raw as Db
      const blocked = await kairosChatBlocked(tx, chatId, now)
      if (blocked) throw new ServiceError("KAIROS_STOPPED", 409, blocked)
      const result = await fn(tx)
      if (ctx.signal.aborted) throw stopped()
      return result
    })
  }
  return {
    slots: (range, ctx) => read((tx) => kairosSlots(tx, chatId, range, now), ctx),
    propose: async (slot, ctx) => {
      const row = await write((tx) => kairosPropose(tx, chatId, slot, now), ctx)
      return { id: row.id, startsAt: row.startsAt }
    },
    book: async (proposalId, ctx) =>
      bookedOrThrow(await write((tx) => kairosBook(tx, chatId, proposalId, now), ctx)),
    move: async (proposalId, ctx) =>
      bookedOrThrow(await write((tx) => kairosMove(tx, chatId, proposalId, now), ctx)),
    cancel: (reason, ctx) => write((tx) => kairosCancel(tx, chatId, reason, now), ctx),
    saveContact: (input, ctx) => write((tx) => kairosSaveContact(tx, chatId, input, now), ctx),
    clinicData: (input, ctx) =>
      write(
        (tx) => kairosClinicData(tx, chatId, { ...input, product: input.product ?? product }, now),
        ctx,
      ),
    chooseProduct: async (chosen, ctx) => {
      const facts = await write(async (tx) => {
        const app = await kairosChooseChatProduct(tx, chatId, chosen, now)
        return kairosSalesFacts(tx, app.product)
      }, ctx)
      product = facts.product
      return facts
    },
    askGuide: async (question, ctx) => {
      if (ctx.signal.aborted) throw stopped()
      if (!deps.guide || !product) return { found: false }
      const answer = await deps.guide.ask(product, question)
      if (answer.found) return { found: true, texts: answer.texts }
      return answer.close?.length ? { found: false, close: answer.close } : { found: false }
    },
  }
}

/** Un mensaje: reclamar, responder, reservar y enviar. Devuelve en qué quedó. */
async function answerOne(
  deps: KairosSellsDeps,
  target: { chatId: string; messageId: string },
  now: Date,
): Promise<"respondio" | "paso" | "fallo" | "omitido" | null> {
  const { ownerDb } = deps
  const turnId = await ownerDb.transaction((tx) => claimKairosTurn(tx as Db, target, now))
  if (!turnId) return null
  const finish = (outcome: "omitido", why: string) =>
    ownerDb.transaction((tx) => finishKairosTurn(tx as Db, turnId, { outcome, why }, now))
  const context = await ownerDb.transaction((tx) => kairosChatContext(tx as Db, target.chatId, now))
  const channel = context.chat.channel
  if (!chatSenderOf(deps.channels, channel)) {
    await finish("omitido", "El canal de la administración no está configurado")
    return "omitido"
  }
  // Pasó un tope del día (de esta conversación o de todas): no se llama al modelo, pasa al equipo.
  const cap = await ownerDb.transaction((tx) => kairosTurnCap(tx as Db, target.chatId, turnId, now))
  let result: KairosSellResult
  if (cap) result = { kind: "paso", text: KAIROS_FALLBACK_TEXT, why: cap }
  else
    try {
      result = await deps.seller.answer(
        {
          channel,
          now,
          firstReply: context.firstReply,
          product: context.sales,
          client: context.client ? { name: context.client.name } : null,
          contact: context.contact
            ? {
                name: context.contact.name,
                hasPhone: Boolean(context.contact.phone),
                hasEmail: Boolean(context.contact.email),
              }
            : null,
          displayName: context.chat.displayName,
          history: context.history,
          omitted: context.omitted,
          leftContact: context.leftContact,
          proposal: context.proposal
            ? {
                id: context.proposal.id,
                startsAt: context.proposal.startsAt,
                assigneeName: context.proposal.assigneeName,
              }
            : null,
          presentation: context.presentation,
        },
        toolsFor(deps, target.chatId, now, context.sales?.product ?? null),
      )
    } catch (error) {
      result = {
        kind: "fallo",
        text: KAIROS_FALLBACK_TEXT,
        why: `Falló al responder (${message(error)})`,
      }
    }
  // Instagram corta a 1000 bytes: lo que no cabe no sale cortado, sale el aviso fijo.
  if (channel === "instagram" && Buffer.byteLength(result.text, "utf8") + 40 > INSTAGRAM_TEXT_BYTES)
    result = {
      kind: "fallo",
      text: KAIROS_FALLBACK_TEXT,
      why: "La respuesta no cabía en Instagram",
    }
  let reserved: ChatReply | null = null
  try {
    reserved = await ownerDb.transaction(async (raw) => {
      const tx = raw as Db
      // Mientras redactaba pudieron pausarla, apagar a Kairós, marcarla «No es una clínica», darle
      // su app o archivar al cliente, o pasar las 24 h: entonces no sale nada (Hoy lo muestra).
      const blocked = await kairosChatBlocked(tx, target.chatId, now)
      if (blocked) {
        await finishKairosTurn(
          tx,
          turnId,
          { outcome: "omitido", why: `${blocked} mientras respondía` },
          now,
        )
        return null
      }
      const reply = await prepareKairosChatReply(
        tx,
        target.chatId,
        { body: result.text, closeItems: result.kind === "respondio" },
        now,
      )
      await finishKairosTurn(
        tx,
        turnId,
        {
          outcome: OUTCOME[result.kind],
          why: result.kind === "respondio" ? null : result.why,
          outreachId: reply.outreachId,
          // «En qué se basó», junto a la respuesta en la Bandeja; un aviso fijo no se basa en nada.
          basis: result.kind === "respondio" ? result.basis : [],
        },
        now,
      )
      return reply
    })
  } catch (error) {
    // Pasaron las 24 h, o no se pudo reservar: no sale nada y Hoy lo muestra.
    const why =
      error instanceof ServiceError && error.code === "CHAT_WINDOW_CLOSED"
        ? "Pasaron las 24 horas de Meta"
        : `No se pudo reservar la respuesta (${message(error)})`
    await finish("omitido", why)
    return "omitido"
  }
  if (!reserved) return "omitido"
  await sendChatOutreach(
    {
      ownerDb,
      channels: deps.channels,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      now: () => now,
    },
    reserved,
    channel,
  )
  return OUTCOME[result.kind]
}

/** Los avisos de las presentaciones: una vez cada uno, reservado con su clave y enviado después del commit. */
async function sendNotices(
  deps: KairosSellsDeps,
  now: Date,
  out: KairosSellsResult,
): Promise<void> {
  const { ownerDb } = deps
  const notices = await ownerDb.transaction((tx) => kairosPresentationNotices(tx as Db, now))
  for (const notice of notices) {
    try {
      if (notice.route.by === "correo" && !deps.mailer) continue
      if (notice.route.by === "chat") {
        const chatId = notice.route.chatId
        const [chat] = await ownerDb
          .select({ channel: saasChat.channel })
          .from(saasChat)
          .where(eq(saasChat.id, chatId))
          .limit(1)
        if (!chat || !chatSenderOf(deps.channels, chat.channel as "whatsapp")) continue
      }
      const reserved = await ownerDb.transaction((tx) => reserveKairosNotice(tx as Db, notice, now))
      if (!reserved) continue
      out.notices += 1
      if (reserved.by === "chat") {
        await sendChatOutreach(
          {
            ownerDb,
            channels: deps.channels,
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
            now: () => now,
          },
          reserved.reply,
          reserved.channel,
        )
        continue
      }
      const mail = await ownerDb.transaction((tx) => outreachEmail(tx as Db, reserved.outreach.id))
      let result: "enviado" | "incierto" = "enviado"
      try {
        await deps.mailer?.send(outreachMailMessage(mail))
      } catch {
        // Un corte a mitad no dice si salió: queda incierto y no se repite solo.
        result = "incierto"
      }
      await ownerDb.transaction((tx) =>
        markKairosMailSent(tx as Db, reserved.outreach.id, result, now),
      )
    } catch (error) {
      out.errors.push(`aviso ${notice.key}: ${message(error)}`)
    }
  }
}

/** Una pasada: los mensajes por responder (uno a la vez) y los avisos de las presentaciones. */
export async function runKairosSellsTick(deps: KairosSellsDeps): Promise<KairosSellsResult> {
  const now = (deps.now ?? (() => new Date()))()
  const out: KairosSellsResult = {
    answered: 0,
    handedOver: 0,
    failed: 0,
    omitted: 0,
    notices: 0,
    errors: [],
  }
  let targets: Array<{ chatId: string; messageId: string }> = []
  try {
    targets = await deps.ownerDb.transaction((tx) =>
      kairosChatsToAnswer(tx as Db, now, KAIROS_SELLS_PER_PASS),
    )
  } catch (error) {
    out.errors.push(`conversaciones: ${message(error)}`)
  }
  for (const target of targets) {
    try {
      const outcome = await answerOne(deps, target, now)
      if (outcome === "respondio") out.answered += 1
      else if (outcome === "paso") out.handedOver += 1
      else if (outcome === "fallo") out.failed += 1
      else if (outcome === "omitido") out.omitted += 1
    } catch (error) {
      out.errors.push(`conversación ${target.chatId}: ${message(error)}`)
    }
  }
  try {
    await sendNotices(deps, now, out)
  } catch (error) {
    out.errors.push(`avisos: ${message(error)}`)
  }
  return out
}

/** La cola del worker: una pasada cada `KAIROS_SELLS_TICK_MS`. Un error queda en el registro. */
export function kairosSellsQueue(deps: Omit<KairosSellsDeps, "now">): {
  name: string
  poll: () => Promise<boolean>
} {
  let next = 0
  return {
    name: "kairos-vende",
    poll: async () => {
      if (Date.now() < next) return false
      next = Date.now() + KAIROS_SELLS_TICK_MS
      const result = await runKairosSellsTick(deps)
      for (const error of result.errors) console.error(`worker: kairos-vende ${error}`)
      return false
    },
  }
}
