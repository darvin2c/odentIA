import type { KairosSeller, KairosSellResult, KairosSellTools } from "@odentia/agent"
import type { Db } from "@odentia/db"
import { saasChat } from "@odentia/db/schema/admin-arm"
import type { Mailer } from "@odentia/mail"
import {
  type AdminChannels,
  type ChatReply,
  chatSenderOf,
  claimKairosTurn,
  finishKairosTurn,
  getKairosSells,
  INSTAGRAM_TEXT_BYTES,
  KAIROS_FALLBACK_TEXT,
  kairosBook,
  kairosCancel,
  kairosChatContext,
  kairosChatsToAnswer,
  kairosClinicData,
  kairosMove,
  kairosPresentationNotices,
  kairosPropose,
  kairosSaveContact,
  kairosSlots,
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
 * transacción, la respuesta se reserva junto con el cierre del turno y sale
 * después del commit por el mismo envío que la de una persona
 * (`sendChatOutreach`): enviado, no salió o incierto, nunca se reintenta. Si el
 * worker se cae a mitad, el turno queda «en curso» y a los 10 minutos Hoy lo
 * muestra: nunca se responde dos veces el mismo mensaje.
 */

/** Cada cuánto mira si hay algo que responder. */
export const KAIROS_SELLS_TICK_MS = 15_000
/** Cuántas conversaciones responde por pasada como mucho. */
export const KAIROS_SELLS_PER_PASS = 10

export interface KairosSellsDeps {
  ownerDb: Db
  seller: KairosSeller
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

/** Las herramientas del modelo sobre los servicios: cada una en su transacción, a nombre de Kairós. */
function toolsFor(deps: KairosSellsDeps, chatId: string, now: Date): KairosSellTools {
  const run = <T>(fn: (tx: Db) => Promise<T>) => deps.ownerDb.transaction((tx) => fn(tx as Db))
  return {
    slots: (range) => run((tx) => kairosSlots(tx, chatId, range, now)),
    propose: async (slot) => {
      const row = await run((tx) => kairosPropose(tx, chatId, slot, now))
      return { id: row.id, startsAt: row.startsAt }
    },
    book: (proposalId) => run((tx) => kairosBook(tx, chatId, proposalId, now)),
    move: (proposalId) => run((tx) => kairosMove(tx, chatId, proposalId, now)),
    cancel: (reason) => run((tx) => kairosCancel(tx, chatId, reason, now)),
    saveContact: (input) => run((tx) => kairosSaveContact(tx, chatId, input, now)),
    clinicData: (input) => run((tx) => kairosClinicData(tx, chatId, input, now)),
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
  let result: KairosSellResult
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
      toolsFor(deps, target.chatId, now),
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
      // Mientras redactaba pudieron pausarla o apagar a Kairós: entonces no sale nada.
      const [chat] = await tx
        .select({ pausedAt: saasChat.kairosPausedAt })
        .from(saasChat)
        .where(eq(saasChat.id, target.chatId))
        .for("update")
        .limit(1)
      if (chat?.pausedAt || !(await getKairosSells(tx)).enabled) {
        await finishKairosTurn(
          tx,
          turnId,
          { outcome: "omitido", why: "Se pausó o se apagó mientras respondía" },
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
