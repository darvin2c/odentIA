import { randomUUID } from "node:crypto"
import {
  type ContractEventType,
  type ConversationChannel,
  contractOutbox,
  contractState,
  type Db,
  type OrderChannel,
  store,
  storeMember,
} from "@gestoria/db"
import {
  type AccountState,
  type AppEvent,
  accountState,
  appEvent,
  CONTRACT_MAX_RECEIPT_BYTES,
  CONTRACT_PATHS,
  type CONTRACT_RECEIPT_TYPES,
  SUPPORT_KINDS,
  USAGE_CHANNELS,
} from "@odentia/contract"
import { and, asc, desc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm"
import { z } from "zod"
import { helpGuideFor } from "./ayuda.js"
import { imageType } from "./catalogo.js"
import type { Person } from "./cuenta.js"
import { signMessage } from "./firma.js"
import { can, ROLE_NAMES, type StoreSeat } from "./permisos.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * gestorIA y la administración (paso B7 del lienzo B), con el acuerdo de `@odentia/contract`
 * (ADR 0211 y 0212). Nadie lee la base del otro:
 *
 * - **gestorIA avisa** lo que pasó: abrió o cambió una tienda (`cuenta.abierta`), Sofi atendió una
 *   conversación o tomó un pedido (`uso.contado`) y alguien pide ayuda (`soporte.pedido`). Cada
 *   aviso se guarda en `contract_outbox` en la misma transacción que lo que lo causó, y
 *   `deliverOutbox` lo envía y lo reintenta siempre con la misma clave (su id): la administración
 *   reconoce un repetido y nunca lo cuenta dos veces; nada se pierde.
 * - **gestorIA pregunta** el estado de cada tienda y guarda lo último que supo (`contract_state`).
 * - **La app nunca se detiene por la administración:** si no responde, sigue con lo último que
 *   supo; si nunca supo nada, deja trabajar. Solo Sofi se detiene, y solo si la administración
 *   lo dijo (la cuenta no puede seguir, se acabó el saldo de prueba o llegó a su tope).
 *
 * Sin el secreto (`GESTORIA_CONTRACT_SECRET`) no se envía ni se pregunta: los avisos se guardan y
 * esperan, como los de la cuenta, y al configurarlo sale también lo anterior.
 */

export interface ContractConfig {
  /**
   * La administración en el dominio de gestorIA: la misma entrada de la cuenta
   * (`GESTORIA_ACCOUNT_URL`, `https://api.gestoria24.com`).
   */
  url: string
  /** Con qué firma gestorIA (`whsec_…`); vacío, no envía ni pregunta. */
  secret: string
  /** Para las pruebas: cómo llamar a la administración. */
  fetch?: typeof fetch
}

/** Una conversación se cobra una vez por ventana de 24 horas desde que Sofi la atendió (como en las clínicas). */
export const CONVERSATION_WINDOW_MS = 24 * 3_600_000
/** Cada cuánto se vuelve a preguntar el estado de una tienda. */
export const STATE_EVERY_MS = 10 * 60_000
/** Al abrir «Plan y pagos» se pregunta otra vez si lo último tiene más de un minuto. */
const STATE_FRESH_MS = 60_000
/** Los reintentos esperan cada vez el doble, desde 30 segundos y hasta una hora. */
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 3_600_000
/** Lo más que se espera a la administración. */
const TIMEOUT_MS = 15_000
/** Lo más que se pregunta mientras alguien mira «Plan y pagos»: lo demás, lo último que se supo. */
const VIEW_TIMEOUT_MS = 5_000
/** Cada cuánto se le vuelve a avisar que se abrió una tienda que la administración no conoce. */
const REOPEN_EVERY_MS = 24 * 3_600_000
/** Las preguntas de ayuda que pueden esperar a salir a la vez en una tienda. */
const MAX_PENDING_SUPPORT = 5
/** Lo enviado se borra de la bandeja después de este plazo: la administración ya lo tiene. */
export const OUTBOX_KEEP_MS = 7 * 86_400_000

/* ---------- Lo que se avisa ---------- */

/** Lo que la bandeja guarda: los avisos del acuerdo que su tabla conoce (`CONTRACT_EVENT_TYPES`). */
type OutboxEvent = Extract<AppEvent, { type: ContractEventType }>

/**
 * Guarda un aviso en la bandeja de salida, dentro de la transacción de lo que lo causó. Se
 * comprueba contra el acuerdo antes de guardarlo: lo que sale es lo que la administración lee.
 * Con `dedupe`, lo mismo no se guarda dos veces en la tienda.
 */
async function enqueue(
  tx: Db,
  storeId: string,
  event: OutboxEvent,
  extra: { dedupe?: string; conversationId?: string } = {},
): Promise<void> {
  const payload = appEvent.parse(event) as OutboxEvent
  await tx
    .insert(contractOutbox)
    // La hora al anotarlo, no la del inicio de la transacción: dos avisos de la misma (la tienda
    // abierta y su equipo) salen en el orden en que se anotaron.
    .values({ storeId, type: payload.type, payload, createdAt: sql`clock_timestamp()`, ...extra })
    .onConflictDoNothing({ target: [contractOutbox.storeId, contractOutbox.dedupe] })
}

/** Quién es la tienda para la administración: su nombre, su país y su Dueño más antiguo. */
async function accountOf(tx: Db, storeId: string) {
  const [shop] = await tx
    .select({ name: store.name, country: store.country })
    .from(store)
    .where(eq(store.id, storeId))
  const [owner] = await tx
    .select({ userId: storeMember.userId })
    .from(storeMember)
    .where(and(eq(storeMember.storeId, storeId), eq(storeMember.role, "owner")))
    .orderBy(asc(storeMember.createdAt), asc(storeMember.userId))
    .limit(1)
  if (!shop || !owner) return null
  return { account: storeId, name: shop.name, country: shop.country, ownerUserId: owner.userId }
}

/**
 * Le avisa a la administración quién es la tienda si cambió desde lo último que se le avisó: al
 * crearla y cuando cambia su Dueño. Con `force`, aunque no haya cambiado (la administración dijo
 * que no la conoce). Una tienda sin Dueño no se avisa: no hay a quién nombrar.
 */
export async function noteStoreAccount(
  tx: Db,
  storeId: string,
  now = new Date(),
  force = false,
): Promise<void> {
  const data = await accountOf(tx, storeId)
  if (!data) return
  if (!force) {
    const [last] = await tx
      .select({ payload: contractOutbox.payload })
      .from(contractOutbox)
      .where(and(eq(contractOutbox.storeId, storeId), eq(contractOutbox.type, "cuenta.abierta")))
      .orderBy(desc(contractOutbox.createdAt))
      .limit(1)
    const before = last?.payload.data as typeof data | undefined
    if (
      before &&
      before.name === data.name &&
      before.country === data.country &&
      before.ownerUserId === data.ownerUserId
    )
      return
  }
  await enqueue(tx, storeId, { type: "cuenta.abierta", timestamp: now.toISOString(), data })
}

/** El equipo entero de la tienda para la cuenta: su nombre y cada persona con su rol, en orden estable. */
async function teamOf(tx: Db, storeId: string) {
  const [shop] = await tx.select({ name: store.name }).from(store).where(eq(store.id, storeId))
  if (!shop) return null
  const members = await tx
    .select({ userId: storeMember.userId, role: storeMember.role })
    .from(storeMember)
    .where(eq(storeMember.storeId, storeId))
    .orderBy(asc(storeMember.userId))
  // Recortado como lo guarda el acuerdo: así se compara igual con lo último que se avisó.
  return {
    account: storeId,
    name: shop.name.trim(),
    members: members.map((one) => ({ userId: one.userId.trim(), role: one.role })),
  }
}

/**
 * Le avisa a la cuenta quién está en la tienda (ADR 0217), si cambió desde lo último que se le
 * avisó: al crearla, al entrar alguien, al cambiar un rol, al sacar a alguien y al cerrarse la
 * cuenta de alguien del equipo. Va el equipo entero, en la transacción del cambio. Con `force`,
 * aunque no haya cambiado.
 *
 * Dos cambios del mismo equipo a la vez se avisan uno después del otro: el candado de la tienda
 * se toma antes de leer el equipo y dura hasta el final de la transacción, y la hora del aviso es
 * la de la base ya con el candado. Así el que avisa después lee lo del otro y lleva la hora más
 * nueva, que es la que la cuenta guarda.
 */
export async function noteStoreTeam(tx: Db, storeId: string, force = false): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`equipo:${storeId}`}, 0))`)
  const [clock] = (await tx.execute(sql`select clock_timestamp() as at`)) as unknown as Array<{
    at: Date | string
  }>
  const now = new Date(clock?.at ?? Date.now())
  const data = await teamOf(tx, storeId)
  if (!data) return false
  if (!force) {
    const [last] = await tx
      .select({ payload: contractOutbox.payload })
      .from(contractOutbox)
      .where(and(eq(contractOutbox.storeId, storeId), eq(contractOutbox.type, "equipo.cambiado")))
      .orderBy(desc(contractOutbox.createdAt))
      .limit(1)
    if (last && sameTeam(last.payload.data, data)) return false
  }
  await enqueue(tx, storeId, { type: "equipo.cambiado", timestamp: now.toISOString(), data })
  return true
}

/** ¿Lo último que se avisó dice lo mismo? (jsonb no guarda el orden de las claves). */
function sameTeam(before: unknown, now: NonNullable<Awaited<ReturnType<typeof teamOf>>>): boolean {
  const said = before as { name?: unknown; members?: Array<{ userId?: unknown; role?: unknown }> }
  if (said?.name !== now.name || !Array.isArray(said.members)) return false
  if (said.members.length !== now.members.length) return false
  return now.members.every(
    (member, i) =>
      said.members?.[i]?.userId === member.userId && said.members[i]?.role === member.role,
  )
}

/**
 * Revisa el equipo de cada tienda contra lo último que se le avisó a la cuenta y avisa lo que
 * no coincide. Es la carga inicial (las tiendas de antes de este aviso) y lo que arregla un
 * aviso que dos cambios a la vez dejaron atrás. Corre en el trabajo del acuerdo, una vez por hora.
 */
export async function reviewStoreTeams(ownerDb: Db): Promise<number> {
  const stores = await ownerDb.select({ id: store.id }).from(store).orderBy(asc(store.id))
  let noted = 0
  for (const one of stores) {
    // eslint-disable-next-line no-await-in-loop
    if (await ownerDb.transaction((tx) => noteStoreTeam(tx, one.id))) noted++
  }
  return noted
}

/** El canal como lo nombra el acuerdo; uno que no nombra va sin canal. */
function usageChannel(channel: string): (typeof USAGE_CHANNELS)[number] | null {
  return (USAGE_CHANNELS as readonly string[]).includes(channel)
    ? (channel as (typeof USAGE_CHANNELS)[number])
    : null
}

/**
 * Lo que usó Sofi: una conversación atendida, que sube a «pedido» si tomó uno. Se cuenta una vez
 * por ventana de 24 horas desde que la atendió (la clave de la administración es la conversación
 * y el inicio de su ventana); la de prueba nunca. Va en la transacción de su efecto: la respuesta
 * de Sofi o el pedido.
 */
export async function countConversation(
  tx: Db,
  storeId: string,
  conversation: { id: string; channel: ConversationChannel | OrderChannel },
  outcome: "atendida" | "pedido",
  now = new Date(),
): Promise<void> {
  if (conversation.channel === "prueba") return
  const recent = await tx
    .select({ dedupe: contractOutbox.dedupe })
    .from(contractOutbox)
    .where(
      and(
        eq(contractOutbox.storeId, storeId),
        eq(contractOutbox.conversationId, conversation.id),
        gt(contractOutbox.createdAt, new Date(now.getTime() - CONVERSATION_WINDOW_MS)),
      ),
    )
  // La clave es «uso:<conversación>:<inicio de su ventana en ms>:<resultado>».
  const live = recent
    .map((row) => Number(row.dedupe?.split(":")[2]))
    .filter((start) => Number.isFinite(start) && start > now.getTime() - CONVERSATION_WINDOW_MS)
  // Atendida en una ventana que ya se contó: nada nuevo que avisar.
  if (outcome === "atendida" && live.length > 0) return
  const start = live.length > 0 ? Math.min(...live) : now.getTime()
  await enqueue(
    tx,
    storeId,
    {
      type: "uso.contado",
      timestamp: now.toISOString(),
      data: {
        account: storeId,
        kind: "conversacion",
        outcome,
        conversation: `${conversation.id}:${start}`,
        occurredAt: now.toISOString(),
        channel: usageChannel(conversation.channel),
      },
    },
    { dedupe: `uso:${conversation.id}:${start}:${outcome}`, conversationId: conversation.id },
  )
}

export const supportInput = z.object({
  kind: z.enum(SUPPORT_KINDS),
  question: z.string().trim().min(1, "Escribe tu pregunta").max(500, "Máximo 500 caracteres"),
  detail: z.string().trim().max(4000, "Máximo 4000 caracteres").optional(),
})

/**
 * «Pedir ayuda» desde cualquier pantalla (entrega 7, tablero 19): lo que pasó y, sin que la persona
 * lo escriba, la pantalla desde la que pregunta (su ruta dentro de la tienda).
 */
export const helpRequestInput = z.object({
  question: z.string().trim().min(1, "Cuéntanos qué pasó").max(500, "Máximo 500 caracteres"),
  screen: z
    .string()
    .trim()
    .max(200)
    .refine((path) => path.startsWith("/"), "La pantalla no se pudo leer")
    .optional(),
})

/**
 * Las preguntas de ayuda de la tienda que la administración todavía no devolvió en su estado: las
 * que no salieron y las que salieron después de su última respuesta (aún no están entre sus casos).
 * Con `userId`, solo las de esa persona. De la más nueva a la más vieja.
 */
async function pendingSupport(
  tx: Db,
  storeId: string,
  stateAt: Date | null = null,
  userId?: string,
) {
  const rows = await tx
    .select({
      payload: contractOutbox.payload,
      createdAt: contractOutbox.createdAt,
      sentAt: contractOutbox.sentAt,
    })
    .from(contractOutbox)
    .where(
      and(
        eq(contractOutbox.storeId, storeId),
        eq(contractOutbox.type, "soporte.pedido"),
        stateAt
          ? or(isNull(contractOutbox.sentAt), gt(contractOutbox.sentAt, stateAt))
          : isNull(contractOutbox.sentAt),
        userId ? sql`${contractOutbox.payload} -> 'data' ->> 'userId' = ${userId}` : undefined,
      ),
    )
    .orderBy(desc(contractOutbox.createdAt))
  return rows.map((row) => ({
    question: String((row.payload.data as { question?: unknown }).question ?? ""),
    createdAt: row.createdAt,
    sent: row.sentAt !== null,
  }))
}

/**
 * Deja la pregunta en la bandeja de salida, a nombre de quien pregunta, con su rol y su pantalla
 * (ADR 0221). Sin el acuerdo configurado no se acepta: la pregunta no saldría y nadie la
 * respondería.
 */
async function enqueueSupport(
  tx: Db,
  config: ContractConfig,
  person: Person,
  storeId: string,
  seat: StoreSeat,
  input: z.infer<typeof supportInput> & { screen?: string },
  now: Date,
): Promise<void> {
  if (!config.secret)
    throw new StoreError(409, "NOT_CONNECTED", "Todavía no podemos recibir preguntas desde aquí.")
  if ((await pendingSupport(tx, storeId)).length >= MAX_PENDING_SUPPORT)
    throw new StoreError(
      429,
      "TOO_MANY",
      "Las preguntas anteriores de la tienda todavía no salen. Espera unos minutos y vuelve a enviar.",
    )
  await enqueue(tx, storeId, {
    type: "soporte.pedido",
    timestamp: now.toISOString(),
    data: {
      account: storeId,
      userId: person.userId,
      kind: input.kind,
      question: input.question,
      detail: input.detail || null,
      screen: input.screen || null,
      role: ROLE_NAMES[seat],
    },
  })
}

/**
 * Pide ayuda desde «Plan y pagos»: sobre el plan, un cobro o algo que no funciona. Solo el Dueño
 * (el plan).
 */
export async function askSupport(
  appDb: Db,
  config: ContractConfig,
  person: Person,
  storeId: string,
  input: z.infer<typeof supportInput>,
  now = new Date(),
): Promise<void> {
  await inStore(appDb, person, storeId, "plan", (tx, seat) =>
    enqueueSupport(tx, config, person, storeId, seat, { ...input, screen: "/plan" }, now),
  )
}

/**
 * «Pedir ayuda» de la Ayuda y de la cabecera: cualquier rol del equipo (`ayuda.pedir`; decisión 6
 * del lienzo «gestorIA como odentIA»). Llega a la Bandeja de la administración como las preguntas
 * de las clínicas, y la respuesta vuelve a quien preguntó (`helpView`).
 */
export async function askForHelp(
  appDb: Db,
  config: ContractConfig,
  person: Person,
  storeId: string,
  input: z.infer<typeof helpRequestInput>,
  now = new Date(),
): Promise<void> {
  await inStore(appDb, person, storeId, "ayuda.pedir", (tx, seat) =>
    enqueueSupport(tx, config, person, storeId, seat, { kind: "pregunta", ...input }, now),
  )
}

/**
 * La Ayuda de quien la abre: la guía para su rol y, si puede pedir ayuda, sus preguntas con las
 * respuestas del equipo de gestorIA. Solo las suyas: las de otra persona de la tienda (y lo del
 * plan, que es del Dueño) no se le muestran (ADR 0221). Las respuestas son las de lo último que
 * dijo la administración, que se pregunta cada 10 minutos: abrir la Ayuda no la espera.
 */
export async function helpView(appDb: Db, config: ContractConfig, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "tienda.ver", async (tx, seat) => {
    const canAsk = can(seat, "ayuda.pedir")
    const { row, state } = canAsk ? await knownStateIn(tx, storeId) : { row: null, state: null }
    const pending = canAsk
      ? await pendingSupport(tx, storeId, row?.receivedAt ?? null, person.userId)
      : []
    const cases = state?.found ? state.support.filter((kase) => kase.userId === person.userId) : []
    return {
      role: ROLE_NAMES[seat],
      canAsk,
      connected: Boolean(config.secret),
      guide: helpGuideFor(seat),
      questions: [
        ...pending.map((one) => ({
          id: null,
          question: one.question,
          createdAt: one.createdAt.toISOString(),
          status: one.sent ? ("enviada" as const) : ("por_enviar" as const),
          replies: [] as { body: string; at: string }[],
        })),
        ...cases.map((kase) => ({
          id: kase.id,
          question: kase.question,
          createdAt: kase.createdAt,
          status: kase.status,
          replies: kase.replies,
        })),
      ],
    }
  })
}

export const planReceiptInput = z.object({
  chargeId: z.string().trim().min(1, "Elige el cobro").max(200),
  amountCents: z
    .number({ error: "Escribe cuánto pagaste" })
    .int("Escribe cuánto pagaste")
    .positive("Escribe cuánto pagaste"),
  methodCode: z.string().trim().min(1, "Elige cómo pagaste").max(80),
  note: z.string().trim().max(500, "Máximo 500 caracteres").optional(),
})

/** El tipo del archivo por su contenido, nunca por su nombre: una foto o un PDF. */
function receiptType(bytes: Uint8Array): (typeof CONTRACT_RECEIPT_TYPES)[number] | null {
  const photo = imageType(bytes)
  if (photo) return photo
  // Un PDF empieza con «%PDF-».
  const head = Buffer.from(bytes.subarray(0, 5)).toString("latin1")
  return head === "%PDF-" ? "application/pdf" : null
}

/**
 * Los comprobantes que la administración todavía no muestra entre sus pagos: los que no salieron,
 * los rechazados y los que salieron después de su última respuesta. Del más nuevo al más viejo.
 */
async function pendingReceipts(tx: Db, storeId: string, stateAt: Date | null = null) {
  const rows = await tx
    .select({
      id: contractOutbox.id,
      // Solo lo que se muestra: el archivo en base64 no se lee.
      chargeId: sql<string>`${contractOutbox.payload} -> 'data' ->> 'chargeId'`,
      amountCents: sql<string>`${contractOutbox.payload} -> 'data' ->> 'amountCents'`,
      createdAt: contractOutbox.createdAt,
      sentAt: contractOutbox.sentAt,
      rejectedAt: contractOutbox.rejectedAt,
      lastError: contractOutbox.lastError,
    })
    .from(contractOutbox)
    .where(
      and(
        eq(contractOutbox.storeId, storeId),
        eq(contractOutbox.type, "pago.comprobante"),
        stateAt
          ? or(isNull(contractOutbox.sentAt), gt(contractOutbox.sentAt, stateAt))
          : isNull(contractOutbox.sentAt),
      ),
    )
    .orderBy(desc(contractOutbox.createdAt))
    .limit(20)
  return rows.map((row) => {
    return {
      id: row.id,
      chargeId: String(row.chargeId ?? ""),
      amountCents: Number(row.amountCents ?? 0),
      createdAt: row.createdAt,
      status: row.rejectedAt
        ? ("rechazado" as const)
        : row.sentAt
          ? ("enviado" as const)
          : ("por_enviar" as const),
      /** Por qué la administración no lo aceptó, con sus palabras (solo si lo rechazó). */
      reason: row.rejectedAt ? row.lastError : null,
    }
  })
}

/**
 * El Dueño sube el comprobante de un cargo («Plan y pagos»): sale a la administración por el
 * acuerdo y allá queda por confirmar, como el de una clínica. El archivo se mira por su contenido
 * (foto o PDF) y su tamaño, nunca por su nombre; la administración lo vuelve a mirar. El cargo y
 * el medio de pago son los de lo último que dijo la administración. Uno por cargo mientras no sale.
 */
export async function sendReceipt(
  appDb: Db,
  config: ContractConfig,
  person: Person,
  storeId: string,
  input: z.infer<typeof planReceiptInput>,
  file: Uint8Array | null,
  now = new Date(),
): Promise<void> {
  await inStore(appDb, person, storeId, "plan", async (tx) => {
    if (!config.secret)
      throw new StoreError(
        409,
        "NOT_CONNECTED",
        "Todavía no podemos recibir comprobantes desde aquí.",
      )
    if (!file || file.byteLength === 0)
      throw new StoreError(400, "VALIDATION_ERROR", "Sube la foto o el PDF del comprobante", {
        file: "Sube la foto o el PDF del comprobante",
      })
    if (file.byteLength > CONTRACT_MAX_RECEIPT_BYTES)
      throw new StoreError(400, "FILE_TOO_LARGE", "El archivo pesa demasiado: hasta 1,5 MB", {
        file: "El archivo pesa demasiado: hasta 1,5 MB",
      })
    const contentType = receiptType(file)
    if (!contentType)
      throw new StoreError(400, "FILE_TYPE", "Sube el comprobante en JPG, PNG, WebP o PDF", {
        file: "Sube el comprobante en JPG, PNG, WebP o PDF",
      })
    const { state } = await knownStateIn(tx, storeId)
    const charge = state?.charges.find((one) => one.id === input.chargeId)
    if (!charge || charge.paidCents >= charge.amountCents || charge.status === "anulada")
      throw new StoreError(409, "CHARGE", "Ese cobro ya no está por pagar", {
        chargeId: "Ese cobro ya no está por pagar",
      })
    if (input.amountCents > charge.amountCents - charge.paidCents)
      throw new StoreError(400, "AMOUNT", "Es más de lo que falta pagar de ese cobro", {
        amountCents: "Es más de lo que falta pagar de ese cobro",
      })
    if (!state?.paymentMethods.some((method) => method.code === input.methodCode))
      throw new StoreError(400, "METHOD", "Elige cómo pagaste", {
        methodCode: "Elige cómo pagaste",
      })
    const waiting = (await pendingReceipts(tx, storeId)).some(
      (one) => one.chargeId === input.chargeId && one.status === "por_enviar",
    )
    if (waiting)
      throw new StoreError(
        409,
        "RECEIPT_PENDING",
        "Ya subiste un comprobante de ese cobro: espera a que salga.",
      )
    await enqueue(tx, storeId, {
      type: "pago.comprobante",
      timestamp: now.toISOString(),
      data: {
        account: storeId,
        userId: person.userId,
        chargeId: input.chargeId,
        amountCents: input.amountCents,
        methodCode: input.methodCode,
        file: { contentType, base64: Buffer.from(file).toString("base64") },
        note: input.note || null,
      },
    })
  })
}

/**
 * Borra de la bandeja lo que salió o se rechazó hace más del plazo (la administración ya lo tiene;
 * el Dueño ya vio por qué no se aceptó), menos el último aviso de que se abrió cada tienda y el
 * último de su equipo: con ellos se sabe si cambió algo que avisar. Lo que no salió no se toca.
 */
export async function purgeOutbox(ownerDb: Db, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - OUTBOX_KEEP_MS)
  const removed = await ownerDb
    .delete(contractOutbox)
    .where(
      and(
        or(lt(contractOutbox.sentAt, before), lt(contractOutbox.rejectedAt, before)),
        sql`(${contractOutbox.type} not in ('cuenta.abierta', 'equipo.cambiado') or exists (
          select 1 from contract_outbox later
          where later.store_id = ${contractOutbox.storeId}
            and later.type = ${contractOutbox.type}
            and (later.created_at, later.id) > (${contractOutbox.createdAt}, ${contractOutbox.id})
        ))`,
      ),
    )
    .returning({ id: contractOutbox.id })
  return removed.length
}

/* ---------- El envío ---------- */

export interface DeliveryRun {
  sent: number
  failed: number
}

function retryDelay(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0), RETRY_MAX_MS)
}

/** Un mensaje firmado a la administración, con la clave que se le da. */
function postSigned(
  config: ContractConfig,
  path: string,
  id: string,
  body: string,
  timeoutMs = TIMEOUT_MS,
): Promise<Response> {
  return (config.fetch ?? fetch)(new URL(path, config.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signMessage({ secret: config.secret, id, body }),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "manual",
  })
}

/**
 * Envía lo que espera en la bandeja de salida, del más viejo al más nuevo, firmado con la clave
 * de cada aviso. Lo que no llegó (la administración no respondió o lo rechazó) queda para más
 * tarde con la misma clave; nunca se descarta. Si no llegó el aviso de que se abrió una tienda,
 * lo demás de esa tienda espera a la vuelta siguiente: la administración aún no la conoce. Si la
 * administración no responde o está caída (5xx, 429), la vuelta termina ahí: no se espera aviso
 * por aviso. Corre en un solo proceso a la vez (quien llama toma el candado).
 */
export async function deliverOutbox(
  ownerDb: Db,
  config: ContractConfig,
  now = new Date(),
): Promise<DeliveryRun> {
  const run = { sent: 0, failed: 0 }
  if (!config.secret) return run
  // Sin el cuerpo: un comprobante pesa; se lee uno por uno al enviarlo.
  const due = await ownerDb
    .select({
      id: contractOutbox.id,
      storeId: contractOutbox.storeId,
      type: contractOutbox.type,
      attempts: contractOutbox.attempts,
    })
    .from(contractOutbox)
    .where(
      and(
        isNull(contractOutbox.sentAt),
        isNull(contractOutbox.rejectedAt),
        lte(contractOutbox.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(contractOutbox.createdAt))
    .limit(100)
  // Una tienda cuyo aviso de que se abrió espera su reintento: lo demás suyo espera con él.
  const opening = await ownerDb
    .select({ storeId: contractOutbox.storeId })
    .from(contractOutbox)
    .where(
      and(
        eq(contractOutbox.type, "cuenta.abierta"),
        isNull(contractOutbox.sentAt),
        gt(contractOutbox.nextAttemptAt, now),
      ),
    )
  const waiting = new Set(opening.map((row) => row.storeId))
  for (const row of due) {
    // El equipo es para la cuenta, no para la cuenta de cobro: no espera a que se abra.
    if (waiting.has(row.storeId) && row.type !== "equipo.cambiado") continue
    // eslint-disable-next-line no-await-in-loop
    const [full] = await ownerDb
      .select({ payload: contractOutbox.payload })
      .from(contractOutbox)
      .where(eq(contractOutbox.id, row.id))
    if (!full) continue
    let problem: string | null = null
    let down = false
    let rejected = false
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await postSigned(
        config,
        CONTRACT_PATHS.events,
        row.id,
        JSON.stringify(full.payload),
      )
      if (!response.ok) {
        problem = `La administración respondió ${response.status}`
        down = response.status >= 500 || response.status === 429
        // Un comprobante que la administración no acepta por lo que dice (el cobro ya está pagado,
        // es más de lo que falta, el archivo no es lo que dice) no se reintenta: repetirlo no lo
        // arregla. El Dueño ve por qué, con las palabras de la administración.
        if (
          row.type === "pago.comprobante" &&
          (response.status === 400 || response.status === 409)
        ) {
          rejected = true
          // eslint-disable-next-line no-await-in-loop
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: unknown }
          } | null
          const said = body?.error?.message
          if (typeof said === "string" && said.trim()) problem = said.trim().slice(0, 300)
        }
      }
    } catch {
      problem = "La administración no respondió"
      down = true
    }
    const attempts = row.attempts + 1
    // Lo que ya salió (o no se aceptó) no guarda el archivo: la administración ya lo tiene.
    const withoutFile = sql`${contractOutbox.payload} #- '{data,file}'`
    // eslint-disable-next-line no-await-in-loop
    await ownerDb
      .update(contractOutbox)
      .set(
        rejected
          ? { attempts, lastError: problem, rejectedAt: now, payload: withoutFile }
          : problem
            ? {
                attempts,
                lastError: problem,
                nextAttemptAt: new Date(now.getTime() + retryDelay(attempts)),
              }
            : { attempts, lastError: null, sentAt: now, payload: withoutFile },
      )
      .where(eq(contractOutbox.id, row.id))
    if (!problem) {
      run.sent++
      continue
    }
    run.failed++
    if (down) break
    if (row.type === "cuenta.abierta") waiting.add(row.storeId)
  }
  return run
}

