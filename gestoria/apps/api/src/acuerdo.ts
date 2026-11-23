import { randomUUID } from "node:crypto"
import {
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
  CONTRACT_PATHS,
  SUPPORT_KINDS,
  USAGE_CHANNELS,
} from "@odentia/contract"
import { and, asc, desc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { signMessage } from "./firma.js"
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

/* ---------- Lo que se avisa ---------- */

/**
 * Guarda un aviso en la bandeja de salida, dentro de la transacción de lo que lo causó. Se
 * comprueba contra el acuerdo antes de guardarlo: lo que sale es lo que la administración lee.
 * Con `dedupe`, lo mismo no se guarda dos veces en la tienda.
 */
async function enqueue(
  tx: Db,
  storeId: string,
  event: AppEvent,
  extra: { dedupe?: string; conversationId?: string } = {},
): Promise<void> {
  const payload = appEvent.parse(event)
  await tx
    .insert(contractOutbox)
    .values({ storeId, type: payload.type, payload, ...extra })
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
 * Las preguntas de ayuda de la tienda que la administración todavía no devolvió en su estado: las
 * que no salieron y las que salieron después de su última respuesta (aún no están entre sus casos).
 * De la más nueva a la más vieja.
 */
async function pendingSupport(tx: Db, storeId: string, stateAt: Date | null = null) {
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
 * Pide ayuda a la administración, a nombre de quien pregunta. Solo el Dueño (el plan). Sin el
 * acuerdo configurado no se acepta: la pregunta no saldría y nadie la respondería.
 */
export async function askSupport(
  appDb: Db,
  config: ContractConfig,
  person: Person,
  storeId: string,
  input: z.infer<typeof supportInput>,
  now = new Date(),
): Promise<void> {
  await inStore(appDb, person, storeId, "plan", async (tx) => {
    if (!config.secret)
      throw new StoreError(409, "NOT_CONNECTED", "Todavía no podemos recibir preguntas desde aquí.")
    if ((await pendingSupport(tx, storeId)).length >= MAX_PENDING_SUPPORT)
      throw new StoreError(
        429,
        "TOO_MANY",
        "Tus preguntas anteriores todavía no salen. Espera a que salgan para escribir otra.",
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
      },
    })
  })
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
  const due = await ownerDb
    .select()
    .from(contractOutbox)
    .where(and(isNull(contractOutbox.sentAt), lte(contractOutbox.nextAttemptAt, now)))
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
    if (waiting.has(row.storeId)) continue
    let problem: string | null = null
    let down = false
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await postSigned(
        config,
        CONTRACT_PATHS.events,
        row.id,
        JSON.stringify(row.payload),
      )
      if (!response.ok) {
        problem = `La administración respondió ${response.status}`
        down = response.status >= 500 || response.status === 429
      }
    } catch {
      problem = "La administración no respondió"
      down = true
    }
    const attempts = row.attempts + 1
    // eslint-disable-next-line no-await-in-loop
    await ownerDb
      .update(contractOutbox)
      .set(
        problem
          ? {
              attempts,
              lastError: problem,
              nextAttemptAt: new Date(now.getTime() + retryDelay(attempts)),
            }
          : { attempts, lastError: null, sentAt: now },
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
