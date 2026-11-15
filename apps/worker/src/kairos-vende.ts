import type {
  KairosSellBooked,
  KairosSeller,
  KairosSellResult,
  KairosSellTools,
  KairosToolContext,
} from "@odentia/agent"
import type { Db } from "@odentia/db"
import { saasChat } from "@odentia/db/schema/admin-arm"
import type { Mailer } from "@odentia/mail"
import {
  type AdminChannels,
  type AriadnaChatInput,
  type AriadnaChatReply,
  ariadnaChatContext,
  type ChatReply,
  chatSenderOf,
  claimKairosTurn,
  finishKairosTurn,
  INSTAGRAM_TEXT_BYTES,
  KAIROS_FALLBACK_TEXT,
  type KairosBookRefused,
  type KairosChatToAnswer,
  kairosBook,
  kairosCancel,
  kairosChatBlocked,
  kairosChatContext,
  kairosChatsToAnswer,
  kairosClinicData,
  kairosMove,
  kairosPresentationNotices,
  kairosPropose,
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
 * transacción, la respuesta se reserva junto con el cierre del turno y sale
 * después del commit por el mismo envío que la de una persona
 * (`sendChatOutreach`): enviado, no salió o incierto, nunca se reintenta. Si el
 * worker se cae a mitad, el turno queda «en curso» y a los 10 minutos Hoy lo
 * muestra: nunca se responde dos veces el mismo mensaje.
 *
 * El mismo ciclo atiende, con Ariadna, los chats de las clínicas que ya tienen su app (ADR 0191):
 * con su propio interruptor, la guía de su producto y sin datos de la clínica; un turno por
 * mensaje, los mismos topes, la misma pausa y las mismas comprobaciones al reservar.
 */

/** Cada cuánto mira si hay algo que responder. */
export const KAIROS_SELLS_TICK_MS = 15_000
/** Cuántas conversaciones responde por pasada como mucho. */
export const KAIROS_SELLS_PER_PASS = 10

/** Ariadna en los chats: responde un turno con la guía (`askHelpByChat`), midiendo su gasto con la clínica. */
export interface AriadnaChatResponder {
  answer: (organizationId: string, input: AriadnaChatInput) => Promise<AriadnaChatReply>
}

export interface KairosSellsDeps {
  ownerDb: Db
  seller: KairosSeller
  /** Sin él, los chats de las clínicas con su app no se responden (quedan para Soporte). */
  ariadna?: AriadnaChatResponder | undefined
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
export function toolsFor(deps: KairosSellsDeps, chatId: string, now: Date): KairosSellTools {
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
    clinicData: (input, ctx) => write((tx) => kairosClinicData(tx, chatId, input, now), ctx),
  }
}

type TurnOutcome = "respondio" | "paso" | "fallo" | "omitido"

/** Lo que Ariadna pasa al equipo: la conversación queda pausada con el motivo y Hoy la muestra. */
const ARIADNA_OUTCOME: Record<AriadnaChatReply["kind"], "respondio" | "paso"> = {
  respuesta: "respondio",
  oferta: "respondio",
  datos: "respondio",
  soporte: "paso",
  administracion: "paso",
  paciente: "paso",
}

/** Un mensaje de una clínica con su app: Ariadna responde con la guía, sin datos de la clínica. */
async function answerAriadna(
  deps: KairosSellsDeps,
  target: KairosChatToAnswer,
  turnId: string,
  now: Date,
): Promise<TurnOutcome> {
  const { ownerDb } = deps
  const finish = (outcome: "omitido", why: string) =>
    ownerDb.transaction((tx) => finishKairosTurn(tx as Db, turnId, { outcome, why }, now))
  if (!deps.ariadna) {
    await finish("omitido", "Ariadna no está configurada en el worker")
    return "omitido"
  }
  const context = await ownerDb.transaction((tx) => ariadnaChatContext(tx as Db, target.chatId))
  const channel = context.chat.channel
  if (!chatSenderOf(deps.channels, channel)) {
    await finish("omitido", "El canal de la administración no está configurado")
    return "omitido"
  }
  const cap = await ownerDb.transaction((tx) =>
    kairosTurnCap(tx as Db, target.chatId, turnId, now, "ariadna"),
  )
  let result: AriadnaChatReply
  let outcome: "respondio" | "paso" | "fallo"
  if (cap) {
    result = { kind: "soporte", text: KAIROS_FALLBACK_TEXT, why: cap }
    outcome = "paso"
  } else
    try {
      result = await deps.ariadna.answer(context.client.organizationId, {
        product: context.client.product,
        question: context.question,
        previous: context.previous,
        offered: context.offered,
        firstReply: context.firstReply,
        appOrigin: context.appOrigin,
      })
      outcome = ARIADNA_OUTCOME[result.kind]
    } catch (error) {
      result = {
        kind: "soporte",
        text: KAIROS_FALLBACK_TEXT,
        why: `Falló al responder (${message(error)})`,
      }
      outcome = "fallo"
    }
  if (
    channel === "instagram" &&
    Buffer.byteLength(result.text, "utf8") + 40 > INSTAGRAM_TEXT_BYTES
  ) {
    result = {
      kind: "soporte",
      text: KAIROS_FALLBACK_TEXT,
      why: "La respuesta no cabía en Instagram",
    }
    outcome = "fallo"
  }
  let reserved: ChatReply | null = null
  try {
    reserved = await ownerDb.transaction(async (raw) => {
      const tx = raw as Db
      // Mientras respondía pudieron pausarla, apagar a Ariadna, archivar al cliente o pasar las 24 h.
      const blocked = await kairosChatBlocked(tx, target.chatId, now, "ariadna")
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
        {
          body: result.text,
          closeItems: outcome === "respondio",
          agent: "ariadna",
          // Lo que pasa a Administración no lo ve Soporte, tampoco la respuesta que lo dice.
          adminOnly: result.kind === "administracion",
        },
        now,
      )
      await finishKairosTurn(
        tx,
        turnId,
        {
          outcome,
          why: outcome === "respondio" ? null : "why" in result ? result.why : null,
          outreachId: reply.outreachId,
          ariadnaReply: result.kind,
        },
        now,
      )
      return reply
    })
  } catch (error) {
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
  return outcome
}

/** Un mensaje: reclamar, responder, reservar y enviar. Devuelve en qué quedó. */
async function answerOne(
  deps: KairosSellsDeps,
  target: KairosChatToAnswer,
  now: Date,
): Promise<TurnOutcome | null> {
  const { ownerDb } = deps
  const turnId = await ownerDb.transaction((tx) => claimKairosTurn(tx as Db, target, now))
  if (!turnId) return null
  if (target.agent === "ariadna") return answerAriadna(deps, target, turnId, now)
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
  let targets: KairosChatToAnswer[] = []
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