/* ---------- Lo que se pregunta ---------- */

/** Guarda lo que respondió la administración de una tienda (también la demo). */
export async function saveState(
  tx: Db,
  storeId: string,
  state: AccountState,
  now: Date,
): Promise<void> {
  const values = { state, receivedAt: now, triedAt: now, lastError: null }
  await tx
    .insert(contractState)
    .values({ storeId, ...values })
    .onConflictDoUpdate({ target: contractState.storeId, set: values })
}

/**
 * Pregunta a la administración el estado de una tienda y guarda lo que responda. «caida» si no
 * respondió o está caída (5xx, 429); «fallo» si respondió mal solo por esta tienda.
 */
async function askState(
  ownerDb: Db,
  config: ContractConfig,
  storeId: string,
  now: Date,
  timeoutMs = TIMEOUT_MS,
): Promise<"ok" | "fallo" | "caida"> {
  let state: AccountState
  let down = true
  try {
    const body = JSON.stringify({ account: storeId })
    const response = await postSigned(
      config,
      CONTRACT_PATHS.state,
      `st_${randomUUID()}`,
      body,
      timeoutMs,
    )
    down = response.status >= 500 || response.status === 429
    if (!response.ok) throw new Error(`La administración respondió ${response.status}`)
    state = accountState.parse(await response.json())
    if (state.account !== storeId) throw new Error("La administración respondió por otra cuenta")
  } catch (error) {
    // Lo último que se supo se queda: solo se anota que esta vez no respondió.
    const lastError =
      error instanceof Error && error.message.startsWith("La administración")
        ? error.message
        : "La administración no respondió"
    await ownerDb
      .insert(contractState)
      .values({ storeId, triedAt: now, lastError })
      .onConflictDoUpdate({ target: contractState.storeId, set: { triedAt: now, lastError } })
    return down ? "caida" : "fallo"
  }
  await ownerDb.transaction(async (tx) => {
    await saveState(tx, storeId, state, now)
    // No la conoce (una tienda de antes del acuerdo, o se perdió su aviso): se le avisa otra vez,
    // salvo que haya uno esperando a salir o se le haya avisado en el último día (no se repite
    // en cada vuelta si la administración sigue sin conocerla).
    if (!state.found) {
      const [recent] = await tx
        .select({ id: contractOutbox.id })
        .from(contractOutbox)
        .where(
          and(
            eq(contractOutbox.storeId, storeId),
            eq(contractOutbox.type, "cuenta.abierta"),
            or(
              isNull(contractOutbox.sentAt),
              gt(contractOutbox.createdAt, new Date(now.getTime() - REOPEN_EVERY_MS)),
            ),
          ),
        )
        .limit(1)
      if (!recent) await noteStoreAccount(tx, storeId, now, true)
    }
  })
  return "ok"
}

/**
 * Pregunta el estado de las tiendas a las que les toca (cada 10 minutos). Si la administración no
 * responde, cada una sigue con lo último que se supo y se deja para la vuelta siguiente. Un solo
 * proceso a la vez.
 */
export async function refreshStates(
  ownerDb: Db,
  config: ContractConfig,
  now = new Date(),
): Promise<number> {
  if (!config.secret) return 0
  const due = await ownerDb
    .select({ id: store.id })
    .from(store)
    .leftJoin(contractState, eq(contractState.storeId, store.id))
    .where(
      or(
        isNull(contractState.storeId),
        lt(contractState.triedAt, new Date(now.getTime() - STATE_EVERY_MS)),
      ),
    )
    .orderBy(sql`${contractState.triedAt} asc nulls first`)
    .limit(200)
  let asked = 0
  for (const row of due) {
    // eslint-disable-next-line no-await-in-loop
    const result = await askState(ownerDb, config, row.id, now)
    if (result === "caida") break
    if (result === "ok") asked++
  }
  return asked
}

/* ---------- Lo que se sabe ---------- */

/** Por qué Sofi no atiende, según lo último que dijo la administración. */
export type AgentStop = "sin_acceso" | "saldo_prueba" | "tope"

/**
 * Si Sofi debe detenerse: solo si la administración lo dijo. Sin respuesta nunca, o una cuenta
 * que la administración aún no conoce, Sofi sigue: la app no se detiene por la administración.
 */
export function agentStopOf(state: AccountState | null): AgentStop | null {
  if (!state?.found) return null
  if (state.access && !state.access.allowed) return "sin_acceso"
  if (state.agents?.trialExhausted) return "saldo_prueba"
  if (state.agents?.capReached) return "tope"
  return null
}

/** Lo último que se sabe de la tienda, dentro de su transacción (la persona o el agente). */
async function knownStateIn(tx: Db, storeId: string) {
  const [row] = await tx.select().from(contractState).where(eq(contractState.storeId, storeId))
  const parsed = accountState.safeParse(row?.state)
  return { row: row ?? null, state: parsed.success ? parsed.data : null }
}

/** Si Sofi (y Argos, que escribe como ella) debe detenerse en esta tienda. */
export async function agentStopIn(tx: Db, storeId: string): Promise<AgentStop | null> {
  return agentStopOf((await knownStateIn(tx, storeId)).state)
}

/**
 * «Plan y pagos» del Dueño: lo último que dijo la administración (su plan, cargos, pagos, avisos
 * y soporte), de cuándo es, y las preguntas de ayuda que aún no salen. Si lo último tiene más de
 * un minuto, pregunta otra vez (poco rato); si no responde, muestra lo último que se supo.
 */
export async function planView(
  appDb: Db,
  ownerDb: Db,
  config: ContractConfig,
  person: Person,
  storeId: string,
  now = new Date(),
) {
  const read = () =>
    inStore(appDb, person, storeId, "plan", async (tx) => {
      const { row, state } = await knownStateIn(tx, storeId)
      return {
        connected: Boolean(config.secret),
        state,
        receivedAt: row?.receivedAt ?? null,
        /** La última pregunta no tuvo respuesta: lo que se ve es lo último que se supo. */
        stale: Boolean(row?.lastError),
        agentStop: agentStopOf(state),
        pendingSupport: await pendingSupport(tx, storeId, row?.receivedAt ?? null),
        pendingReceipts: await pendingReceipts(tx, storeId, row?.receivedAt ?? null),
        triedAt: row?.triedAt ?? null,
      }
    })
  // Primero el permiso (`inStore`): quien no es Dueño no hace preguntar a la administración.
  const { triedAt, ...view } = await read()
  if (!config.secret || (triedAt && now.getTime() - triedAt.getTime() <= STATE_FRESH_MS))
    return view
  await askState(ownerDb, config, storeId, now, VIEW_TIMEOUT_MS)
  const { triedAt: _, ...fresh } = await read()
  return fresh
}
